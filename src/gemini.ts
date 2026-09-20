/**
 * Google Gemini API 协议适配（Antigravity CLI 的 `agy` 走的就是它）。
 *
 * agy 1.2.7 实测请求（`agy -p … --dangerously-skip-permissions`，配 GEMINI_API_KEY 模式）：
 *   POST /v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse
 *   请求头带 `x-goog-api-key`；UA 是 google-genai-sdk/1.71.0（Go SDK）。
 *   顶层键：contents, generationConfig, systemInstruction, tools。
 *
 * 与另外三个协议最不显然的三处差别：
 *
 * 1. **流式与否写在路径上**：`:streamGenerateContent` 与 `:generateContent` 是两个端点，
 *    请求体里没有任何 stream 标志，模型名也在路径里（`body.model` 不存在）。
 *    所以 isStream / describe 多吃一个 path，响应里的 modelVersion 也从 path 取。
 * 2. **工具结果回传成 `role:"model"`**：不是 `tool` 也不是 `user`，而是继续沿用 model 角色、
 *    parts 里放 `functionResponse`；靠 `functionCall.id` 与调用配对——**mock 发出的
 *    functionCall 必须带 id**，缺了客户端配不上（OpenAI/Anthropic 那边 id 只是标识，
 *    这里是配对键）。
 * 3. **工具声明用 `parametersJsonSchema`**（JSON Schema 2020-12 原样透传），
 *    不是 Gemini 早期的 `parameters`（那是 OpenAPI 子集，enum 形状也不一样）。
 *    这与本适配器无关——我们只回调用，不回声明——但读 mock.log 时容易看错。
 *
 * 协议中立条目 → Gemini：
 *   message.content → parts: [{ text }]
 *   tool_calls      → parts: [{ functionCall: { name, args, id } }]（args 是对象，不是 JSON 串）
 *   finish_reason   → finishReason 枚举（"tool_calls" 也是 STOP：Gemini 不把函数调用当终止原因）
 *   节奏 delayMs / chunkDelayMs / chunkSize 与 src/stream.ts 的 streamChunks 完全一致。
 *
 * 函数调用的参数**不分片**（真实 API 把一个 functionCall 整块发出来），
 * 所以 chunkSize 只作用于文本。
 */

import type { FrameOptions, ProtocolAdapter, RequestContext, StreamFrame } from "./protocol";
import type { ScriptResponse } from "./script";
import { resolveUsage, splitGraphemes, type ResponseMeta } from "./stream";

/** 模型侧的一个 part：mock 只产出文本与函数调用两种。 */
export type GeminiPart =
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown>; id: string } };

/** Gemini 的 candidates[].finishReason 枚举；mock 只用到这三个。 */
export type GeminiFinishReason = "STOP" | "MAX_TOKENS" | "SAFETY";

export interface GeminiCandidate {
    content: { role: "model"; parts: GeminiPart[] };
    finishReason?: GeminiFinishReason;
    index: 0;
}

export interface GeminiUsageMetadata {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
}

/** 非流式 GenerateContentResponse；流式的每一帧也是这个形状（字段可选）。 */
export interface GenerateContentResponse {
    candidates: GeminiCandidate[];
    usageMetadata: GeminiUsageMetadata;
    modelVersion: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function squash(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * 从请求路径里取模型名：
 *   /v1beta/models/gemini-3.1-pro-preview:streamGenerateContent → gemini-3.1-pro-preview
 * 动作是模型名后的 `:action` 后缀（generateContent / streamGenerateContent / countTokens …），
 * 模型名本身不含 `:` 或 `/`。
 */
export function modelFromPath(path: string): string | null {
    const match = /\/models\/([^/:]+)(?::[^/]*)?/.exec(path);
    return match?.[1] ?? null;
}

/**
 * 脚本里 tool_call 的 arguments 是字符串（OpenAI 形状），Gemini 的 functionCall.args 必须是对象：
 * 正常路径就是 JSON.parse；**非法 JSON 时容错为 `{}`**——手写脚本难免写坏参数，
 * 让模型照常把这轮工具调用发出去（工具自己会报参数错）比整条响应 500 更接近真实链路。
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

/** 脚本条目 → parts：文本块在前，函数调用按脚本顺序跟在后面。 */
export function partsOf(entry: ScriptResponse): GeminiPart[] {
    const parts: GeminiPart[] = [];
    const text = entry.message.content;
    if (text !== null && text !== "") parts.push({ text });
    for (const call of entry.message.tool_calls ?? []) {
        parts.push({
            functionCall: {
                name: call.function.name,
                args: parseArguments(call.function.arguments),
                id: call.id,
            },
        });
    }
    return parts;
}

/**
 * finish_reason → Gemini 枚举。
 * 函数调用同样是 STOP——Gemini 没有对应的终止原因，调用与不调用的收尾长得一样，
 * 客户端靠 parts 里有没有 functionCall 判断该不该继续。
 */
export function finishReason(entry: ScriptResponse): GeminiFinishReason {
    switch (entry.finishReason) {
        case "length":
            return "MAX_TOKENS";
        case "content_filter":
            return "SAFETY";
        default:
            return "STOP";
    }
}

/** usage 换算：脚本声明优先，否则按 prompt 与内容估算（字段名与 OpenAI 不同）。 */
function usageMetadata(entry: ScriptResponse, prompt: unknown): GeminiUsageMetadata {
    const usage = resolveUsage(entry, prompt);
    return {
        promptTokenCount: usage.prompt_tokens,
        candidatesTokenCount: usage.completion_tokens,
        totalTokenCount: usage.total_tokens,
    };
}

/** 非流式响应体。 */
export function toGenerateContent(
    entry: ScriptResponse,
    meta: ResponseMeta,
    ctx: RequestContext,
): GenerateContentResponse {
    return {
        candidates: [
            {
                content: { role: "model", parts: partsOf(entry) },
                finishReason: finishReason(entry),
                index: 0,
            },
        ],
        usageMetadata: usageMetadata(entry, ctx.prompt),
        modelVersion: modelFromPath(ctx.path) ?? meta.model,
    };
}

/**
 * Gemini SSE 帧序列；没有 `event:` 行，也没有 `data: [DONE]` 收尾——每帧都是一份完整的
 * GenerateContentResponse 片段，最后靠带 finishReason 的那帧收口：
 *
 *   {candidates:[{content:{role:"model",parts:[{text:"…"}]},index:0}]}      每片一次
 *   {candidates:[{content:{role:"model",parts:[{functionCall:{…}}]},index:0}]}  每个调用一次
 *   {candidates:[{content:…,finishReason:"STOP",index:0}],usageMetadata}    收尾
 *
 * usageMetadata 与真实 API 一样只出现在收尾帧。
 */
export async function* generateContentFrames(
    entry: ScriptResponse,
    meta: ResponseMeta,
    options: FrameOptions,
): AsyncGenerator<StreamFrame> {
    const { sleep, signal } = options;
    const modelVersion = modelFromPath(options.path) ?? meta.model;
    const chunk = (parts: GeminiPart[], finish?: GeminiFinishReason): StreamFrame => ({
        data: {
            candidates: [
                {
                    content: { role: "model", parts },
                    ...(finish === undefined ? {} : { finishReason: finish }),
                    index: 0,
                },
            ],
            modelVersion,
        } satisfies GenerateContentResponse | Record<string, unknown>,
    });

    // 首包前的"思考"耗时（模拟 TTFT）。
    await sleep(entry.delayMs, signal);
    if (signal?.aborted) return;

    const text = entry.message.content;
    if (text !== null && text !== "") {
        for (const piece of splitGraphemes(text, entry.chunkSize)) {
            await sleep(entry.chunkDelayMs, signal);
            if (signal?.aborted) return;
            yield chunk([{ text: piece }]);
        }
    }

    for (const part of partsOf(entry)) {
        if (!("functionCall" in part)) continue;
        await sleep(entry.chunkDelayMs, signal);
        if (signal?.aborted) return;
        yield chunk([part]);
    }

    yield {
        data: {
            candidates: [
                {
                    content: { role: "model", parts: [] },
                    finishReason: finishReason(entry),
                    index: 0,
                },
            ],
            usageMetadata: usageMetadata(entry, options.prompt),
            modelVersion,
        },
    };
}

export const gemini: ProtocolAdapter = {
    name: "gemini",

    /**
     * 一行访问日志：模型与动作都在路径上（请求体里没有 model），
     * 正文预览取最后一条 content 的文本（Gemini 的 contents 是 [{role, parts}]）。
     */
    describe(body: Record<string, unknown>, path = ""): string {
        const streaming = path.includes(":streamGenerateContent");
        const parts = [
            streaming ? "streamGenerateContent" : "generateContent",
            `model=${modelFromPath(path) ?? "-"}`,
        ];
        const contents = body.contents;
        if (Array.isArray(contents)) {
            parts.push(`contents=${contents.length}`);
            const last = contents[contents.length - 1];
            if (isPlainObject(last)) {
                const role = typeof last.role === "string" ? last.role : "?";
                const preview = previewParts(last.parts);
                parts.push(`last=${role}${preview === "" ? "" : `:"${preview}"`}`);
            }
        }
        const tools = body.tools;
        parts.push(
            `tools=${
                Array.isArray(tools)
                    ? tools.reduce(
                          (count, tool) =>
                              count +
                              (isPlainObject(tool) && Array.isArray(tool.functionDeclarations)
                                  ? tool.functionDeclarations.length
                                  : 0),
                          0,
                      )
                    : 0
            }`,
        );
        return parts.join(" ");
    },

    isStream(_body: Record<string, unknown>, path = ""): boolean {
        return path.includes(":streamGenerateContent");
    },

    /** 参与 token 估算的输入：systemInstruction 文本 + contents（后者与 chat 的 messages 同口径）。 */
    promptValue(body: Record<string, unknown>): unknown {
        return { systemInstruction: body.systemInstruction, contents: body.contents };
    },

    body(entry: ScriptResponse, meta: ResponseMeta, ctx: RequestContext): unknown {
        return toGenerateContent(entry, meta, ctx);
    },

    frames(
        entry: ScriptResponse,
        meta: ResponseMeta,
        options: FrameOptions,
    ): AsyncGenerator<StreamFrame> {
        return generateContentFrames(entry, meta, options);
    },

    /** Gemini 的错误形状：{ error: { code, message, status } }，status 是 gRPC 风格的大写串。 */
    error(message: string, code: string): Record<string, unknown> {
        return { error: { code: 400, message, status: code } };
    },
};

/**
 * 最后一条 content 的正文预览：parts 是文本与 functionCall 混排，
 * 没有文本时退化成 part 类型清单（functionResponse 出现在工具结果那一轮）。
 */
function previewParts(parts: unknown): string {
    if (!Array.isArray(parts)) return "";
    const texts = parts
        .map((part) => (isPlainObject(part) && typeof part.text === "string" ? part.text : ""))
        .filter((text) => text !== "")
        .join(" ");
    if (texts !== "") return squash(texts).slice(0, 60);
    if (parts.length === 0) return "";
    const kinds = parts.map((part) => {
        if (!isPlainObject(part)) return "?";
        const key = ["text", "functionCall", "functionResponse", "inlineData"].find(
            (name) => part[name] !== undefined,
        );
        return key ?? "?";
    });
    return `[${kinds.length} parts: ${kinds.join("+")}]`;
}
