/**
 * 脚本 = 一段预设响应序列：第 i 次 /v1/chat/completions 请求返回第 i 条。
 *
 * 文件形态（两种都接受）：
 *   [ {...}, {...} ]
 *   { "defaults": { "delayMs": 200, "chunkDelayMs": 15, "chunkSize": 2 }, "responses": [ {...} ] }
 *
 * 单条响应形态（按顺序判定）：
 *   1. "文本"                                                     等价 content
 *   2. { "message": {...} | "文本", "finish_reason": "stop" }
 *   3. { "content": "...", "tool_calls": [...] }                   message 字段直铺
 *   4. { "choices": [{ "message": ..., "finish_reason": ... }] }   完整 chat.completion
 *
 * 节奏字段 delayMs / chunkDelayMs / chunkSize 写在条目顶层，覆盖 defaults；
 * 命令行 / 环境变量显式给出的值优先于脚本 defaults。
 */

import { readFileSync } from "node:fs";
import type { ExhaustedPolicy } from "./config";
import type { AssistantMessage, FinishReason, ToolCall, Usage } from "./types";

const FINISH_REASONS: readonly FinishReason[] = [
    "stop",
    "length",
    "tool_calls",
    "content_filter",
    "function_call",
];

export interface ScriptDefaults {
    delayMs?: number;
    chunkDelayMs?: number;
    chunkSize?: number;
}

export interface ResolvedDefaults {
    delayMs: number;
    chunkDelayMs: number;
    chunkSize: number;
}

/** 归一化后的一次响应：内容 + 节奏，服务端据此生成非流式响应或 SSE 序列。 */
export interface ScriptResponse {
    /** 脚本可覆盖；null 表示由服务端按请求生成。 */
    id: string | null;
    created: number | null;
    model: string | null;
    message: AssistantMessage;
    finishReason: FinishReason;
    /** null 表示脚本未声明 usage，响应中按字符估算。 */
    usage: Usage | null;
    delayMs: number;
    chunkDelayMs: number;
    chunkSize: number;
}

export interface ScriptStatus {
    source: string;
    policy: ExhaustedPolicy;
    size: number;
    index: number;
    remaining: number;
    exhausted: boolean;
}

function fail(where: string, message: string): never {
    throw new Error(`${where}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(
    raw: Record<string, unknown>,
    key: string,
    where: string,
): number | undefined {
    const value = raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        fail(where, `${key} 必须是非负数字，收到 ${JSON.stringify(value)}`);
    }
    return value;
}

function optionalString(
    raw: Record<string, unknown>,
    key: string,
    where: string,
): string | null {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
        fail(where, `${key} 必须是字符串，收到 ${JSON.stringify(value)}`);
    }
    return value;
}

/** 节奏合计：显式配置 > 脚本 defaults > 内置值。 */
export function mergeDefaults(
    configDefaults: ScriptDefaults,
    fileDefaults: ScriptDefaults,
): ResolvedDefaults {
    return {
        delayMs: configDefaults.delayMs ?? fileDefaults.delayMs ?? 0,
        chunkDelayMs: configDefaults.chunkDelayMs ?? fileDefaults.chunkDelayMs ?? 0,
        chunkSize: configDefaults.chunkSize ?? fileDefaults.chunkSize ?? 1,
    };
}

function readRhythm(
    raw: Record<string, unknown>,
    where: string,
    defaults: ResolvedDefaults,
): ResolvedDefaults {
    const chunkSize = optionalNumber(raw, "chunkSize", where) ?? defaults.chunkSize;
    if (chunkSize < 1) fail(where, "chunkSize 必须 >= 1");
    return {
        delayMs: optionalNumber(raw, "delayMs", where) ?? defaults.delayMs,
        chunkDelayMs: optionalNumber(raw, "chunkDelayMs", where) ?? defaults.chunkDelayMs,
        chunkSize: Math.floor(chunkSize),
    };
}

function normalizeArguments(raw: unknown, where: string): string {
    if (raw === undefined || raw === null) return "{}";
    if (typeof raw === "string") return raw;
    // 手写脚本常把 arguments 写成对象，等价于先 JSON.stringify。
    if (isPlainObject(raw) || Array.isArray(raw)) return JSON.stringify(raw);
    fail(where, "function.arguments 必须是字符串或对象");
}

function normalizeToolCalls(raw: unknown, where: string): ToolCall[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        fail(where, "tool_calls 必须是非空数组");
    }
    return raw.map((item, index) => {
        const at = `${where} tool_calls[${index}]`;
        if (!isPlainObject(item)) fail(at, "必须是对象");
        const fn = item.function;
        if (!isPlainObject(fn)) fail(at, "缺少 function 对象");
        const name = fn.name;
        if (typeof name !== "string" || name === "") fail(at, "缺少 function.name");
        return {
            id:
                typeof item.id === "string" && item.id !== ""
                    ? item.id
                    : `call_mock_${index + 1}`,
            type: "function" as const,
            function: { name, arguments: normalizeArguments(fn.arguments, at) },
        };
    });
}

function normalizeMessage(raw: unknown, where: string): AssistantMessage {
    if (typeof raw === "string") return { role: "assistant", content: raw };
    if (!isPlainObject(raw)) fail(where, "message 必须是字符串或对象");
    if (raw.role !== undefined && raw.role !== "assistant") {
        fail(where, `message.role 只能是 assistant，收到 ${JSON.stringify(raw.role)}`);
    }
    const content = raw.content;
    if (content !== undefined && content !== null && typeof content !== "string") {
        fail(where, "message.content 必须是字符串或 null");
    }
    const message: AssistantMessage = {
        role: "assistant",
        content: typeof content === "string" ? content : null,
    };
    if (raw.tool_calls !== undefined) {
        message.tool_calls = normalizeToolCalls(raw.tool_calls, where);
    }
    if (message.content === null && message.tool_calls === undefined) {
        fail(where, "message 至少要提供 content 或 tool_calls");
    }
    return message;
}

function normalizeFinishReason(
    raw: unknown,
    message: AssistantMessage,
    where: string,
): FinishReason {
    if (raw === undefined || raw === null) {
        return message.tool_calls ? "tool_calls" : "stop";
    }
    if (typeof raw !== "string" || !FINISH_REASONS.includes(raw as FinishReason)) {
        fail(where, `finish_reason 非法: ${JSON.stringify(raw)}`);
    }
    return raw as FinishReason;
}

function normalizeUsage(raw: unknown, where: string): Usage | null {
    if (raw === undefined || raw === null) return null;
    const at = `${where} usage`;
    if (!isPlainObject(raw)) fail(at, "必须是对象");
    const promptTokens = optionalNumber(raw, "prompt_tokens", at) ?? 0;
    const completionTokens = optionalNumber(raw, "completion_tokens", at) ?? 0;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens:
            optionalNumber(raw, "total_tokens", at) ?? promptTokens + completionTokens,
    };
}

export function normalizeEntry(
    raw: unknown,
    where: string,
    defaults: ResolvedDefaults,
): ScriptResponse {
    if (typeof raw === "string") {
        return {
            id: null,
            created: null,
            model: null,
            message: { role: "assistant", content: raw },
            finishReason: "stop",
            usage: null,
            ...defaults,
        };
    }
    if (!isPlainObject(raw)) {
        fail(where, `条目必须是字符串或对象，收到 ${JSON.stringify(raw)}`);
    }

    const rhythm = readRhythm(raw, where, defaults);
    const usage = normalizeUsage(raw.usage, where);

    // 形态 4：完整 chat.completion
    if (raw.choices !== undefined) {
        if (!Array.isArray(raw.choices) || raw.choices.length !== 1) {
            fail(where, "choices 必须恰好包含 1 个元素（mock 只支持 n=1）");
        }
        const choice = raw.choices[0];
        const at = `${where} choices[0]`;
        if (!isPlainObject(choice)) fail(at, "必须是对象");
        const message = normalizeMessage(choice.message, at);
        return {
            id: optionalString(raw, "id", where),
            created: optionalNumber(raw, "created", where) ?? null,
            model: optionalString(raw, "model", where),
            message,
            finishReason: normalizeFinishReason(choice.finish_reason, message, at),
            usage,
            ...rhythm,
        };
    }

    // 形态 2 / 3：message 对象或 content / tool_calls 直铺
    const source =
        raw.message !== undefined
            ? raw.message
            : { content: raw.content, tool_calls: raw.tool_calls };
    const message = normalizeMessage(source, where);
    return {
        id: optionalString(raw, "id", where),
        created: optionalNumber(raw, "created", where) ?? null,
        model: optionalString(raw, "model", where),
        message,
        finishReason: normalizeFinishReason(raw.finish_reason, message, where),
        usage,
        ...rhythm,
    };
}

function parseDefaults(raw: unknown, source: string): ScriptDefaults {
    if (raw === undefined || raw === null) return {};
    const where = `${source} defaults`;
    if (!isPlainObject(raw)) fail(where, "必须是对象");
    const chunkSize = optionalNumber(raw, "chunkSize", where);
    if (chunkSize !== undefined && chunkSize < 1) fail(where, "chunkSize 必须 >= 1");
    return {
        delayMs: optionalNumber(raw, "delayMs", where),
        chunkDelayMs: optionalNumber(raw, "chunkDelayMs", where),
        chunkSize: chunkSize === undefined ? undefined : Math.floor(chunkSize),
    };
}

export interface RawScript {
    responses: unknown[];
    defaults: ScriptDefaults;
}

/** 解析脚本文本；错误信息带来源与条目序号，便于定位。 */
export function parseScript(text: string, source: string): RawScript {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (error) {
        fail(source, `不是合法 JSON（${(error as Error).message}）`);
    }
    if (Array.isArray(data)) return { responses: data, defaults: {} };
    if (isPlainObject(data)) {
        if (!Array.isArray(data.responses)) {
            fail(source, "顶层对象必须包含 responses 数组");
        }
        return { responses: data.responses, defaults: parseDefaults(data.defaults, source) };
    }
    fail(source, "顶层必须是数组或 { defaults, responses } 对象");
}

export function readScriptFile(path: string): RawScript {
    let text: string;
    try {
        text = readFileSync(path, "utf-8");
    } catch (error) {
        fail(path, `脚本文件读取失败（${(error as Error).message}）`);
    }
    return parseScript(text, path);
}

/**
 * 脚本播放器：进程级单游标，第 i 次 take() 返回第 i 条。
 *
 * 取号是同步的，Bun 单线程下天然对并发请求原子，响应顺序即请求到达顺序。
 */
export class ScriptPlayer {
    #entries: ScriptResponse[];
    #policy: ExhaustedPolicy;
    #source: string;
    #configDefaults: ScriptDefaults;
    #index = 0;

    constructor(
        raw: RawScript,
        options: {
            policy: ExhaustedPolicy;
            source: string;
            configDefaults?: ScriptDefaults;
        },
    ) {
        this.#policy = options.policy;
        this.#source = options.source;
        this.#configDefaults = options.configDefaults ?? {};
        this.#entries = this.#normalize(raw);
    }

    static fromFile(
        path: string,
        options: { policy: ExhaustedPolicy; configDefaults?: ScriptDefaults },
    ): ScriptPlayer {
        return new ScriptPlayer(readScriptFile(path), {
            policy: options.policy,
            source: path,
            configDefaults: options.configDefaults,
        });
    }

    #normalize(raw: RawScript): ScriptResponse[] {
        const defaults = mergeDefaults(this.#configDefaults, raw.defaults);
        return raw.responses.map((entry, index) =>
            normalizeEntry(entry, `${this.#source}: responses[${index}]`, defaults),
        );
    }

    get size(): number {
        return this.#entries.length;
    }

    /**
     * 取下一次响应并推进游标。
     * 耗尽时：error 返回 null（调用方报错）；hold 重复最后一条；loop 从头再来。
     */
    take(): ScriptResponse | null {
        if (this.#entries.length === 0) return null;
        if (this.#index >= this.#entries.length) {
            if (this.#policy === "hold") return this.#entries[this.#entries.length - 1]!;
            if (this.#policy === "loop") this.#index = 0;
            else return null;
        }
        return this.#entries[this.#index++]!;
    }

    status(): ScriptStatus {
        return {
            source: this.#source,
            policy: this.#policy,
            size: this.#entries.length,
            index: this.#index,
            remaining: Math.max(0, this.#entries.length - this.#index),
            exhausted: this.#index >= this.#entries.length,
        };
    }

    reset(index = 0): void {
        if (!Number.isInteger(index) || index < 0 || index > this.#entries.length) {
            fail("reset", `index 必须在 0..${this.#entries.length} 之间，收到 ${index}`);
        }
        this.#index = index;
    }

    /** 重新读取脚本文件并重置游标，改脚本后无需重启进程。 */
    reload(): void {
        this.#entries = this.#normalize(readScriptFile(this.#source));
        this.#index = 0;
    }
}
