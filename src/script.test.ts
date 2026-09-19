import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExhaustedPolicy } from "./config";
import { normalizeEntry, parseScript, ScriptPlayer, STOP_MESSAGE } from "./script";

const DEFAULTS = { delayMs: 0, chunkDelayMs: 0, chunkSize: 1 };

describe("parseScript", () => {
    it("接受纯数组形态", () => {
        const parsed = parseScript('["a", "b"]', "test.json");
        expect(parsed.responses).toEqual(["a", "b"]);
        expect(parsed.defaults).toEqual({});
    });

    it("接受 { defaults, responses } 形态", () => {
        const parsed = parseScript(
            '{ "defaults": { "delayMs": 5, "chunkSize": 2 }, "responses": ["a"] }',
            "test.json",
        );
        expect(parsed.defaults).toEqual({ delayMs: 5, chunkSize: 2 });
        expect(parsed.responses).toEqual(["a"]);
    });

    it("非法 JSON / 非法顶层给出带来源的错误", () => {
        expect(() => parseScript("{oops", "s.json")).toThrow(/s\.json: 不是合法 JSON/);
        expect(() => parseScript("42", "s.json")).toThrow(/顶层必须是数组或/);
        expect(() => parseScript("{}", "s.json")).toThrow(/必须包含 responses 数组/);
    });
});

describe("normalizeEntry", () => {
    it("字符串条目等价于 content", () => {
        const entry = normalizeEntry("你好", "t", DEFAULTS);
        expect(entry.message).toEqual({ role: "assistant", content: "你好" });
        expect(entry.finishReason).toBe("stop");
        expect(entry.usage).toBeNull();
    });

    it("message 字符串与 message 对象都可", () => {
        expect(normalizeEntry({ message: "hi" }, "t", DEFAULTS).message.content).toBe("hi");
        expect(
            normalizeEntry({ message: { content: "hi" }, finish_reason: "length" }, "t", DEFAULTS)
                .finishReason,
        ).toBe("length");
    });

    it("content 与 tool_calls 直铺，finish_reason 缺省推导为 tool_calls", () => {
        const entry = normalizeEntry(
            {
                content: null,
                tool_calls: [
                    { id: "call_1", function: { name: "read_file", arguments: { path: "a.md" } } },
                ],
            },
            "t",
            DEFAULTS,
        );
        expect(entry.finishReason).toBe("tool_calls");
        expect(entry.message.tool_calls?.[0]?.function.arguments).toBe('{"path":"a.md"}');
    });

    it("tool_calls 缺省 id 时自动补一个", () => {
        const entry = normalizeEntry(
            { tool_calls: [{ function: { name: "f", arguments: "{}" } }] },
            "t",
            DEFAULTS,
        );
        expect(entry.message.tool_calls?.[0]?.id).toBe("call_mock_1");
    });

    it("完整 chat.completion 形态透传 id / created / model / usage", () => {
        const entry = normalizeEntry(
            {
                id: "chatcmpl-x",
                created: 123,
                model: "gpt-mock",
                choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            },
            "t",
            DEFAULTS,
        );
        expect(entry.id).toBe("chatcmpl-x");
        expect(entry.created).toBe(123);
        expect(entry.model).toBe("gpt-mock");
        expect(entry.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    });

    it("条目节奏覆盖 defaults", () => {
        const entry = normalizeEntry(
            { content: "x", delayMs: 30, chunkSize: 3 },
            "t",
            { delayMs: 5, chunkDelayMs: 7, chunkSize: 1 },
        );
        expect(entry.delayMs).toBe(30);
        expect(entry.chunkDelayMs).toBe(7);
        expect(entry.chunkSize).toBe(3);
    });

    it("非法条目抛出可定位的错误", () => {
        expect(() => normalizeEntry({}, "t: responses[0]", DEFAULTS)).toThrow(
            /t: responses\[0\]: message 至少要提供/,
        );
        expect(() =>
            normalizeEntry({ choices: [] }, "t", DEFAULTS),
        ).toThrow(/choices 必须恰好包含 1 个元素/);
        expect(() => normalizeEntry({ content: "x", chunkSize: 0 }, "t", DEFAULTS)).toThrow(
            /chunkSize 必须 >= 1/,
        );
        expect(() =>
            normalizeEntry({ message: { role: "user", content: "x" } }, "t", DEFAULTS),
        ).toThrow(/role 只能是 assistant/);
        expect(() =>
            normalizeEntry({ tool_calls: [{ function: { arguments: "{}" } }] }, "t", DEFAULTS),
        ).toThrow(/缺少 function\.name/);
        expect(() => normalizeEntry({ content: "x", delayMs: -1 }, "t", DEFAULTS)).toThrow(
            /delayMs 必须是非负数字/,
        );
    });
});

describe("ScriptPlayer", () => {
    function player(
        policy: ExhaustedPolicy = "error",
        configDefaults: { delayMs?: number } = {},
    ) {
        return new ScriptPlayer(
            {
                responses: [{ content: "a" }, { content: "b" }, { content: "c" }],
                defaults: { delayMs: 50 },
            },
            { policy, source: "test.json", configDefaults },
        );
    }

    const texts = (p: ScriptPlayer) => p.take()?.message.content;

    it("按顺序推进游标", () => {
        const p = player();
        expect(p.status()).toMatchObject({ firstRequestAt: null, lastRequestAt: null });
        expect([texts(p), texts(p), texts(p)]).toEqual(["a", "b", "c"]);
        expect(p.status()).toMatchObject({
            size: 3,
            index: 3,
            remaining: 0,
            exhausted: true,
            requests: 3,
        });
        // 首/末次请求的时刻都要落在这次调用区间内，压测靠它把端到端时长拆成三段。
        const status = p.status();
        const now = Date.now();
        expect(status.firstRequestAt).toBeGreaterThan(0);
        expect(status.lastRequestAt).toBeGreaterThanOrEqual(status.firstRequestAt!);
        expect(status.lastRequestAt).toBeLessThanOrEqual(now);
    });

    it("耗尽的四种策略", () => {
        const error = player("error");
        error.take();
        error.take();
        error.take();
        expect(error.take()).toBeNull();

        const hold = player("hold");
        hold.take();
        hold.take();
        hold.take();
        expect(texts(hold)).toBe("c");
        expect(hold.status().index).toBe(3);

        const loop = player("loop");
        loop.take();
        loop.take();
        loop.take();
        expect(texts(loop)).toBe("a");
        expect(loop.status().index).toBe(1);
    });

    it("stop 策略：耗尽后给出可收尾的纯文本，游标不再推进", () => {
        const p = player("stop");
        p.take();
        p.take();
        p.take();
        for (let i = 0; i < 3; i += 1) {
            const end = p.take();
            expect(end?.message.content).toBe(STOP_MESSAGE);
            expect(end?.message.tool_calls).toBeUndefined();
            expect(end?.finishReason).toBe("stop");
            // 收尾响应不参与剧本节奏：不引入额外等待。
            expect(end?.delayMs).toBe(0);
            expect(end?.chunkDelayMs).toBe(0);
        }
        expect(p.status()).toMatchObject({
            index: 3,
            remaining: 0,
            exhausted: true,
            // 6 次 take()：3 次消费剧本 + 3 次取收尾响应，请求数都要记上。
            requests: 6,
        });
    });

    it("显式配置的节奏优先于脚本 defaults", () => {
        expect(player("error", { delayMs: 10 }).take()?.delayMs).toBe(10);
        expect(player().take()?.delayMs).toBe(50);
    });

    it("reset 支持跳转并校验越界", () => {
        const p = player();
        p.take();
        p.reset(2);
        expect(texts(p)).toBe("c");
        p.reset(3); // 等于 size：等价于耗尽
        expect(p.take()).toBeNull();
        expect(() => p.reset(4)).toThrow(/index 必须在 0\.\.3 之间/);
        expect(() => p.reset(-1)).toThrow(/index 必须在/);
    });

    it("reload 重新读取文件并重置游标", () => {
        const dir = mkdtempSync(join(tmpdir(), "llm-mock-script-"));
        const file = join(dir, "script.json");
        writeFileSync(file, JSON.stringify([{ content: "first" }]), "utf-8");

        const p = ScriptPlayer.fromFile(file, { policy: "error" });
        expect(p.take()?.message.content).toBe("first");
        expect(p.take()).toBeNull();

        writeFileSync(file, JSON.stringify([{ content: "second" }, { content: "third" }]), "utf-8");
        p.reload();
        expect(p.status()).toMatchObject({ size: 2, index: 0, exhausted: false });
        expect(p.take()?.message.content).toBe("second");
    });

    it("文件不存在时给出清晰错误", () => {
        expect(() => ScriptPlayer.fromFile("/nonexistent/script.json", { policy: "error" })).toThrow(
            /脚本文件读取失败/,
        );
    });
});
