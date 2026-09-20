import { describe, expect, it } from "bun:test";
import { createApp } from "./app";
import type { MockConfig } from "./config";
import type { RequestContext, StreamFrame } from "./protocol";
import { responseFrames, responses, toResponse, type ResponseObject } from "./responses";
import { normalizeEntry, ScriptPlayer, type ScriptResponse } from "./script";
import { estimateTokens } from "./stream";

const META = { id: "resp_test", created: 1_700_000_000, model: "llm-mock" };
const DEFAULTS = { delayMs: 0, chunkDelayMs: 0, chunkSize: 1 };

function entry(raw: unknown): ScriptResponse {
    return normalizeEntry(raw, "test", DEFAULTS);
}

/** codex 形状的请求片段：additional_tools 里 exec 是 custom、wait 是 function。 */
const CODEX_TOOLS = [
    {
        type: "additional_tools",
        role: "developer",
        tools: [
            {
                type: "namespace",
                name: "functions",
                tools: [
                    { type: "custom", name: "exec" },
                    { type: "function", name: "wait", parameters: { type: "object" } },
                ],
            },
        ],
    },
];

/** 请求侧窗口：prompt 是 token 估算投影，request 是工具形状（custom / function）的来源。 */
function ctxOf(input: unknown[] = []): RequestContext {
    const request = { model: "llm-mock", input: [...CODEX_TOOLS, ...input] };
    return { prompt: responses.promptValue(request), request, path: "/v1/responses" };
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
    for await (const frame of responseFrames(response, META, {
        sleep: options.sleep ?? (async () => {}),
        signal: options.signal,
        ...(options.ctx ?? ctxOf()),
    })) {
        frames.push(frame);
    }
    return frames;
}

const events = (frames: StreamFrame[]) => frames.map((frame) => frame.event);
const payloads = (frames: StreamFrame[]) => frames.map((frame) => frame.data) as any[];

const textDeltas = (frames: StreamFrame[]) =>
    payloads(frames)
        .filter((data) => data.type === "response.output_text.delta")
        .map((data) => data.delta)
        .join("");

const customInputDeltas = (frames: StreamFrame[]) =>
    payloads(frames)
        .filter((data) => data.type === "response.custom_tool_call_input.delta")
        .map((data) => data.delta)
        .join("");

const argumentsDeltas = (frames: StreamFrame[]) =>
    payloads(frames)
        .filter((data) => data.type === "response.function_call_arguments.delta")
        .map((data) => data.delta)
        .join("");

const body = (scripted: ScriptResponse, ctx: RequestContext = ctxOf()) =>
    toResponse(scripted, META, ctx);

const execCall = (input = 'await tools.exec_command({ cmd: "ls" })') => ({
    content: "先看一眼目录。",
    tool_calls: [{ id: "call_exec_1", function: { name: "exec", arguments: input } }],
});

describe("responses 非流式响应", () => {
    it("文本条目渲染成 response + message/output_text 条目", () => {
        const response = body(entry({ content: "你好" }), ctxOf());

        expect(response).toMatchObject({
            id: "resp_test",
            object: "response",
            created_at: 1_700_000_000,
            status: "completed",
            model: "llm-mock",
        });
        expect(response.output).toEqual([
            {
                type: "message",
                id: "resp_test-msg",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "你好", annotations: [] }],
            },
        ]);
    });

    it("usage 是 input/output/total 三件套，脚本声明优先", () => {
        const estimated = body(entry({ content: "abcd" }), ctxOf());
        expect(estimated.usage).toEqual({ input_tokens: 0, output_tokens: 1, total_tokens: 1 });

        const declared = body(
            entry({
                content: "x",
                usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            }),
            ctxOf(),
        );
        expect(declared.usage).toEqual({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    });

    it("exec 声明成 custom 工具时渲染 custom_tool_call（input 是裸文本）", () => {
        const response = body(entry(execCall()), ctxOf());

        expect(response.output).toEqual([
            {
                type: "message",
                id: "resp_test-msg",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "先看一眼目录。", annotations: [] }],
            },
            {
                type: "custom_tool_call",
                id: "call_exec_1",
                call_id: "call_exec_1",
                name: "exec",
                input: 'await tools.exec_command({ cmd: "ls" })',
            },
        ]);
    });

    it("未声明成 custom 的工具（或请求里没声明工具）渲染 function_call", () => {
        const wait = body(
            entry({
                tool_calls: [{ id: "call_wait_1", function: { name: "wait", arguments: { ms: 10 } } }],
            }),
            ctxOf(),
        );
        expect(wait.output).toEqual([
            {
                type: "function_call",
                id: "call_wait_1",
                call_id: "call_wait_1",
                name: "wait",
                arguments: '{"ms":10}',
            },
        ]);

        // 请求里没有 additional_tools（手工 curl 调试）时，按最标准的 function_call 渲染。
        expect(
            toResponse(entry(execCall()), META, { prompt: null, request: {}, path: "/v1/responses" })
                .output[1],
        ).toMatchObject({
            type: "function_call",
            name: "exec",
        });
    });

    it("带命名空间前缀的工具名同样命中 custom 表", () => {
        const response = body(
            entry({
                tool_calls: [
                    { id: "c1", function: { name: "functions.exec", arguments: "1+1" } },
                ],
            }),
            ctxOf(),
        );
        expect(response.output[0]).toMatchObject({ type: "custom_tool_call", input: "1+1" });
    });
    it("只有工具调用时不产出空的消息条目", () => {
        const response = body(
            entry({ tool_calls: [{ id: "c1", function: { name: "exec", arguments: "1+1" } }] }),
            ctxOf(),
        );
        expect(response.output).toHaveLength(1);
        expect(response.output[0].type).toBe("custom_tool_call");
    });
});

describe("responses 流式事件", () => {
    it("文本：created → in_progress → 条目骨架 → 逐字 delta → 条目收尾 → completed", async () => {
        const frames = await collect(entry({ content: "你好" }));

        expect(events(frames)).toEqual([
            "response.created",
            "response.in_progress",
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_text.done",
            "response.content_part.done",
            "response.output_item.done",
            "response.completed",
        ]);

        const [created, progress, added, partAdded] = payloads(frames);
        expect(created).toMatchObject({
            type: "response.created",
            sequence_number: 0,
            response: {
                id: "resp_test",
                object: "response",
                created_at: 1_700_000_000,
                status: "in_progress",
                model: "llm-mock",
                output: [],
                usage: null,
            },
        });
        expect(progress.response.status).toBe("in_progress");
        expect(added).toMatchObject({
            output_index: 0,
            item: {
                type: "message",
                id: "resp_test-msg",
                status: "completed",
                role: "assistant",
                content: [],
            },
        });
        expect(partAdded).toMatchObject({
            item_id: "resp_test-msg",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
        });
        expect(textDeltas(frames)).toBe("你好");
    });

    it("每个事件的 sequence_number 从 0 起逐一递增", async () => {
        const frames = await collect(entry({ content: "你好" }));
        expect(payloads(frames).map((data) => data.sequence_number)).toEqual(
            events(frames).map((_, index) => index),
        );
    });

    it("completed 带完整 response（output + usage）并收尾", async () => {
        const frames = await collect(entry({ content: "你好" }));
        const last = payloads(frames).at(-1);
        expect(last.type).toBe("response.completed");
        expect(last.response).toMatchObject({
            id: "resp_test",
            object: "response",
            status: "completed",
            usage: { input_tokens: 0, output_tokens: 2, total_tokens: 2 },
        });
        expect(last.response.output[0].content[0].text).toBe("你好");
    });

    it("custom 工具调用：added 给空 input，片段由 custom_tool_call_input.delta 拼出", async () => {
        // chunkSize 放大到一条一片，事件骨架才看得清楚（分片行为另有专门的用例）。
        const whole = normalizeEntry(execCall(), "test", { ...DEFAULTS, chunkSize: 64 });
        const frames = await collect(whole, { ctx: ctxOf() });

        expect(events(frames)).toEqual([
            "response.created",
            "response.in_progress",
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
            "response.output_text.done",
            "response.content_part.done",
            "response.output_item.done",
            "response.output_item.added",
            "response.custom_tool_call_input.delta",
            "response.custom_tool_call_input.done",
            "response.output_item.done",
            "response.completed",
        ]);

        const added = payloads(frames)[8];
        expect(added).toMatchObject({
            output_index: 1,
            item: {
                type: "custom_tool_call",
                id: "call_exec_1",
                call_id: "call_exec_1",
                name: "exec",
                input: "",
            },
        });
        expect(payloads(frames)[9]).toMatchObject({
            item_id: "call_exec_1",
            output_index: 1,
            delta: 'await tools.exec_command({ cmd: "ls" })',
        });
        expect(payloads(frames).at(-2).item).toMatchObject({
            type: "custom_tool_call",
            input: 'await tools.exec_command({ cmd: "ls" })',
        });
        expect(payloads(frames).at(-1).response.output[1]).toMatchObject({
            type: "custom_tool_call",
            input: 'await tools.exec_command({ cmd: "ls" })',
        });
    });

    it("custom 工具调用的片段能拼回完整 input", async () => {
        const frames = await collect(entry(execCall()), { ctx: ctxOf() });
        expect(customInputDeltas(frames)).toBe('await tools.exec_command({ cmd: "ls" })');
    });

    it("function 工具调用：arguments 由 function_call_arguments.delta 拼出", async () => {
        const frames = await collect(
            entry({
                tool_calls: [{ id: "call_wait_1", function: { name: "wait", arguments: { ms: 10 } } }],
            }),
            { ctx: ctxOf() },
        );

        expect(events(frames)).toContain("response.function_call_arguments.delta");
        expect(events(frames).at(-2)).toBe("response.output_item.done");
        expect(argumentsDeltas(frames)).toBe('{"ms":10}');
        expect(payloads(frames).at(-2).item).toEqual({
            type: "function_call",
            id: "call_wait_1",
            call_id: "call_wait_1",
            name: "wait",
            arguments: '{"ms":10}',
        });
    });

    it("chunkSize 控制分片大小，且不拆坏 emoji", async () => {
        const frames = await collect(
            normalizeEntry({ content: "abcdef" }, "test", { ...DEFAULTS, chunkSize: 3 }),
        );
        expect(
            payloads(frames)
                .filter((data) => data.type === "response.output_text.delta")
                .map((data) => data.delta),
        ).toEqual(["abc", "def"]);

        const emoji = await collect(
            normalizeEntry({ content: "👨‍👩‍👧x" }, "test", DEFAULTS),
        );
        expect(textDeltas(emoji)).toBe("👨‍👩‍👧x");
    });

    it("节奏：首包前 delayMs，每个分片前 chunkDelayMs，工具条目进入前也要等一拍", async () => {
        const { calls, sleep } = recordingSleep();
        await collect(entry({ content: "ab", delayMs: 100, chunkDelayMs: 5 }), { sleep });
        expect(calls).toEqual([100, 5, 5]);

        const tool = recordingSleep();
        await collect(
            entry({ tool_calls: [{ function: { name: "exec", arguments: "1+1" } }] }),
            { sleep: tool.sleep },
        );
        // 首包前 delayMs + 条目开始前一拍 + "1+1"（chunkSize 1 → 三片）的间隔。
        expect(tool.calls).toEqual([0, 0, 0, 0, 0]);
    });

    it("abort 后立即停止产出后续事件", async () => {
        const controller = new AbortController();
        const frames: StreamFrame[] = [];
        for await (const frame of responseFrames(entry({ content: "你好世界" }), META, {
            sleep: async () => {
                // 第一个文本分片之后中断。
                if (frames.some((f) => f.event === "response.output_text.delta")) controller.abort();
            },
            signal: controller.signal,
            ...ctxOf(),
        })) {
            frames.push(frame);
        }
        expect(events(frames)).toEqual([
            "response.created",
            "response.in_progress",
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
        ]);
    });

    it("请求开始前已 abort 时一个事件都不产出（不会有半截响应）", async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await collect(entry({ content: "你好" }), { signal: controller.signal })).toEqual([]);
    });
});

describe("responses 请求解析", () => {
    it("describe：stream/model/input/last/tools 一项不少", () => {
        const line = responses.describe({
            stream: true,
            model: "gpt-5.6-luna",
            input: [
                ...CODEX_TOOLS,
                { type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] },
            ],
        });
        expect(line).toBe(
            'stream=true model=gpt-5.6-luna input=2 last=user:"say hi" tools=2 custom=1',
        );
    });

    it("describe：末条是工具结果时按条目类型渲染，缺省字段退化但仍是一行", () => {
        expect(
            responses.describe({
                input: [
                    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
                    { type: "custom_tool_call", name: "exec", input: "await tools.exec_command()" },
                ],
            }),
        ).toBe('stream=false model=- input=2 last=custom_tool_call exec:"await tools.exec_command()" tools=0 custom=0');

        expect(responses.describe({})).toBe("stream=false model=- tools=0 custom=0");
    });

    it("isStream 只有显式 true 才走流式（与真实 Responses API 的缺省一致）", () => {
        expect(responses.isStream({})).toBe(false);
        expect(responses.isStream({ stream: true })).toBe(true);
        expect(responses.isStream({ stream: false })).toBe(false);
    });

    it("promptValue 只做估算投影（工具形状改由 request 传给渲染侧）", () => {
        const prompt = responses.promptValue({
            instructions: "system",
            input: [
                ...CODEX_TOOLS,
                { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
                { type: "reasoning", encrypted_content: "x".repeat(500) },
            ],
        }) as { instructions: string; input: unknown[] };

        // 消息正文按块取 text；additional_tools 的工具说明与 reasoning 的加密串都不计入。
        expect(prompt.input[1]).toEqual(["你好"]);
        // 只算 "system"（2）与 "你好"（2）。
        expect(estimateTokens(prompt)).toBe(4);
        // custom / function 的判定在渲染侧按 request 现算，prompt 里不该夹带工具信息。
        expect(JSON.stringify(prompt)).not.toContain("exec");
    });

    it("error 是 Responses 的错误形状", () => {
        expect(responses.error("脚本已耗尽", "script_exhausted")).toEqual({
            error: { message: "脚本已耗尽", type: "invalid_request_error", code: "script_exhausted" },
        });
    });
});

describe("POST /v1/responses（路由集成）", () => {
    const CONFIG: MockConfig = {
        port: 3457,
        scriptPath: "test.json",
        exhausted: "error",
        model: "mock-model",
    };

    function build(scripted: unknown[]) {
        const player = new ScriptPlayer(
            { responses: scripted, defaults: {} },
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
        app.request("/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    it("非流式请求返回 response 形状", async () => {
        const app = build([execCall()]);
        const response = (await (
            await post(app, { model: "llm-mock", stream: false, input: CODEX_TOOLS })
        ).json()) as ResponseObject;

        expect(response).toMatchObject({ object: "response", status: "completed" });
        expect(response.output[1]).toMatchObject({
            type: "custom_tool_call",
            name: "exec",
            input: 'await tools.exec_command({ cmd: "ls" })',
        });
    });

    it("流式响应带 event: 行，并以 response.completed 收尾（没有 [DONE]）", async () => {
        const app = build([{ content: "你好" }]);
        const response = await post(app, { model: "llm-mock", stream: true, input: CODEX_TOOLS });
        expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

        const text = await response.text();
        expect(text).not.toContain("[DONE]");
        expect(text).toContain("event: response.completed");
        expect(
            text
                .trimEnd()
                .split("\n\n")
                .every((block) => block.startsWith("event: ") && block.includes("\ndata: ")),
        ).toBe(true);
    });
});
