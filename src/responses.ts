/**
 * OpenAI Responses 协议适配（Codex 走的就是它）。
 *
 * Codex 0.155.1 实测请求（`codex exec`，样本 /tmp/llm-mock-capture/req-005.json）：
 *   POST /v1/responses，`stream: true`；
 *   顶层键：model, input, tool_choice, parallel_tool_calls, reasoning, store, stream,
 *   include, prompt_cache_key, text, client_metadata；
 *   input 条目：首条 `type:"additional_tools"`（role "developer"）声明工具，其余是
 *   `{type:"message", role, content:[{type:"input_text", text}]}`。
 *
 * **工具形状决定工具调用的渲染方式**（这也是本文件里最不显然的一处）：
 *   additional_tools 条目的 tools 是「命名空间」数组，
 *   `{type:"namespace", name:"functions", tools:[…]}`，里面混着两种：
 *     `{type:"custom",   name:"exec"}`                 → custom_tool_call（input 是裸文本）
 *     `{type:"function", name:"wait", parameters:{…}}` → function_call（arguments 是 JSON 字符串）
 *   exec 吃的是裸 JavaScript 源码而不是 JSON，所以 codex 按 custom 工具声明它；其余是 function。
 *   形状按**请求里声明的**来选，不按名字猜：同一个剧本换个 harness（工具声明成 function）也成立。
 *
 * 流必须以 `response.completed` 收尾：codex 收不到就判
 * 「stream disconnected before completion: stream closed before response.completed」并重试。
 *
 * 协议中立条目 → Responses：
 *   message.content → output 里的 {type:"message", content:[{type:"output_text", …}]}
 *   tool_calls      → 每个调用一个 custom_tool_call / function_call 条目
 *   节奏 delayMs / chunkDelayMs / chunkSize 与 src/stream.ts 的 streamChunks 完全一致。
 */

import type { FrameOptions, ProtocolAdapter, RequestContext, StreamFrame } from "./protocol";
import type { ScriptResponse } from "./script";
import { resolveUsage, splitGraphemes, type ResponseMeta } from "./stream";

/** Responses 的 usage 字段名与 OpenAI chat 不同（没有 prompt/completion 之说）。 */
export interface ResponseUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
}

/** 文本条目：正文按 output_text 内容块承载。 */
export interface MessageItem {
    type: "message";
    id: string;
    status: "completed";
    role: "assistant";
    content: { type: "output_text"; text: string; annotations: unknown[] }[];
}

/** 自由文本工具调用（codex 的 exec）：input 是裸文本，不是 JSON。 */
export interface CustomToolCallItem {
    type: "custom_tool_call";
    id: string;
    call_id: string;
    name: string;
    input: string;
}

/** 常规函数调用：arguments 是 JSON 字符串。 */
export interface FunctionCallItem {
    type: "function_call";
    id: string;
    call_id: string;
    name: string;
    arguments: string;
}

export type OutputItem = MessageItem | CustomToolCallItem | FunctionCallItem;

/** 非流式 Responses 响应体。 */
export interface ResponseObject {
    id: string;
    object: "response";
    created_at: number;
    status: "completed";
    model: string;
    output: OutputItem[];
    usage: ResponseUsage;
}

/** 请求里声明的工具形状。 */
type ToolKind = "custom" | "function";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function squash(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * 收集「工具名 → 形状」。命名空间（additional_tools 里的 `type:"namespace"`）要递归进去，
 * 但只登记嵌套工具的**裸名**（`exec`）：命名空间前缀是声明侧的组织方式，模型发出的调用名
 * 用它还是裸名不确定，查找时由 isCustomTool 兼容两种写法，免得计数与日志里出现重复项。
 */
function collectToolKinds(tools: unknown, into: Map<string, ToolKind>): void {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
        if (!isPlainObject(tool)) continue;
        if (Array.isArray(tool.tools)) {
            collectToolKinds(tool.tools, into);
            continue;
        }
        const name = tool.name;
        if (typeof name !== "string" || name === "") continue;
        into.set(name, tool.type === "custom" ? "custom" : "function");
    }
}

/** 从请求体里收集工具形状：新版本在 input 的 additional_tools 条目里，老版本在顶层 tools。 */
function requestToolKinds(body: Record<string, unknown>): Map<string, ToolKind> {
    const kinds = new Map<string, ToolKind>();
    collectToolKinds(body.tools, kinds);
    const input = body.input;
    if (Array.isArray(input)) {
        for (const entry of input) {
            if (isPlainObject(entry) && entry.type === "additional_tools") {
                collectToolKinds(entry.tools, kinds);
            }
        }
    }
    return kinds;
}

/**
 * token 估算的输入投影：只留真正算 token 的文本——消息正文、工具调用的参数与输出。
 * 丢掉 reasoning 的加密串与 additional_tools 的工具说明（后者上万字符，
 * 会把估算值顶到与实际内容无关的量级）。其余条目原样保留，交给 estimateTokens 走一遍。
 */
function inputValue(input: unknown): unknown {
    if (!Array.isArray(input)) return input;
    return input.map((entry) => {
        if (!isPlainObject(entry)) return entry;
        if (entry.type === "additional_tools" || entry.type === "reasoning") return undefined;
        const content = entry.content;
        if (content === undefined) return entry;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map((part) => (isPlainObject(part) ? part.text : part));
        }
        return content;
    });
}

/** message 条目的 content 是块数组，把文本块拼起来当预览。 */
function previewContent(content: unknown): string {
    if (typeof content === "string") return squash(content).slice(0, 60);
    if (!Array.isArray(content)) return "";
    const texts = content
        .map((part) => (isPlainObject(part) && typeof part.text === "string" ? part.text : ""))
        .filter((text) => text !== "")
        .join(" ");
    if (texts !== "") return squash(texts).slice(0, 60);
    if (content.length === 0) return "";
    const kinds = content.map((part) =>
        isPlainObject(part) && typeof part.type === "string" ? part.type : "?",
    );
    return `[${kinds.length} parts: ${kinds.join("+")}]`;
}

/** 最后一条 input 条目的预览：一眼看出当前轮到哪一步（工具调用 / 工具结果 / 用户发言）。 */
function previewEntry(entry: Record<string, unknown>): string {
    const type = typeof entry.type === "string" ? entry.type : "?";
    if (type === "additional_tools") {
        const names: string[] = [];
        const walk = (tools: unknown): void => {
            if (!Array.isArray(tools)) return;
            for (const tool of tools) {
                if (!isPlainObject(tool)) continue;
                if (Array.isArray(tool.tools)) walk(tool.tools);
                else if (typeof tool.name === "string") names.push(tool.name);
            }
        };
        walk(entry.tools);
        return `additional_tools[${names.join(",")}]`;
    }
    if (type === "message") {
        const role = typeof entry.role === "string" ? entry.role : "?";
        const preview = previewContent(entry.content);
        return `${role}${preview === "" ? "" : `:"${preview}"`}`;
    }
    const name = typeof entry.name === "string" ? ` ${entry.name}` : "";
    const payload = entry.arguments ?? entry.input ?? entry.output ?? "";
    const preview = typeof payload === "string" ? squash(payload).slice(0, 60) : "";
    return `${type}${name}${preview === "" ? "" : `:"${preview}"`}`;
}

/** 名字命中 custom 工具表（`functions.exec` 这类带命名空间前缀的写法按末段名匹配）。 */
function isCustomTool(name: string, customTools: readonly string[]): boolean {
    if (customTools.includes(name)) return true;
    const dot = name.lastIndexOf(".");
    return dot === -1 ? false : customTools.includes(name.slice(dot + 1));
}

/** 请求里声明为 custom 的工具名（渲染工具调用时按它选 custom_tool_call / function_call）。 */
function customToolNames(request: Record<string, unknown>): string[] {
    const names: string[] = [];
    for (const [name, kind] of requestToolKinds(request)) {
        if (kind === "custom") names.push(name);
    }
    return names;
}

/** 脚本条目 → output 数组：文本消息在前，工具调用按脚本顺序跟在后面。 */
export function outputItems(
    entry: ScriptResponse,
    meta: ResponseMeta,
    customTools: readonly string[] = [],
): OutputItem[] {
    const items: OutputItem[] = [];
    const text = entry.message.content;
    if (text !== null && text !== "") {
        items.push({
            type: "message",
            id: `${meta.id}-msg`,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
        });
    }
    for (const call of entry.message.tool_calls ?? []) {
        if (isCustomTool(call.function.name, customTools)) {
            items.push({
                type: "custom_tool_call",
                id: call.id,
                call_id: call.id,
                name: call.function.name,
                input: call.function.arguments,
            });
        } else {
            items.push({
                type: "function_call",
                id: call.id,
                call_id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
            });
        }
    }
    return items;
}

/** usage 换算：脚本声明优先，否则按 prompt 与内容估算（字段名与 chat 不同）。 */
function tokenUsage(entry: ScriptResponse, prompt: unknown): ResponseUsage {
    const usage = resolveUsage(entry, prompt);
    return {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    };
}

/** 非流式 Responses 响应体。 */
export function toResponse(
    entry: ScriptResponse,
    meta: ResponseMeta,
    ctx: RequestContext,
): ResponseObject {
    return {
        id: meta.id,
        object: "response",
        created_at: meta.created,
        status: "completed",
        model: meta.model,
        output: outputItems(entry, meta, customToolNames(ctx.request)),
        usage: tokenUsage(entry, ctx.prompt),
    };
}

/** response.created / response.in_progress 里的骨架：还没产出任何条目。 */
function responseSkeleton(meta: ResponseMeta, status: "in_progress" | "completed") {
    return {
        id: meta.id,
        object: "response",
        created_at: meta.created,
        status,
        model: meta.model,
        output: [] as OutputItem[],
        usage: null,
    };
}

/** output_item.added 里的条目：参数/正文先给空串，由后续 delta 拼出来（与真实 API 一致）。 */
function openedItem(item: OutputItem): OutputItem {
    if (item.type === "custom_tool_call") return { ...item, input: "" };
    if (item.type === "function_call") return { ...item, arguments: "" };
    return { ...item, content: [] };
}

/**
 * Responses SSE 事件序列；节奏与 src/stream.ts 的 streamChunks 逐拍对齐
 * （首包前 delayMs，之后每个分片前 chunkDelayMs，每步检查 abort）：
 *
 *   response.created → response.in_progress
 *   [每个 output 条目一组]
 *     response.output_item.added
 *     message:          response.content_part.added → output_text.delta* →
 *                       output_text.done → content_part.done
 *     custom_tool_call: custom_tool_call_input.delta* → custom_tool_call_input.done
 *     function_call:    function_call_arguments.delta* → function_call_arguments.done
 *     response.output_item.done
 *   response.completed（带完整 output 与 usage）
 *
 * sequence_number 从 0 起逐一递增，事件名同时写进 `event:` 行与 data.type。
 */
export async function* responseFrames(
    entry: ScriptResponse,
    meta: ResponseMeta,
    options: FrameOptions,
): AsyncGenerator<StreamFrame> {
    const { sleep, signal } = options;
    const items = outputItems(entry, meta, customToolNames(options.request));
    const usage = tokenUsage(entry, options.prompt);

    let sequence = 0;
    const frame = (event: string, rest: Record<string, unknown>): StreamFrame => ({
        event,
        data: { type: event, sequence_number: sequence++, ...rest },
    });

    // 首包前的"思考"耗时（模拟 TTFT）。
    await sleep(entry.delayMs, signal);
    if (signal?.aborted) return;

    yield frame("response.created", { response: responseSkeleton(meta, "in_progress") });
    yield frame("response.in_progress", { response: responseSkeleton(meta, "in_progress") });

    for (const [outputIndex, item] of items.entries()) {
        if (item.type !== "message") {
            // 与 OpenAI 侧一致：进入下一个条目之前等一拍。
            await sleep(entry.chunkDelayMs, signal);
            if (signal?.aborted) return;
        }
        yield frame("response.output_item.added", { output_index: outputIndex, item: openedItem(item) });

        if (item.type === "message") {
            const part = item.content[0];
            yield frame("response.content_part.added", {
                item_id: item.id,
                output_index: outputIndex,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
            });
            for (const piece of splitGraphemes(part.text, entry.chunkSize)) {
                await sleep(entry.chunkDelayMs, signal);
                if (signal?.aborted) return;
                yield frame("response.output_text.delta", {
                    item_id: item.id,
                    output_index: outputIndex,
                    content_index: 0,
                    delta: piece,
                    logprobs: [],
                });
            }
            yield frame("response.output_text.done", {
                item_id: item.id,
                output_index: outputIndex,
                content_index: 0,
                text: part.text,
                logprobs: [],
            });
            yield frame("response.content_part.done", {
                item_id: item.id,
                output_index: outputIndex,
                content_index: 0,
                part,
            });
        } else if (item.type === "custom_tool_call") {
            for (const piece of splitGraphemes(item.input, entry.chunkSize)) {
                await sleep(entry.chunkDelayMs, signal);
                if (signal?.aborted) return;
                yield frame("response.custom_tool_call_input.delta", {
                    item_id: item.id,
                    output_index: outputIndex,
                    delta: piece,
                });
            }
            yield frame("response.custom_tool_call_input.done", {
                item_id: item.id,
                output_index: outputIndex,
                input: item.input,
            });
        } else {
            for (const piece of splitGraphemes(item.arguments, entry.chunkSize)) {
                await sleep(entry.chunkDelayMs, signal);
                if (signal?.aborted) return;
                yield frame("response.function_call_arguments.delta", {
                    item_id: item.id,
                    output_index: outputIndex,
                    delta: piece,
                });
            }
            yield frame("response.function_call_arguments.done", {
                item_id: item.id,
                output_index: outputIndex,
                name: item.name,
                arguments: item.arguments,
            });
        }

        yield frame("response.output_item.done", { output_index: outputIndex, item });
    }

    yield frame("response.completed", {
        response: { ...responseSkeleton(meta, "completed"), output: items, usage },
    });
}

export const responses: ProtocolAdapter = {
    name: "openai-responses",

    /** 一行访问日志：与 chat / messages 摘要同口径，末条按 input 条目类型渲染。 */
    describe(body: Record<string, unknown>): string {
        const parts = [
            `stream=${body.stream === true}`,
            `model=${typeof body.model === "string" ? body.model : "-"}`,
        ];
        const input = body.input;
        if (Array.isArray(input)) {
            parts.push(`input=${input.length}`);
            const last = input[input.length - 1];
            if (isPlainObject(last)) parts.push(`last=${previewEntry(last)}`);
        }
        const kinds = requestToolKinds(body);
        const custom = [...kinds].filter(([, kind]) => kind === "custom").length;
        parts.push(`tools=${kinds.size}`, `custom=${custom}`);
        return parts.join(" ");
    },

    // 与真实 Responses API 一致：stream 缺省为 false，要 SSE 必须显式传 true
    // （Codex 每次都带 stream:true；缺省成非流式也让手工 curl 的语义与线上一致）。
    isStream(body: Record<string, unknown>): boolean {
        return body.stream === true;
    },

    /**
     * 参与 token 估算的输入：instructions（老版本 Codex 的 system 字段）与 input 的文本投影。
     * 只做投影——工具形状由 ctx.request 单独给到渲染侧，不从这里夹带（见下）。
     */
    promptValue(body: Record<string, unknown>): unknown {
        return { instructions: body.instructions, input: inputValue(body.input) };
    },

    body(entry: ScriptResponse, meta: ResponseMeta, ctx: RequestContext): unknown {
        return toResponse(entry, meta, ctx);
    },

    frames(
        entry: ScriptResponse,
        meta: ResponseMeta,
        options: FrameOptions,
    ): AsyncGenerator<StreamFrame> {
        return responseFrames(entry, meta, options);
    },

    /** Responses 的错误形状：与 chat 一致，type 固定 invalid_request_error。 */
    error(message: string, code: string): Record<string, unknown> {
        return { error: { message, type: "invalid_request_error", code } };
    },
};
