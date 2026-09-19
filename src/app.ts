/**
 * HTTP 路由：OpenAI 兼容端点 + /__mock 控制端点。
 *
 *   POST /v1/chat/completions      第 i 次请求返回脚本第 i 条；stream 时转成 SSE
 *   GET  /v1/models                返回配置的模型名（部分客户端启动时会探测）
 *   GET  /__mock/status            当前游标与脚本信息
 *   POST /__mock/reset[?index=N]   重置游标
 *   POST /__mock/reload            重新读取脚本文件并重置游标
 *
 * 不校验 Authorization：mock 的职责是按脚本回放，鉴权由真实链路负责。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { MockConfig } from "./config";
import type { ScriptPlayer, ScriptResponse } from "./script";
import {
    messagesValue,
    realSleep,
    streamChunks,
    toCompletion,
    type ResponseMeta,
    type SleepFn,
} from "./stream";
import type { ChatCompletionRequest, ErrorBody } from "./types";

export interface AppDeps {
    player: ScriptPlayer;
    config: MockConfig;
    /** 测试可注入假 sleep，消除真实等待。 */
    sleep?: SleepFn;
    /** 时间源，测试可固定 created。 */
    now?: () => number;
    /** 访问日志；测试可传空实现消音。 */
    log?: (line: string) => void;
}

/** 请求摘要：观察是谁在消费脚本（调试集成时尤其有用）。 */
function describeRequest(request: ChatCompletionRequest): string {
    const parts = [
        `stream=${request.stream === true}`,
        `model=${typeof request.model === "string" ? request.model : "-"}`,
    ];
    const messages = request.messages;
    if (Array.isArray(messages)) {
        parts.push(`messages=${messages.length}`);
        const last = messages[messages.length - 1];
        if (isPlainObject(last)) {
            const role = typeof last.role === "string" ? last.role : "?";
            const content = last.content;
            const preview =
                typeof content === "string"
                    ? content.replace(/\s+/g, " ").slice(0, 60)
                    : Array.isArray(content)
                      ? `[${content.length} parts]`
                      : "";
            parts.push(`last=${role}${preview === "" ? "" : `:"${preview}"`}`);
        }
    }
    return parts.join(" ");
}

let idCounter = 0;

function nextId(): string {
    idCounter += 1;
    return `chatcmpl-mock-${idCounter}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorJson(
    c: Context,
    status: ContentfulStatusCode,
    message: string,
    type: string,
    code: string,
): Response {
    const body: ErrorBody = { error: { message, type, code } };
    return c.json(body, status);
}

function sseStream(
    entry: ScriptResponse,
    meta: ResponseMeta,
    options: { includeUsage: boolean; sleep: SleepFn; signal?: AbortSignal; prompt: unknown },
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    const upstream = options.signal;
    if (upstream?.aborted) abort.abort();
    else upstream?.addEventListener("abort", () => abort.abort(), { once: true });

    const frame = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const chunk of streamChunks(entry, meta, {
                    includeUsage: options.includeUsage,
                    sleep: options.sleep,
                    signal: abort.signal,
                    prompt: options.prompt,
                })) {
                    controller.enqueue(frame(chunk));
                }
                if (!abort.signal.aborted) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
                controller.close();
            } catch (error) {
                try {
                    controller.error(error);
                } catch {
                    // 客户端已断开、流已被取消：无需再报错。
                }
            }
        },
        cancel() {
            abort.abort();
        },
    });
}

export function createApp(deps: AppDeps): Hono {
    const { player, config } = deps;
    const sleep = deps.sleep ?? realSleep;
    const now = deps.now ?? Date.now;
    const log = deps.log ?? ((line: string) => console.log(line));
    const app = new Hono();

    app.use("*", cors());

    const chat = async (c: Context): Promise<Response> => {
        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return errorJson(c, 400, "请求体不是合法 JSON", "invalid_request_error", "invalid_json");
        }
        if (!isPlainObject(body)) {
            return errorJson(c, 400, "请求体必须是 JSON 对象", "invalid_request_error", "invalid_body");
        }
        const request = body as ChatCompletionRequest;

        // 取号发生在响应开始之前：即使流被中途取消，该脚本条目也已消费。
        const entry = player.take();
        if (entry === null) {
            const status = player.status();
            log(`[llm-mock] ${describeRequest(request)} → 脚本已耗尽`);
            return errorJson(
                c,
                500,
                `脚本已耗尽（${status.size} 条全部消费，来源 ${status.source}）：` +
                    "POST /__mock/reset 可重置游标，或用 --exhausted hold|loop 改变耗尽策略",
                "mock_script_exhausted",
                "script_exhausted",
            );
        }

        const meta: ResponseMeta = {
            id: entry.id ?? nextId(),
            created: entry.created ?? Math.floor(now() / 1000),
            model: entry.model ?? request.model ?? config.model,
        };
        log(`[llm-mock] ${describeRequest(request)} → 消费第 ${player.status().index} 条`);
        // 脚本未声明 usage 时按请求与内容估算，保留真实响应里该有的 token 语义。
        const prompt = messagesValue(body.messages ?? body);

        if (request.stream !== true) {
            await sleep(entry.delayMs, c.req.raw.signal);
            return c.json(toCompletion(entry, meta, prompt));
        }

        const includeUsage = request.stream_options?.include_usage === true;
        return new Response(
            sseStream(entry, meta, {
                includeUsage,
                sleep,
                signal: c.req.raw.signal,
                prompt,
            }),
            {
                headers: {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-cache, no-transform",
                    "x-accel-buffering": "no",
                },
            },
        );
    };

    app.post("/v1/chat/completions", chat);
    // 部分客户端的 base_url 不带 /v1。
    app.post("/chat/completions", chat);

    const models = (c: Context) =>
        c.json({
            object: "list",
            data: [{ id: config.model, object: "model", created: 0, owned_by: "llm-mock" }],
        });
    app.get("/v1/models", models);
    app.get("/models", models);

    app.get("/__mock/status", (c) => c.json(player.status()));

    app.post("/__mock/reset", (c) => {
        const raw = c.req.query("index");
        const index = raw === undefined ? 0 : Number(raw);
        try {
            player.reset(index);
        } catch (error) {
            return errorJson(c, 400, (error as Error).message, "invalid_request_error", "invalid_index");
        }
        return c.json(player.status());
    });

    app.post("/__mock/reload", (c) => {
        try {
            player.reload();
        } catch (error) {
            return errorJson(c, 500, (error as Error).message, "mock_script_error", "reload_failed");
        }
        return c.json(player.status());
    });

    app.notFound((c) =>
        errorJson(c, 404, `未知路径 ${c.req.path}`, "invalid_request_error", "not_found"),
    );

    return app;
}
