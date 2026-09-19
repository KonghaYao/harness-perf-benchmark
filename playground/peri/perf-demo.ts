#!/usr/bin/env bun
/**
 * llm-mock 压测 demo —— 在 playground/peri 目录里直接启动一次 harness 压测。
 *
 *   cd playground/peri
 *   bun perf-demo.ts                      # 起 mock → 起 peri → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 完全一致
 *   bun perf-demo.ts --help
 *
 * peri 的 provider 配置：3.17 起**不再读 `{cwd}/.peri/settings.json`**（那是旧版行为），
 * 只认 `~/.peri/settings.json` 或 `--settings <文件|JSON 字符串>`。demo 因此在运行时用
 * `--settings` 传一段 JSON（provider 指向本 mock 的实际端口），不去动用户的全局配置；
 * 同目录的 `.peri/settings.json` 保留为同结构的手工参考。
 *
 * 产物：<仓库>/data/claude-date/<runId>-{perf.log,samples.csv,harness.log,mock.log}
 */
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log(`提示: 本 demo 与 run.ts 参数一致，相对路径按仓库根（${REPO_ROOT}）解析，`);
    console.log("      默认产物目录为 data/claude-date/。");
    process.exit(EXIT_OK);
}

/** peri 的沙盒 settings：provider 指向本次 mock 的端口，别名全映射到 llm-mock 模型。 */
function sandboxSettings(port: number): string {
    const models = { fable: "llm-mock", opus: "llm-mock", sonnet: "llm-mock", haiku: "llm-mock" };
    return JSON.stringify({
        config: {
            active_alias: "sonnet",
            providers: [
                {
                    id: "llm-mock",
                    type: "openai",
                    apiKey: "mock-key",
                    baseUrl: `http://127.0.0.1:${port}/v1`,
                    models,
                },
            ],
            profiles: Object.fromEntries(
                Object.keys(models).map((alias) => [
                    alias,
                    { provider: "llm-mock", model: "llm-mock", effort: "low" },
                ]),
            ),
        },
    });
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT);
    // 全局会话库 ~/.peri/threads/threads.db 里 playground/peri 的 workspace 快照已过期，
    // 直接启动 peri 会报 "workspace identity changed"；demo 默认换用沙盒内的独立库。
    // 想指定别的库：自行传 --peri-arg=--db-path --peri-arg=<path>。
    const userArgs = argv.filter((arg) => arg.startsWith("--peri-arg"));
    if (!userArgs.some((arg) => arg.includes("db-path"))) {
        config.periArgs.push("--db-path", join(import.meta.dir, ".peri/perf-threads.db"));
    }
    if (!userArgs.some((arg) => arg.includes("settings"))) {
        config.periArgs.push("--settings", sandboxSettings(config.port));
    }
    process.exitCode = await runPerf(config);
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
