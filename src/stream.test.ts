import { describe, expect, it } from "bun:test";
import { normalizeEntry, type ScriptResponse } from "./script";
import {
    estimateTokens,
    messagesValue,
    resolveUsage,
    splitGraphemes,
    streamChunks,
    toCompletion,
} from "./stream";
import type { ChatCompletionChunk } from "./types";

const META = { id: "chatcmpl-test", created: 1_700_000_000, model: "test-model" };
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
        includeUsage?: boolean;
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
        signal?: AbortSignal;
        prompt?: unknown;
    } = {},
): Promise<ChatCompletionChunk[]> {
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of streamChunks(response, META, {
        includeUsage: options.includeUsage ?? false,
        sleep: options.sleep ?? (async () => {}),
        signal: options.signal,
        prompt: options.prompt,
    })) {
        chunks.push(chunk);
    }
    return chunks;
}

const deltas = (chunks: ChatCompletionChunk[]) => chunks.map((c) => c.choices[0]?.delta);

describe("splitGraphemes", () => {
    it("按 grapheme 切分，不拆坏 emoji 与组合字符", () => {
        expect(splitGraphemes("你好", 1)).toEqual(["你", "好"]);
        expect(splitGraphemes("👨‍👩‍👧x", 1)).toEqual(["👨‍👩‍👧", "x"]);
        expect(splitGraphemes("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
        expect(splitGraphemes("abc", 10)).toEqual(["abc"]);
        expect(splitGraphemes("", 1)).toEqual([]);
    });
});

describe("estimateTokens / messagesValue / resolveUsage", () => {
    it("CJK 按字计，其余按 4 字符 1 token 向上取整", () => {
        expect(estimateTokens("")).toBe(0);
        expect(estimateTokens("abcd")).toBe(1);
        expect(estimateTokens("abcde")).toBe(2);
        expect(estimateTokens("你好")).toBe(2);
        expect(estimateTokens("你好abcd")).toBe(3);
        expect(estimateTokens(null)).toBe(0);
        expect(estimateTokens(42)).toBe(0);
    });

    it("递归遍历对象与数组里的字符串值", () => {
        expect(estimateTokens({ content: "abcd", tool_calls: [{ name: "你好" }] })).toBe(3);
    });

    it("messagesValue 只保留 content 与 tool_calls", () => {
        expect(messagesValue([{ role: "user", content: "你好" }])).toEqual([["你好", undefined]]);
        expect(messagesValue("not-an-array")).toBe("not-an-array");
        expect(estimateTokens(messagesValue([{ role: "user", content: "你好" }]))).toBe(2);
    });

    it("usage：脚本声明优先，未声明时按 prompt 与内容估算", () => {
        const declared = entry({
            content: "hi",
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        });
        expect(resolveUsage(declared, "你好")).toEqual({
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
        });

        expect(resolveUsage(entry({ content: "abcd" }), "你好")).toEqual({
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
        });
    });

    it("tool_calls 只计函数名与参数，不计 id 与 type", () => {
        const response = entry({
            tool_calls: [{ function: { name: "f", arguments: "{}" } }],
        });
        // 只累计 name "f" 与 arguments "{}" 共 3 个非 CJK 字符 → 1 token；
        // 若把 id（call_mock_1）与 type（function）也算进去会明显偏大。
        expect(resolveUsage(response, null).completion_tokens).toBe(1);
    });
});

describe("toCompletion", () => {
    it("构造完整非流式响应，usage 按 prompt 与内容估算", () => {
        const completion = toCompletion(
            entry({ content: "hi" }),
            META,
            messagesValue([{ role: "user", content: "你好" }]),
        );
        expect(completion).toMatchObject({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1_700_000_000,
            model: "test-model",
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        });
        expect(completion.choices).toEqual([
            {
                index: 0,
                message: { role: "assistant", content: "hi" },
                finish_reason: "stop",
                logprobs: null,
            },
        ]);
    });
});

describe("streamChunks", () => {
    it("文本：首包 role、逐字 content、末包 finish_reason", async () => {
        const chunks = await collect(entry({ content: "你好" }));
        expect(deltas(chunks)).toEqual([
            { role: "assistant", content: "" },
            { content: "你" },
            { content: "好" },
            {},
        ]);
        expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe("stop");
        expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    });

    it("tool_calls：首个分片带 id/name，随后补 arguments 片段", async () => {
        const chunks = await collect(
            entry({
                tool_calls: [
                    {
                        id: "call_1",
                        function: { name: "read_file", arguments: { path: "a.md" } },
                    },
                ],
            }),
        );
        expect(deltas(chunks)[0]).toEqual({ role: "assistant", content: "" });
        expect(deltas(chunks)[1]).toEqual({
            tool_calls: [
                {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: "" },
                },
            ],
        });
        const args = deltas(chunks)
            .slice(2, -1)
            .map((d) => d.tool_calls?.[0]?.function?.arguments ?? "")
            .join("");
        expect(args).toBe('{"path":"a.md"}');
        expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe("tool_calls");
    });

    it("多个 tool_call 用各自 index 区分", async () => {
        const chunks = await collect(
            entry({
                tool_calls: [
                    { id: "c1", function: { name: "a", arguments: "{}" } },
                    { id: "c2", function: { name: "b", arguments: "{}" } },
                ],
            }),
        );
        const starts = chunks.filter((c) => c.choices[0]?.delta.tool_calls?.[0]?.id);
        expect(starts.map((c) => c.choices[0]!.delta.tool_calls![0]!.index)).toEqual([0, 1]);
    });

    it("chunkSize 控制分片大小", async () => {
        const chunks = await collect(
            normalizeEntry({ content: "abcdef" }, "test", { ...DEFAULTS, chunkSize: 3 }),
        );
        expect(deltas(chunks)).toEqual([
            { role: "assistant", content: "" },
            { content: "abc" },
            { content: "def" },
            {},
        ]);
    });

    it("节奏：首包前 delayMs，每个分片前 chunkDelayMs", async () => {
        const { calls, sleep } = recordingSleep();
        await collect(entry({ content: "ab", delayMs: 100, chunkDelayMs: 5 }), { sleep });
        expect(calls).toEqual([100, 5, 5]);
    });

    it("includeUsage 时追加 choices 为空的 usage chunk", async () => {
        const chunks = await collect(
            entry({ content: "x", usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
            { includeUsage: true },
        );
        const last = chunks.at(-1)!;
        expect(last.choices).toEqual([]);
        expect(last.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
    });

    it("includeUsage 为 false 时不产出 usage chunk", async () => {
        const chunks = await collect(entry({ content: "x" }));
        expect(chunks.some((c) => c.usage !== undefined)).toBe(false);
    });

    it("空 content 只产出首包与末包", async () => {
        const chunks = await collect(entry({ content: "" }));
        expect(deltas(chunks)).toEqual([{ role: "assistant", content: "" }, {}]);
    });

    it("signal 已中断时不产出任何 chunk", async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await collect(entry({ content: "x" }), { signal: controller.signal })).toEqual([]);
    });
});
