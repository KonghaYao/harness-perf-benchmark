#!/usr/bin/env bun
/**
 * llm-mock — OpenAI Chat Completions mock 服务
 *
 * 启动时加载脚本（--script 指定，必填），之后第 i 次 chat 请求返回脚本第 i 条响应；
 * stream:true 时把同一条完整响应转换成 OpenAI 规范的 SSE chunk 序列。
 */

import { createApp } from "./app";
import { loadConfig } from "./config";
import { ScriptPlayer } from "./script";

const USAGE = `llm-mock — OpenAI Chat Completions mock 服务

用法:
  bun run src/server.ts --script <path> [选项]

选项:
  --script <path>        脚本文件（必填，亦可用 SCRIPT_PATH）
  --port <n>             监听端口（默认 3457）
  --exhausted <policy>   脚本耗尽后: error | hold | loop（默认 error）
  --model <name>         响应中补全的模型名（默认 llm-mock）
  --delay-ms <n>         首包前延迟毫秒（覆盖脚本 defaults）
  --chunk-delay-ms <n>   流式 chunk 间隔毫秒（覆盖脚本 defaults）
  --chunk-size <n>       每个流式 chunk 的字符数（覆盖脚本 defaults）
  -h, --help             显示本帮助

脚本文件:
  [ {...}, ... ]  或  { "defaults": { "delayMs": 200 }, "responses": [ {...}, ... ] }
  单条响应（按顺序判定）:
    "文本"
    { "message": {...} | "文本", "finish_reason": "stop" }
    { "content": "...", "tool_calls": [{ "id", "function": { "name", "arguments" } }] }
    { "choices": [{ "message": ..., "finish_reason": ... }] }   // 完整 chat.completion
  节奏字段 delayMs / chunkDelayMs / chunkSize 写在条目顶层，覆盖 defaults。
  条目未声明 usage 时按字符估算 token（CJK 按字、其余 4 字符 1 token）；
  需要精确值就在条目里写 usage: { prompt_tokens, completion_tokens, total_tokens }。

端点:
  POST /v1/chat/completions      第 i 次请求返回脚本第 i 条（stream:true 转 SSE）
  GET  /v1/models
  GET  /__mock/status            当前游标与脚本信息
  POST /__mock/reset[?index=N]   重置游标
  POST /__mock/reload            重新读取脚本文件并重置游标
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
}

try {
    const config = loadConfig();
    const player = ScriptPlayer.fromFile(config.scriptPath, {
        policy: config.exhausted,
        configDefaults: {
            delayMs: config.delayMs,
            chunkDelayMs: config.chunkDelayMs,
            chunkSize: config.chunkSize,
        },
    });

    const server = Bun.serve({ port: config.port, fetch: createApp({ player, config }).fetch });
    const status = player.status();

    console.log(`[llm-mock] 监听 ${server.url.origin}`);
    console.log(
        `[llm-mock] 脚本 ${status.source}（${status.size} 条，耗尽策略 ${status.policy}）`,
    );
    console.log("[llm-mock] POST /v1/chat/completions · GET /__mock/status · POST /__mock/reset");
} catch (error) {
    console.error(`[llm-mock] 启动失败: ${(error as Error).message}`);
    process.exit(1);
}
