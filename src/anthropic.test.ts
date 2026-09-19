import { describe, expect, it } from "bun:test";
import { anthropic, messageFrames, type MessageResponse } from "./anthropic";
import { createApp } from "./app";
import type { MockConfig } from "./config";
import type { RequestContext, StreamFrame } from "./protocol";
import { normalizeEntry, ScriptPlayer, type ScriptResponse } from "./script";
import { estimateTokens } from "./stream";

const META = { id: "msg_test", created: 1_700_000_000, model: "llm-mock" };
const DEFAULTS = { delayMs: 0, chunkDelayMs: 0, chunkSize: 1 };

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
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
        signal?: AbortSignal;
        ctx?: RequestContext;
    } = {},
): Promise<StreamFrame[]> {
    const frames: StreamFrame[] = [];
    for await (const frame of messageFrames(response, META, {
        sleep: options.sleep ?? (async () => {}),
        signal: options.signal,
        ...(options.ctx ?? { prompt: null, request: {} }),
    })) {
        frames.push(frame);
    }
    return frames;
}

const events = (frames: StreamFrame[]) => frames.map((frame) => frame.event);
const payloads = (frames: StreamFrame[]) => frames.map((frame) => frame.data) as any[];

/** 把 "content_block_start … content_block_stop" 之间的帧折成一个块摘要。 */
function blocks(frames: StreamFrame[]): { index: number; type: string }[] {
    const result: { index: number; type: string }[] = [];
    for (const data of payloads(frames)) {
        if (data.type === "content_block_start") {
            result.push({ index: data.index, type: data.content_block.type });
        }
    }
    return result;
}

const textDeltas = (frames: StreamFrame[]) =>
    payloads(frames)
        .filter((data) => data.delta?.type === "text_delta")
        .map((data) => data.delta.text)
        .join("");

const jsonDeltas = (frames: StreamFrame[], index: number) =>
    payloads(frames)
        .filter((data) => data.delta?.type === "input_json_delta" && data.index === index)
        .map((data) => data.delta.partial_json)
        .join("");

const message = (scripted: ScriptResponse, prompt: unknown = null) =>
    anthropic.body(scripted, META, { prompt, request: {} }) as MessageResponse;

describe("anthropic 非流式响应", () => {
    it("文本条目渲染成 message + text 块，stop_reason 为 end_turn", () => {
        const body = message(entry({ content: "你好" }), "abcd");

        expect(body).toMatchObject({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "llm-mock",
            stop_reason: "end_turn",
            stop_sequence: null,
            // "abcd" 4 字符 → 1 token；"你好" 两个汉字 → 2 token。
            usage: { input_tokens: 1, output_tokens: 2 },
        });
        expect(body.content).toEqual([{ type: "text", text: "你好" }]);
    });

    it("tool_calls 渲染成 tool_use 块并映射 stop_reason 为 tool_use", () => {
        const body = message(
            entry({
                content: "先看一眼目录。",
                tool_calls: [
                    { id: "call_1", function: { name: "Bash", arguments: { command: "ls" } } },
                ],
            }),
        );

        expect(body.stop_reason).toBe("tool_use");
        expect(body.content).toEqual([
            { type: "text", text: "先看一眼目录。" },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
        ]);
    });

    it("usage：脚本声明优先", () => {
        const declared = message(
            entry({
                content: "x",
                usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            }),
            "忽略",
        );
        expect(declared.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
    });

    it("只有工具调用时不产出空文本块", () => {
        const body = message(entry({ tool_calls: [{ function: { name: "f", arguments: "{}" } }] }));
        expect(body.content).toEqual([{ type: "tool_use", id: "call_mock_1", name: "f", input: {} }]);
    });

    it("arguments 非法 JSON 时容错为空对象", () => {
        const body = message(
            entry({ tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{坏 JSON" } }] }),
        );
        expect(body.content[0]).toEqual({
            type: "tool_use",
            id: "c1",
            name: "Bash",
            input: {},
        });
    });

    it("arguments 解析结果不是对象时同样退回空对象", () => {
        const body = message(
            entry({ tool_calls: [{ id: "c1", function: { name: "f", arguments: "[1,2]" } }] }),
        );
        expect((body.content[0] as { input: unknown }).input).toEqual({});
    });
});

describe("anthropic 流式事件", () => {
    it("文本：message_start → 块开始 → 逐字 delta → 块结束 → message_delta → message_stop", async () => {
        const frames = await collect(entry({ content: "你好" }));

        expect(events(frames)).toEqual([
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]);

        const [start, blockStart, , , blockStop, delta, stop] = payloads(frames);
        expect(start).toMatchObject({
            type: "message_start",
            message: {
                id: "msg_test",
                type: "message",
                role: "assistant",
                model: "llm-mock",
                content: [],
                stop_reason: null,
                stop_sequence: null,
            },
        });
        expect(start.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
        expect(blockStart).toEqual({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        });
        expect(textDeltas(frames)).toBe("你好");
        expect(blockStop).toEqual({ type: "content_block_stop", index: 0 });
        expect(delta).toEqual({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 2 },
        });
        expect(stop).toEqual({ type: "message_stop" });
    });

    it("工具调用：块开始给 id/name 与空 input，参数由 input_json_delta 拼出", async () => {
        const frames = await collect(
            entry({
                content: "看目录",
                tool_calls: [
                    { id: "c1", function: { name: "Bash", arguments: { command: "ls" } } },
                    { id: "c2", function: { name: "Read", arguments: "坏 JSON" } },
                ],
            }),
        );

        // 事件骨架：message_start + 每个内容块一组 start/delta…/stop + 收尾两个事件。
        expect(events(frames)[0]).toBe("message_start");
        expect(events(frames).slice(-2)).toEqual(["message_delta", "message_stop"]);
        expect(blocks(frames)).toEqual([
            { index: 0, type: "text" },
            { index: 1, type: "tool_use" },
            { index: 2, type: "tool_use" },
        ]);
        // 每个块内部严格是 start → delta… → stop。
        const inner = events(frames).slice(1, -2);
        expect(inner.filter((name) => name === "content_block_start").length).toBe(3);
        expect(inner.filter((name) => name === "content_block_stop").length).toBe(3);
        expect(inner.at(0)).toBe("content_block_start");
        expect(inner.at(-1)).toBe("content_block_stop");

        const starts = payloads(frames).filter((data) => data.type === "content_block_start");
        expect(starts[1]).toEqual({
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "c1", name: "Bash", input: {} },
        });
        expect(starts[2].content_block).toEqual({
            type: "tool_use",
            id: "c2",
            name: "Read",
            input: {},
        });
        // 片段拼起来必须还原成原始 arguments 字符串。
        expect(jsonDeltas(frames, 1)).toBe('{"command":"ls"}');
        expect(jsonDeltas(frames, 2)).toBe("坏 JSON");
        expect(payloads(frames).at(-2).delta.stop_reason).toBe("tool_use");
    });

    it("chunkSize 控制分片大小，且不拆坏 emoji", async () => {
        const frames = await collect(
            normalizeEntry({ content: "abcdef" }, "test", { ...DEFAULTS, chunkSize: 3 }),
        );
        expect(
            payloads(frames)
                .filter((data) => data.delta?.type === "text_delta")
                .map((data) => data.delta.text),
        ).toEqual(["abc", "def"]);

        const emoji = await collect(
            normalizeEntry({ content: "👨‍👩‍👧x" }, "test", DEFAULTS),
        );
        expect(textDeltas(emoji)).toBe("👨‍👩‍👧x");
    });

    it("节奏：首包前 delayMs，每个分片前 chunkDelayMs", async () => {
        const { calls, sleep } = recordingSleep();
        await collect(entry({ content: "ab", delayMs: 100, chunkDelayMs: 5 }), { sleep });
        expect(calls).toEqual([100, 5, 5]);
    });

    it("工具调用块开始前也要等一拍（与 OpenAI 侧的 chunk 节奏一致）", async () => {
        const { calls, sleep } = recordingSleep();
        await collect(entry({ tool_calls: [{ function: { name: "f", arguments: "{}" } }] }), {
            sleep,
        });
        // 首包前 delayMs + 块开始前一拍 + "{}" 两片的间隔。
        expect(calls).toEqual([0, 0, 0, 0]);
    });

    it("abort 后立即停止产出后续事件", async () => {
        const controller = new AbortController();
        const frames: StreamFrame[] = [];
        for await (const frame of messageFrames(entry({ content: "你好世界" }), META, {
            sleep: async () => {
                // 第一个文本分片之后中断。
                if (frames.some((f) => f.event === "content_block_delta")) controller.abort();
            },
            signal: controller.signal,
            prompt: null,
            request: {},
        })) {
            frames.push(frame);
        }
        expect(events(frames)).toEqual([
            "message_start",
            "content_block_start",
            "content_block_delta",
        ]);
    });

    it("请求开始前已 abort 时一个事件都不产出", async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await collect(entry({ content: "你好" }), { signal: controller.signal })).toEqual([]);
    });
});

describe("anthropic 请求解析", () => {
    it("describe：stream/model/messages/last/tools/system 一项不少", () => {
        const line = anthropic.describe({
            stream: true,
            model: "llm-mock",
            system: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
            ],
            tools: [{ name: "Bash" }, { name: "Read" }],
            messages: [
                { role: "user", content: [{ type: "text", text: "第一句" }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: "c1" }] },
            ],
        });
        expect(line).toBe(
            'stream=true model=llm-mock messages=2 last=user:"[1 blocks: tool_result]" tools=2 system=2',
        );
    });

    it("describe：取最后一条的文本块做预览，缺省字段退化但仍是一行", () => {
        expect(
            anthropic.describe({
                messages: [
                    { role: "assistant", content: "无关" },
                    { role: "user", content: [{ type: "text", text: "  多行\n文本  " }] },
                ],
            }),
        ).toBe('stream=false model=- messages=2 last=user:"多行 文本" tools=0 system=0');

        expect(anthropic.describe({})).toBe("stream=false model=- tools=0 system=0");
    });

    it("isStream 只有显式 true 才走流式（与真实 Messages API 的缺省一致）", () => {
        expect(anthropic.isStream({})).toBe(false);
        expect(anthropic.isStream({ stream: true })).toBe(true);
        expect(anthropic.isStream({ stream: false })).toBe(false);
    });

    it("promptValue 含 system 文本与 messages，可直接喂给 estimateTokens", () => {
        const prompt = anthropic.promptValue({
            system: [{ type: "text", text: "abcd", cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: "你好" }],
        });
        expect(prompt).toEqual({ system: ["abcd"], messages: [["你好", undefined]] });
        expect(estimateTokens(prompt)).toBe(3);
    });

    it("error 是 Anthropic 的错误形状", () => {
        expect(anthropic.error("脚本已耗尽", "script_exhausted")).toEqual({
            type: "error",
            error: { type: "script_exhausted", message: "脚本已耗尽" },
        });
    });
});

describe("POST /v1/messages（路由集成）", () => {
    const CONFIG: MockConfig = {
        port: 3457,
        scriptPath: "test.json",
        exhausted: "error",
        model: "mock-model",
    };

    function build(responses: unknown[]) {
        const player = new ScriptPlayer(
            { responses, defaults: {} },
            { policy: "error", source: "test.json" },
        );
        return createApp({
            player,
            config: CONFIG,
            sleep: async () => {},
            now: () => 1_700_000_000_000,
            log: () => {},
        });
    }

    const post = (app: ReturnType<typeof createApp>, body: unknown) =>
        app.request("/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    it("非流式请求返回 message 形状", async () => {
        const app = build([
            {
                content: "你好",
                tool_calls: [{ id: "c1", function: { name: "Bash", arguments: { command: "ls" } } }],
            },
        ]);
        const body = (await (
            await post(app, { model: "llm-mock", stream: false })
        ).json()) as MessageResponse;

        expect(body).toMatchObject({ type: "message", role: "assistant", stop_reason: "tool_use" });
        expect(body.content[1]).toEqual({
            type: "tool_use",
            id: "c1",
            name: "Bash",
            input: { command: "ls" },
        });
    });

    it("流式响应带 event: 行，并以 message_stop 收尾（没有 [DONE]）", async () => {
        const app = build([{ content: "你好" }]);
        const response = await post(app, { model: "llm-mock", stream: true });
        expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

        const text = await response.text();
        expect(text).not.toContain("[DONE]");
        expect(text.split("\n").filter((line) => line.startsWith("event: "))).toEqual([
            "event: message_start",
            "event: content_block_start",
            "event: content_block_delta",
            "event: content_block_delta",
            "event: content_block_stop",
            "event: message_delta",
            "event: message_stop",
        ]);
        // 每个事件块都是 event: + data: 两行。
        expect(
            text
                .trimEnd()
                .split("\n\n")
                .every((block) => block.startsWith("event: ") && block.includes("\ndata: ")),
        ).toBe(true);
    });
});
