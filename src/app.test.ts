import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import type { ExhaustedPolicy, MockConfig } from "./config";
import { ScriptPlayer, STOP_MESSAGE } from "./script";
import type { ChatCompletion, ChatCompletionChunk } from "./types";

const CONFIG: MockConfig = {
    port: 3457,
    scriptPath: "test.json",
    exhausted: "error",
    model: "mock-model",
};

const NOW = 1_700_000_000_000;

function build(
    options: {
        responses?: unknown[];
        policy?: ExhaustedPolicy;
        config?: Partial<MockConfig>;
        file?: string;
    } = {},
) {
    const player = options.file
        ? ScriptPlayer.fromFile(options.file, { policy: options.policy ?? "error" })
        : new ScriptPlayer(
              { responses: options.responses ?? ["第一条", "第二条"], defaults: {} },
              { policy: options.policy ?? "error", source: "test.json" },
          );
    const app = createApp({
        player,
        config: { ...CONFIG, ...options.config },
        // 注入假 sleep：路由测试不依赖真实时间。
        sleep: async () => {},
        now: () => NOW,
        log: () => {},
    });
    return { app, player };
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
    return app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

/** 取出 SSE 事件的 payload，含结尾的 [DONE]。 */
async function sseEvents(response: Response): Promise<string[]> {
    const text = await response.text();
    return text
        .split("\n\n")
        .map((block) => block.trim())
        .filter((block) => block.startsWith("data:"))
        .map((block) => block.slice("data:".length).trim());
}

async function sseChunks(response: Response): Promise<ChatCompletionChunk[]> {
    const events = await sseEvents(response);
    expect(events.at(-1)).toBe("[DONE]");
    return events.slice(0, -1).map((event) => JSON.parse(event) as ChatCompletionChunk);
}

const readJson = async (response: Response): Promise<any> => await response.json();

describe("POST /v1/chat/completions（非流式）", () => {
    it("第 i 次请求返回脚本第 i 条，并补全响应元信息", async () => {
        const { app } = build();

        const first = await readJson(await post(app, "/v1/chat/completions", { messages: [] }));
        expect(first).toMatchObject({
            object: "chat.completion",
            created: NOW / 1000,
            model: "mock-model",
            // 空 prompt 估 0；"第一条" 三个汉字估 3。
            usage: { prompt_tokens: 0, completion_tokens: 3, total_tokens: 3 },
        });
        expect(typeof first.id).toBe("string");
        expect(first.choices).toEqual([
            {
                index: 0,
                message: { role: "assistant", content: "第一条" },
                finish_reason: "stop",
                logprobs: null,
            },
        ]);

        const second = await readJson(await post(app, "/v1/chat/completions", { messages: [] }));
        expect(second.choices[0].message.content).toBe("第二条");
    });

    it("model 回显优先级：脚本 > 请求 > 配置", async () => {
        const echo = await readJson(
            await post(build().app, "/v1/chat/completions", { model: "gpt-from-client" }),
        );
        expect(echo.model).toBe("gpt-from-client");

        const scripted = build({ responses: [{ content: "x", model: "gpt-from-script" }] }).app;
        const fromScript = await readJson(
            await post(scripted, "/v1/chat/completions", { model: "gpt-from-client" }),
        );
        expect(fromScript.model).toBe("gpt-from-script");
    });

    it("未声明 usage 时按请求与内容估算 token", async () => {
        const { app } = build({ responses: [{ content: "abcd" }] });
        const body = await readJson(
            await post(app, "/v1/chat/completions", {
                messages: [{ role: "user", content: "你好" }],
            }),
        );
        // prompt: 2 个汉字 = 2；completion: 4 个 ASCII 字符 = 1。
        expect(body.usage).toEqual({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
    });

    it("脚本可覆盖 id / created / usage", async () => {
        const { app } = build({
            responses: [
                {
                    id: "chatcmpl-fixed",
                    created: 42,
                    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
                    message: "hi",
                },
            ],
        });
        const body = await readJson(await post(app, "/v1/chat/completions", {}));
        expect(body.id).toBe("chatcmpl-fixed");
        expect(body.created).toBe(42);
        expect(body.usage).toEqual({ prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
    });

    it("/chat/completions 别名同样可用", async () => {
        const { app } = build();
        const response = await post(app, "/chat/completions", { messages: [] });
        expect(response.status).toBe(200);
    });

    it("耗尽后返回 500 与可识别的错误码", async () => {
        const { app } = build({ responses: ["唯一一条"] });
        expect((await post(app, "/v1/chat/completions", {})).status).toBe(200);

        const exhausted = await post(app, "/v1/chat/completions", {});
        expect(exhausted.status).toBe(500);
        const body = await readJson(exhausted);
        expect(body.error.code).toBe("script_exhausted");
        expect(body.error.message).toContain("/__mock/reset");
    });

    it("hold 策略下耗尽后重复最后一条", async () => {
        const { app } = build({ responses: ["only"], policy: "hold" });
        const first = await readJson(await post(app, "/v1/chat/completions", {}));
        const second = await readJson(await post(app, "/v1/chat/completions", {}));
        expect(first.choices[0].message.content).toBe("only");
        expect(second.choices[0].message.content).toBe("only");
    });

    it("stop 策略下耗尽后给出可收尾的纯文本（三条路由都能走到）", async () => {
        const { app } = build({ responses: ["唯一一条"], policy: "stop" });
        expect((await post(app, "/v1/chat/completions", {})).status).toBe(200);

        const end = await readJson(await post(app, "/v1/chat/completions", {}));
        expect(end.choices[0].message.content).toBe(STOP_MESSAGE);
        expect(end.choices[0].message.tool_calls).toBeUndefined();
        expect(end.choices[0].finish_reason).toBe("stop");

        // 三协议共用同一个播放器：适配层要都能把收尾响应渲染成正常结束。
        const messages = await post(app, "/v1/messages", { model: "mock-model" });
        expect(messages.status).toBe(200);
        expect(await readJson(messages)).toMatchObject({
            type: "message",
            stop_reason: "end_turn",
        });

        const responses = await post(app, "/v1/responses", { model: "mock-model" });
        expect(responses.status).toBe(200);
        expect(await readJson(responses)).toMatchObject({ status: "completed" });
    });
});

describe("POST /v1/chat/completions（流式）", () => {
    it("把完整响应转成 SSE chunk 序列并以 [DONE] 收尾", async () => {
        const { app } = build();
        const response = await post(app, "/v1/chat/completions", { messages: [], stream: true });
        expect(response.headers.get("content-type")).toContain("text/event-stream");

        const chunks = await sseChunks(response);
        expect(chunks.map((chunk) => chunk.choices[0]!.delta)).toEqual([
            { role: "assistant", content: "" },
            { content: "第" },
            { content: "一" },
            { content: "条" },
            {},
        ]);
        expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe("stop");
        expect(chunks[0]!.object).toBe("chat.completion.chunk");
    });

    it("stream_options.include_usage 时以空 choices 的 usage chunk 收尾", async () => {
        const { app } = build();
        const response = await post(app, "/v1/chat/completions", {
            stream: true,
            stream_options: { include_usage: true },
        });
        const chunks = await sseChunks(response);
        const last = chunks.at(-1)!;
        expect(last.choices).toEqual([]);
        expect(last.usage).toEqual({ prompt_tokens: 0, completion_tokens: 3, total_tokens: 3 });
    });

    it("tool_calls 场景端到端：id/name 起始，arguments 分片可拼回", async () => {
        const { app } = build({
            responses: [
                {
                    content: null,
                    tool_calls: [
                        {
                            id: "call_1",
                            function: { name: "read_file", arguments: { path: "a.md" } },
                        },
                    ],
                },
            ],
        });
        const response = await post(app, "/v1/chat/completions", { stream: true });
        const chunks = await sseChunks(response);

        const start = chunks.find((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.id);
        expect(start!.choices[0]!.delta.tool_calls![0]).toMatchObject({
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "" },
        });

        const args = chunks
            .flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? [])
            .map((call) => call.function?.arguments ?? "")
            .join("");
        expect(args).toBe('{"path":"a.md"}');
        expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe("tool_calls");
    });

    it("每次请求各自消费一条脚本条目", async () => {
        const { app, player } = build();
        await sseChunks(await post(app, "/v1/chat/completions", { stream: true }));
        expect(player.status().index).toBe(1);
        await sseChunks(await post(app, "/v1/chat/completions", { stream: true }));
        expect(player.status().index).toBe(2);
    });

    it("事件顺序与脚本顺序一致：脚本条目的 tool_calls 先于后续文本条目", async () => {
        const { app } = build({
            responses: [
                { content: null, tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
                "done",
            ],
        });
        const firstRound = await sseChunks(await post(app, "/v1/chat/completions", { stream: true }));
        const secondRound = await sseChunks(await post(app, "/v1/chat/completions", { stream: true }));
        expect(firstRound.at(-1)!.choices[0]!.finish_reason).toBe("tool_calls");
        expect(secondRound.at(-1)!.choices[0]!.finish_reason).toBe("stop");
    });
});

describe("控制端点", () => {
    it("status 反映游标状态", async () => {
        const { app } = build();
        await post(app, "/v1/chat/completions", {});
        expect(await readJson(await app.request("/__mock/status"))).toMatchObject({
            source: "test.json",
            policy: "error",
            size: 2,
            index: 1,
            remaining: 1,
            exhausted: false,
        });
    });

    it("reset 重置或跳转游标，越界返回 400", async () => {
        const { app } = build();
        await post(app, "/v1/chat/completions", {});

        expect(
            await readJson(await app.request("/__mock/reset", { method: "POST" })),
        ).toMatchObject({ index: 0, exhausted: false });

        expect(
            await readJson(await app.request("/__mock/reset?index=2", { method: "POST" })),
        ).toMatchObject({ index: 2, exhausted: true });

        const invalid = await app.request("/__mock/reset?index=9", { method: "POST" });
        expect(invalid.status).toBe(400);
        expect((await readJson(invalid)).error.code).toBe("invalid_index");
    });

    it("reload 重新读取脚本文件并重置游标", async () => {
        const dir = mkdtempSync(join(tmpdir(), "llm-mock-app-"));
        const file = join(dir, "script.json");
        writeFileSync(file, JSON.stringify(["v1"]), "utf-8");

        const { app } = build({ file });
        expect((await readJson(await post(app, "/v1/chat/completions", {}))).choices[0].message.content).toBe("v1");

        writeFileSync(file, JSON.stringify(["v2-a", "v2-b"]), "utf-8");
        expect(await readJson(await app.request("/__mock/reload", { method: "POST" }))).toMatchObject({
            size: 2,
            index: 0,
        });
        expect((await readJson(await post(app, "/v1/chat/completions", {}))).choices[0].message.content).toBe("v2-a");
    });
});

describe("其它端点与错误", () => {
    it("GET /v1/models 返回配置的模型", async () => {
        const { app } = build();
        const body = await readJson(await app.request("/v1/models"));
        expect(body.object).toBe("list");
        expect(body.data[0].id).toBe("mock-model");
    });

    it("非法 JSON 请求体返回 400", async () => {
        const { app } = build();
        const response = await app.request("/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{oops",
        });
        expect(response.status).toBe(400);
        expect((await readJson(response)).error.code).toBe("invalid_json");
    });

    it("未知路径返回 404", async () => {
        const { app } = build();
        const response = await app.request("/nope");
        expect(response.status).toBe(404);
        expect((await readJson(response)).error.code).toBe("not_found");
    });
});
