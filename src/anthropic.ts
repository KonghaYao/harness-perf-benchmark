/**
 * Anthropic Messages 协议适配（Claude Code 走的就是它）。
 *
 * Claude Code 发的请求：POST /v1/messages，`stream: true`；
 * 顶层键：model, messages, system（文本块数组）, tools, max_tokens, thinking, metadata 等。
 *
 * 脚本条目 → Messages 响应：
 *   content  → [{ type: "text", text }]
 *   tool_calls → [{ type: "tool_use", id, name, input }]（input 是 arguments 解析出的对象）
 *   finish_reason "tool_calls" → stop_reason "tool_use"，其余 → "end_turn"
 *
 * 流式与 OpenAI 那侧最大的差别是**每个事件都带事件名**（`event:` 行），
 * 且内容块要显式 start / delta / stop；节奏（delayMs / chunkDelayMs / chunkSize）
 * 与 src/stream.ts 的 streamChunks 完全一致。
 */

import type { FrameOptions, ProtocolAdapter, RequestContext, StreamFrame } from "./protocol";
import type { ScriptResponse } from "./script";
import { messagesValue, resolveUsage, splitGraphemes, type ResponseMeta } from "./stream";

/** Messages 响应的内容块（mock 只产出这两种）。 */
export type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** 非流式 Messages 响应。 */
export interface MessageResponse {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[];
    stop_reason: "tool_use" | "end_turn";
    stop_sequence: null;
    usage: { input_tokens: number; output_tokens: number };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function squash(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * 最后一个 message 的内容预览：Claude Code 的 content 是块数组
 * （文本块、tool_result 块混排），没有文本时退化成块类型清单，
 * 便于从日志看出当前轮到哪一步。
 */
function previewContent(content: unknown): string {
    if (typeof content === "string") return squash(content).slice(0, 60);
    if (!Array.isArray(content)) return "";
    const texts = content
        .map((block) => (isPlainObject(block) && typeof block.text === "string" ? block.text : ""))
        .filter((text) => text !== "")
        .join(" ");
    if (texts !== "") return squash(texts).slice(0, 60);
    if (content.length === 0) return "";
    const kinds = content.map((block) =>
        isPlainObject(block) && typeof block.type === "string" ? block.type : "?",
    );
    return `[${kinds.length} blocks: ${kinds.join("+")}]`;
}

/** system 是文本块数组；取 text 字段（丢掉 cache_control 这类协议结构）用于 token 估算。 */
function systemText(system: unknown): unknown {
    if (!Array.isArray(system)) return system;
    return system.map((block) => (isPlainObject(block) ? block.text : block));
}

function countSystem(system: unknown): number {
    if (Array.isArray(system)) return system.length;
    return system === undefined || system === null || system === "" ? 0 : 1;
}

/**
 * 脚本里 tool_call 的 arguments 是字符串（OpenAI 形状），Messages 的 tool_use.input 必须是对象：
 * 正常路径就是 JSON.parse；**非法 JSON 时容错为 `{}`**——手写脚本难免写坏参数，
 * 让模型照常把这轮工具调用发出去（工具自己会报参数错）比整条响应 500 更接近真实链路。
 * 解析结果不是对象（`"5"`、`[1]` 这类）同样退回 `{}`。
 */
function parseArguments(raw: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    return isPlainObject(parsed) ? parsed : {};
}

/** 脚本条目 → content 数组：文本块在前，tool_use 块按脚本顺序跟在后面。 */
export function contentBlocks(entry: ScriptResponse): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    const text = entry.message.content;
    if (text !== null && text !== "") blocks.push({ type: "text", text });
    for (const call of entry.message.tool_calls ?? []) {
        blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments),
        });
    }
    return blocks;
}

/** finish_reason → stop_reason：只有 tool_calls 会转成 tool_use，其余都当正常收尾。 */
function stopReason(entry: ScriptResponse): "tool_use" | "end_turn" {
    return entry.finishReason === "tool_calls" ? "tool_use" : "end_turn";
}

/** usage 换算：脚本声明优先，否则按 prompt 与内容估算（字段名与 OpenAI 不同）。 */
function tokenUsage(
    entry: ScriptResponse,
    prompt: unknown,
): { input_tokens: number; output_tokens: number } {
    const usage = resolveUsage(entry, prompt);
    return { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens };
}

/** 非流式 Messages 响应。 */
export function toMessage(
    entry: ScriptResponse,
    meta: ResponseMeta,
    prompt: unknown,
): MessageResponse {
    return {
        id: meta.id,
        type: "message",
        role: "assistant",
        model: meta.model,
        content: contentBlocks(entry),
        stop_reason: stopReason(entry),
        stop_sequence: null,
        usage: tokenUsage(entry, prompt),
    };
}

/** message_start 里的 message 骨架：content 为空，stop_reason 要到 message_delta 才出现。 */
function messageSkeleton(meta: ResponseMeta, inputTokens: number): Record<string, unknown> {
    return {
        id: meta.id,
        type: "message",
        role: "assistant",
        model: meta.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
    };
}

/**
 * Anthropic SSE 事件序列；节奏与 src/stream.ts 的 streamChunks 逐拍对齐
 * （首包前 delayMs，之后每个分片前 chunkDelayMs，每步检查 abort）：
 *
 *   message_start
 *   [content_block_start(text) → text_delta… → content_block_stop]        content 非空时
 *   [content_block_start(tool_use) → input_json_delta… → content_block_stop]  每个工具调用一组
 *   message_delta（stop_reason + output_tokens）
 *   message_stop
 *
 * 内容块 index 从 0 连续递增：有文本时文本占 0，工具调用依次往后排。
 */
export async function* messageFrames(
    entry: ScriptResponse,
    meta: ResponseMeta,
    options: FrameOptions,
): AsyncGenerator<StreamFrame> {
    const { sleep, signal } = options;
    const usage = tokenUsage(entry, options.prompt);

    // 首包前的"思考"耗时（模拟 TTFT）。
    await sleep(entry.delayMs, signal);
    if (signal?.aborted) return;

    yield {
        event: "message_start",
        data: {
            type: "message_start",
            message: messageSkeleton(meta, usage.input_tokens),
        },
    };

    let index = 0;
    const text = entry.message.content;
    if (text !== null && text !== "") {
        yield {
            event: "content_block_start",
            data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        };
        for (const piece of splitGraphemes(text, entry.chunkSize)) {
            await sleep(entry.chunkDelayMs, signal);
            if (signal?.aborted) return;
            yield {
                event: "content_block_delta",
                data: {
                    type: "content_block_delta",
                    index,
                    delta: { type: "text_delta", text: piece },
                },
            };
        }
        yield { event: "content_block_stop", data: { type: "content_block_stop", index } };
        index += 1;
    }

    for (const call of entry.message.tool_calls ?? []) {
        await sleep(entry.chunkDelayMs, signal);
        if (signal?.aborted) return;
        // input 先给空对象，参数由后续 input_json_delta 片段拼出来（与真实 API 一致）。
        yield {
            event: "content_block_start",
            data: {
                type: "content_block_start",
                index,
                content_block: {
                    type: "tool_use",
                    id: call.id,
                    name: call.function.name,
                    input: {},
                },
            },
        };
        for (const piece of splitGraphemes(call.function.arguments, entry.chunkSize)) {
            await sleep(entry.chunkDelayMs, signal);
            if (signal?.aborted) return;
            yield {
                event: "content_block_delta",
                data: {
                    type: "content_block_delta",
                    index,
                    delta: { type: "input_json_delta", partial_json: piece },
                },
            };
        }
        yield { event: "content_block_stop", data: { type: "content_block_stop", index } };
        index += 1;
    }

    yield {
        event: "message_delta",
        data: {
            type: "message_delta",
            delta: { stop_reason: stopReason(entry), stop_sequence: null },
            usage: { output_tokens: usage.output_tokens },
        },
    };
    yield { event: "message_stop", data: { type: "message_stop" } };
}

export const anthropic: ProtocolAdapter = {
    name: "anthropic-messages",

    /** 一行访问日志：与 app.ts 里 chat 的摘要同口径，另加 tools / system 数量。 */
    describe(body: Record<string, unknown>): string {
        const parts = [
            `stream=${body.stream === true}`,
            `model=${typeof body.model === "string" ? body.model : "-"}`,
        ];
        const messages = body.messages;
        if (Array.isArray(messages)) {
            parts.push(`messages=${messages.length}`);
            const last = messages[messages.length - 1];
            if (isPlainObject(last)) {
                const role = typeof last.role === "string" ? last.role : "?";
                const preview = previewContent(last.content);
                parts.push(`last=${role}${preview === "" ? "" : `:"${preview}"`}`);
            }
        }
        parts.push(`tools=${Array.isArray(body.tools) ? body.tools.length : 0}`);
        parts.push(`system=${countSystem(body.system)}`);
        return parts.join(" ");
    },

    // 与真实 Messages API 一致：stream 缺省为 false，要 SSE 必须显式传 true
    // （Claude Code 每次都带 stream:true；缺省成非流式也让手工 curl 的语义与线上一致）。
    isStream(body: Record<string, unknown>): boolean {
        return body.stream === true;
    },

    /** 参与 token 估算的输入：system 文本 + messages（后者与 chat 同口径）。 */
    promptValue(body: Record<string, unknown>): unknown {
        return { system: systemText(body.system), messages: messagesValue(body.messages) };
    },

    body(entry: ScriptResponse, meta: ResponseMeta, ctx: RequestContext): unknown {
        return toMessage(entry, meta, ctx.prompt);
    },

    frames(
        entry: ScriptResponse,
        meta: ResponseMeta,
        options: FrameOptions,
    ): AsyncGenerator<StreamFrame> {
        return messageFrames(entry, meta, options);
    },

    /** Anthropic 的错误形状：type 固定 "error"，具体错误类型在 error.type 里。 */
    error(message: string, code: string): Record<string, unknown> {
        return { type: "error", error: { type: code, message } };
    },
};
