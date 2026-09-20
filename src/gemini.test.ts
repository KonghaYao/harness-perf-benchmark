import { describe, expect, it } from "bun:test";
import { createApp } from "./app";
import type { MockConfig } from "./config";
import { gemini, generateContentFrames, modelFromPath } from "./gemini";
import type { RequestContext, StreamFrame } from "./protocol";
import { normalizeEntry, ScriptPlayer, type ScriptResponse } from "./script";

const META = { id: "resp_test", created: 1_700_000_000, model: "llm-mock" };
const DEFAULTS = { delayMs: 0, chunkDelayMs: 0, chunkSize: 1 };
/** agy 实际用的两个端点：动作是模型名后的 `:action` 后缀。 */
const PATH = "/v1beta/models/gemini-3.1-pro-preview:generateContent";
const STREAM_PATH = "/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent";

function entry(raw: unknown): ScriptResponse {
    return normalizeEntry(raw, "test", DEFAULTS);
}

function recordingSleep() {
    const calls: number[] = [];
    return { calls, sleep: async (ms: number) => void calls.push(ms) };
}

async function collect(
    response: ScriptResponse,
    options: {
        path?: string;
        prompt?: unknown;
        sleep?: (ms: number) => Promise<void>;
        signal?: AbortSignal;
    } = {},
): Promise<StreamFrame[]> {
    const frames: StreamFrame[] = [];
    for await (const frame of generateContentFrames(response, META, {
        prompt: options.prompt ?? null,
        request: {},
        path: options.path ?? STREAM_PATH,
        sleep: options.sleep ?? (async () => {}),
        signal: options.signal,
    })) {
        frames.push(frame);
    }
    return frames;
}

/** 帧里的 candidates[0]，测试里几乎每处都要取。 */
const candidate = (frame: StreamFrame): Record<string, unknown> => {
    const data = frame.data as { candidates: Record<string, unknown>[] };
    return data.candidates[0];
};

const toolCall = (raw: unknown) => entry({ tool_calls: [raw], finish_reason: "tool_calls" });

const RUN_COMMAND = {
    id: "call_1",
    function: { name: "run_command", arguments: '{"CommandLine":"echo hi"}' },
};

describe("modelFromPath", () => {
    it("从路径里剥出模型名，动作后缀（:generateContent / :streamGenerateContent）不算模型名", () => {
        expect(modelFromPath(PATH)).toBe("gemini-3.1-pro-preview");
        expect(modelFromPath(STREAM_PATH)).toBe("gemini-3.1-pro-preview");
        // 标题请求用的是另一个模型：mock 响应里的 modelVersion 要跟着请求走。
        expect(modelFromPath("/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent")).toBe(
            "gemini-3.1-flash-lite-preview",
        );
        expect(modelFromPath("/v1beta/models/x")).toBe("x");
        expect(modelFromPath("/v1/chat/completions")).toBeNull();
    });
});

describe("gemini 适配器的请求侧判定", () => {
    it("流式与否只看路径：请求体里没有任何 stream 标志", () => {
        expect(gemini.isStream({ contents: [] }, STREAM_PATH)).toBe(true);
        expect(gemini.isStream({ contents: [] }, PATH)).toBe(false);
        // 就算请求体里塞了 stream 也不认——这不是 Gemini 的语义。
        expect(gemini.isStream({ stream: true }, PATH)).toBe(false);
    });

    it("摘要带上动作、模型与正文预览（模型与动作都在路径上）", () => {
        const body = {
            contents: [{ role: "user", parts: [{ text: "回复：任务结束" }] }],
            tools: [{ functionDeclarations: [{ name: "a" }, { name: "b" }] }],
        };
        const line = gemini.describe(body, STREAM_PATH);
        expect(line).toContain("streamGenerateContent");
        expect(line).toContain("model=gemini-3.1-pro-preview");
        expect(line).toContain("contents=1");
        expect(line).toContain("tools=2");
    });

    it("工具结果那一轮的预览列出 part 类型，而不是空白", () => {
        const body = {
            contents: [{ role: "model", parts: [{ functionResponse: { name: "run_command" } }] }],
        };
        expect(gemini.describe(body, PATH)).toContain("last=model:\"[1 parts: functionResponse]\"");
    });
});

describe("gemini 非流式响应", () => {
    const generate = (response: ScriptResponse, path = PATH, prompt: unknown = null) =>
        gemini.body(response, META, { prompt, request: {}, path }) as Record<string, any>;

    it("文本条目渲染成 parts:[{text}]，finishReason 为 STOP", () => {
        const body = generate(entry({ content: "你好" }), PATH, "abcd");
        expect(body.candidates[0]).toMatchObject({
            content: { role: "model", parts: [{ text: "你好" }] },
            finishReason: "STOP",
            index: 0,
        });
        expect(body.modelVersion).toBe("gemini-3.1-pro-preview");
        expect(body.usageMetadata.promptTokenCount).toBeGreaterThan(0);
        expect(body.usageMetadata.totalTokenCount).toBe(
            body.usageMetadata.promptTokenCount + body.usageMetadata.candidatesTokenCount,
        );
    });

    it("tool_calls 渲染成 functionCall：args 是**对象**不是 JSON 串，且带 id（客户端靠它配对）", () => {
        const body = generate(toolCall(RUN_COMMAND));
        expect(body.candidates[0].content.parts).toEqual([
            {
                functionCall: {
                    name: "run_command",
                    args: { CommandLine: "echo hi" },
                    id: "call_1",
                },
            },
        ]);
        // Gemini 不把函数调用当终止原因：照样是 STOP。
        expect(body.candidates[0].finishReason).toBe("STOP");
    });

    it("arguments 不是合法 JSON 时容错成空对象，调用照常发出", () => {
        const body = generate(
            toolCall({ id: "c", function: { name: "run_command", arguments: "{坏掉的" } }),
        );
        expect(body.candidates[0].content.parts[0].functionCall.args).toEqual({});
    });

    it("finish_reason 映射到 Gemini 枚举", () => {
        expect(generate(entry({ content: "x", finish_reason: "length" })).candidates[0].finishReason)
            .toBe("MAX_TOKENS");
        expect(
            generate(entry({ content: "x", finish_reason: "content_filter" })).candidates[0]
                .finishReason,
        ).toBe("SAFETY");
    });

    it("脚本声明 usage 时按声明值渲染", () => {
        const body = generate(
            entry({ content: "x", usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
        );
        expect(body.usageMetadata).toEqual({
            promptTokenCount: 7,
            candidatesTokenCount: 3,
            totalTokenCount: 10,
        });
    });
});

describe("gemini SSE 帧序列", () => {
    it("文本按 chunkSize 分片，每帧一份完整片段，收尾帧带 finishReason 与 usageMetadata", async () => {
        const frames = await collect(entry({ content: "你好" }), { prompt: "abcd" });
        expect(frames.map((frame) => (frame.data as any).candidates[0].content.parts)).toEqual([
            [{ text: "你" }],
            [{ text: "好" }],
            [],
        ]);
        const last = frames[frames.length - 1].data as any;
        expect(last.candidates[0].finishReason).toBe("STOP");
        // usageMetadata 与真实 API 一样只出现在收尾帧。
        expect(last.usageMetadata.promptTokenCount).toBeGreaterThan(0);
        expect(frames[0].data).not.toHaveProperty("usageMetadata");
        expect(frames[0].event).toBeUndefined();
    });

    it("函数调用整块发一帧（不分片），参数也不会被 chunkSize 拆开", async () => {
        const frames = await collect(toolCall(RUN_COMMAND));
        expect(frames).toHaveLength(2);
        expect((frames[0].data as any).candidates[0].content.parts[0].functionCall).toEqual({
            name: "run_command",
            args: { CommandLine: "echo hi" },
            id: "call_1",
        });
        expect((frames[1].data as any).candidates[0].finishReason).toBe("STOP");
    });

    it("每帧都带 modelVersion，且跟着路径上的模型走", async () => {
        const frames = await collect(entry({ content: "x" }), {
            path: "/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent",
        });
        for (const frame of frames) {
            expect((frame.data as any).modelVersion).toBe("gemini-3.1-flash-lite-preview");
        }
    });

    it("首包前等 delayMs，分片之间等 chunkDelayMs", async () => {
        const { calls, sleep } = recordingSleep();
        await collect(entry({ content: "你好", delayMs: 120, chunkDelayMs: 5 }), { sleep });
        expect(calls).toEqual([120, 5, 5]);
    });

    it("abort 后立即停止产出后续帧（收尾帧也不会发）", async () => {
        const controller = new AbortController();
        const frames: StreamFrame[] = [];
        for await (const frame of generateContentFrames(entry({ content: "你好世界" }), META, {
            prompt: null,
            request: {},
            path: STREAM_PATH,
            sleep: async () => {
                // 第一个分片发出去之后中断。
                if (frames.length > 0) controller.abort();
            },
            signal: controller.signal,
        })) {
            frames.push(frame);
        }
        expect(frames).toHaveLength(1);
        expect(frames.some((frame) => (frame.data as any).candidates[0].finishReason)).toBe(false);
    });

    it("错误体是 Gemini 的 { error: { code, message, status } }", () => {
        expect(gemini.error("脚本已耗尽", "script_exhausted")).toEqual({
            error: { code: 400, message: "脚本已耗尽", status: "script_exhausted" },
        });
    });

    it("candidate 的 index 恒为 0（choices 恒为 1）", async () => {
        const frames = await collect(entry({ content: "x" }));
        for (const frame of frames) expect(candidate(frame).index).toBe(0);
    });
});

describe("Gemini 路由", () => {
    const CONFIG: MockConfig = {
        port: 3457,
        scriptPath: "test.json",
        exhausted: "error",
        model: "mock-model",
    };

    function build(responses: unknown[] = ["第一条"], policy: "error" | "stop" = "error") {
        const player = new ScriptPlayer(
            { responses, defaults: {} },
            { policy, source: "test.json" },
        );
        return createApp({
            player,
            config: CONFIG,
            sleep: async () => {},
            now: () => 1_700_000_000_000,
            log: () => {},
        });
    }

    const post = (app: ReturnType<typeof createApp>, path: string, body: unknown = {}) =>
        app.request(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    it(":generateContent 走非流式，:streamGenerateContent 走 SSE", async () => {
        const app = build(["你好", "你好"]);
        const plain = await post(app, PATH, { contents: [] });
        expect(plain.headers.get("content-type")).toContain("application/json");
        expect((await plain.json()).candidates[0].content.parts).toEqual([{ text: "你好" }]);

        const streamed = await post(app, STREAM_PATH, { contents: [] });
        expect(streamed.headers.get("content-type")).toContain("text/event-stream");
        const text = await streamed.text();
        // 没有 event: 行，也没有 data: [DONE]——Gemini 靠带 finishReason 的那帧收口。
        expect(text).not.toContain("event:");
        expect(text).not.toContain("[DONE]");
        expect(text).toContain('"finishReason":"STOP"');
    });

    it("countTokens 等非生成动作落到 404，不消费脚本", async () => {
        const app = build(["第一条"]);
        const response = await post(app, "/v1beta/models/gemini-3.1-pro-preview:countTokens", {
            contents: [],
        });
        expect(response.status).toBe(404);
        expect((await response.json()).error.code).toBe("not_found");
        // 脚本游标没动：还能正常拿到第一条。
        const ok = await post(app, PATH, { contents: [] });
        expect((await ok.json()).candidates[0].content.parts).toEqual([{ text: "第一条" }]);
    });
});
