/**
 * 协议适配层。
 *
 * 脚本条目（src/script.ts 的 ScriptResponse）是**协议中立**的：role/content/tool_calls 加
 * 上节奏（delayMs/chunkDelayMs/chunkSize）。各家 harness 说不同的线协议，这里定义统一的
 * 「把一条脚本条目渲染成某个 API 形状」的接口：
 *
 *   src/stream.ts     OpenAI Chat Completions（/v1/chat/completions，历史实现）
 *   src/anthropic.ts  Anthropic Messages（/v1/messages，Claude Code）
 *   src/responses.ts  OpenAI Responses（/v1/responses，Codex）
 *
 * 新增协议只需实现本接口 + 在 src/app.ts 里挂一条路由，不必改动取号、日志与错误处理。
 */

import type { ScriptResponse } from "./script";
import type { ResponseMeta, SleepFn } from "./stream";

/** 一条 SSE 帧；`event` 缺省时只写 data 行（OpenAI chat 风格）。 */
export interface StreamFrame {
    event?: string;
    data: unknown;
}

/** 渲染一条响应时能拿到的请求侧信息。 */
export interface RequestContext {
    /** token 估算的输入，promptValue 的产物。 */
    prompt: unknown;
    /**
     * 原始请求体。多数适配器用不到，但有的协议要**按请求里声明的形状**渲染：
     * Responses 的工具声明（`additional_tools`）决定了工具调用该写成 custom_tool_call
     * 还是 function_call，只看脚本条目是分不出来的。
     */
    request: Record<string, unknown>;
}

/** 流式渲染需要的运行时依赖。 */
export interface FrameOptions extends RequestContext {
    sleep: SleepFn;
    signal?: AbortSignal;
}

/** 协议适配器。 */
export interface ProtocolAdapter {
    /** 协议名，用于访问日志与错误信息。 */
    readonly name: string;
    /** 请求摘要（谁在消费脚本）。 */
    describe(body: Record<string, unknown>): string;
    /** 该请求是否要求流式响应。 */
    isStream(body: Record<string, unknown>): boolean;
    /** 从请求体里取出参与 token 估算的 prompt 部分（只做投影，不夹带别的信息）。 */
    promptValue(body: Record<string, unknown>): unknown;
    /** 非流式响应体。 */
    body(entry: ScriptResponse, meta: ResponseMeta, ctx: RequestContext): unknown;
    /** 流式帧序列；节奏控制（首包延迟、分片大小与间隔）由实现负责。 */
    frames(
        entry: ScriptResponse,
        meta: ResponseMeta,
        options: FrameOptions,
    ): AsyncGenerator<StreamFrame>;
    /** 错误响应体：各家错误形状不同。 */
    error(message: string, code: string): Record<string, unknown>;
}

const encoder = new TextEncoder();

/** 编码一帧 SSE。 */
export function encodeFrame(frame: StreamFrame): Uint8Array {
    const head = frame.event === undefined ? "" : `event: ${frame.event}\n`;
    return encoder.encode(`${head}data: ${JSON.stringify(frame.data)}\n\n`);
}

/**
 * 把帧序列包成 SSE 响应流：客户端断开时中断生成器（上游 abort）。
 * 与 src/app.ts 里 chat 的 sseStream 同构，区别是不追加 `data: [DONE]`——
 * Anthropic 与 Responses 都以各自的终止事件收尾，没有 [DONE] 约定。
 */
export function streamResponse(
    frames: AsyncGenerator<StreamFrame>,
    signal?: AbortSignal,
): ReadableStream<Uint8Array> {
    const abort = new AbortController();
    if (signal?.aborted) abort.abort();
    else signal?.addEventListener("abort", () => abort.abort(), { once: true });

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const frame of frames) {
                    if (abort.signal.aborted) break;
                    controller.enqueue(encodeFrame(frame));
                }
                controller.close();
            } catch (error) {
                try {
                    controller.error(error);
                } catch {
                    // 客户端已断开、流已被取消：无需再报错。
                }
            }
        },
        cancel() {
            abort.abort();
            void frames.return(undefined);
        },
    });
}
