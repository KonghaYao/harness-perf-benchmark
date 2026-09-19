/**
 * 响应构造：把脚本里的一条完整非流式响应，
 * 原样交给 stream:false 的请求，或转换成 OpenAI 规范的 SSE chunk 序列。
 */

import type { ScriptResponse } from "./script";
import type { ChatCompletion, ChatCompletionChunk, Usage } from "./types";

export interface ResponseMeta {
    id: string;
    created: number;
    model: string;
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** 可被 AbortSignal 打断的等待；abort 后立即返回而不是抛错，由调用方检查终止。 */
export const realSleep: SleepFn = (ms, signal) => {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(onAbort, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
};

/** CJK 字符（含中日韩标点与全角形式）按 1 token/字计。 */
const CJK_PATTERN =
    /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu;

/**
 * 粗略 token 估算：CJK 按字计，其余按 4 字符 1 token 向上取整。
 *
 * 真实 tokenizer 依赖词表与外部分词，这里只求量级接近；
 * 要精确值就在脚本条目里写 usage，脚本声明优先于估算。
 */
export function estimateTokens(value: unknown): number {
    let cjk = 0;
    let other = 0;

    const visit = (node: unknown): void => {
        if (typeof node === "string") {
            const hits = node.match(CJK_PATTERN)?.length ?? 0;
            cjk += hits;
            other += Array.from(node).length - hits;
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) visit(item);
            return;
        }
        if (typeof node === "object" && node !== null) {
            for (const item of Object.values(node)) visit(item);
        }
    };

    visit(value);
    return cjk + Math.ceil(other / 4);
}

/**
 * 从 chat 请求的 messages 里取出参与 prompt 计费的部分：
 * 只保留 content 与 tool_calls，role 等结构字段在真实 tokenizer 里是特殊 token。
 */
export function messagesValue(messages: unknown): unknown {
    if (!Array.isArray(messages)) return messages;
    return messages.map((message) =>
        typeof message === "object" && message !== null && !Array.isArray(message)
            ? [(message as Record<string, unknown>).content, (message as Record<string, unknown>).tool_calls]
            : message,
    );
}

/** 脚本声明的 usage 优先；未声明时按 prompt 与本次 message 估算。 */
export function resolveUsage(response: ScriptResponse, prompt: unknown): Usage {
    if (response.usage) return { ...response.usage };
    const promptTokens = estimateTokens(prompt);
    const completionTokens =
        estimateTokens(response.message.content) +
        // 只算函数名与参数：tool_call 的 id 与 type 是协议结构，不计入。
        estimateTokens(
            (response.message.tool_calls ?? []).map((call) => [
                call.function.name,
                call.function.arguments,
            ]),
        );
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
    };
}

/** 按 grapheme 切分，避免把 emoji / 组合字符拆坏。 */
export function splitGraphemes(text: string, size: number): string[] {
    if (text === "") return [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const units = Array.from(segmenter.segment(text), (unit) => unit.segment);
    if (size <= 1) return units;
    const pieces: string[] = [];
    for (let i = 0; i < units.length; i += size) {
        pieces.push(units.slice(i, i + size).join(""));
    }
    return pieces;
}

export function toCompletion(
    response: ScriptResponse,
    meta: ResponseMeta,
    prompt: unknown,
): ChatCompletion {
    return {
        id: meta.id,
        object: "chat.completion",
        created: meta.created,
        model: meta.model,
        choices: [
            {
                index: 0,
                message: response.message,
                finish_reason: response.finishReason,
                logprobs: null,
            },
        ],
        usage: resolveUsage(response, prompt),
    };
}

/**
 * SSE chunk 序列，对齐 OpenAI 的实际行为：
 *   1. 首个 chunk 带 role、content 为空字符串
 *   2. content 按 chunkSize 分片
 *   3. tool_calls 首个分片带 id / name 与空 arguments，后续只补 arguments 片段
 *   4. 末个 chunk 的 delta 为空、带 finish_reason
 *   5. 仅当 stream_options.include_usage 时追加一个 choices 为空的 usage chunk
 */
export async function* streamChunks(
    response: ScriptResponse,
    meta: ResponseMeta,
    options: { includeUsage: boolean; sleep: SleepFn; signal?: AbortSignal; prompt?: unknown },
): AsyncGenerator<ChatCompletionChunk> {
    const { sleep, signal } = options;
    const base = {
        id: meta.id,
        object: "chat.completion.chunk" as const,
        created: meta.created,
        model: meta.model,
    };
    const delta = (value: ChatCompletionChunk["choices"][number]["delta"]) => ({
        ...base,
        choices: [{ index: 0, delta: value, finish_reason: null }],
    });

    // 首包前的"思考"耗时（模拟 TTFT）。
    await sleep(response.delayMs, signal);
    if (signal?.aborted) return;

    yield delta({ role: "assistant", content: "" });

    const content = response.message.content;
    if (content) {
        for (const piece of splitGraphemes(content, response.chunkSize)) {
            await sleep(response.chunkDelayMs, signal);
            if (signal?.aborted) return;
            yield delta({ content: piece });
        }
    }

    for (const [index, call] of (response.message.tool_calls ?? []).entries()) {
        await sleep(response.chunkDelayMs, signal);
        if (signal?.aborted) return;
        yield delta({
            tool_calls: [
                {
                    index,
                    id: call.id,
                    type: "function",
                    function: { name: call.function.name, arguments: "" },
                },
            ],
        });
        for (const piece of splitGraphemes(call.function.arguments, response.chunkSize)) {
            await sleep(response.chunkDelayMs, signal);
            if (signal?.aborted) return;
            yield delta({ tool_calls: [{ index, function: { arguments: piece } }] });
        }
    }

    yield {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: response.finishReason }],
    };

    if (options.includeUsage) {
        yield { ...base, choices: [], usage: resolveUsage(response, options.prompt) };
    }
}
