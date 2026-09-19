#!/usr/bin/env bun
/**
 * llm-mock 压测 demo —— 在 playground/peri 目录里直接启动一次 harness 压测。
 *
 *   cd playground/peri
 *   bun perf-demo.ts                      # 起 mock → 起 peri → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run.json），
 *                                         # 剧本走完 harness 自行退出，测到的是端到端时长
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 完全一致
 *   bun perf-demo.ts --help
 *
 * peri 的 provider 配置：3.17 起**不再读 `{cwd}/.peri/settings.json`**（那是旧版行为），
 * 只认 `~/.peri/settings.json` 或 `--settings <文件|JSON 字符串>`。demo 因此在运行时用
 * `--settings` 传一段 JSON（provider 指向本 mock 的实际端口），不去动用户的全局配置；
 * 同目录的 `.peri/settings.json` 保留为同结构的手工参考。
 *
 * 产物：<仓库>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { join, resolve } from "node:path";
import { REPO_ROOT, loadPerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 用户显式给了某个选项就不再插手（下面按各家默认值补的那些项都这么判断）。 */
const given = (name: string): boolean =>
    argv.some((arg) => arg === name || arg.startsWith(`${name}=`));

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log(`提示: 本 demo 与 run.ts 参数一致，相对路径按仓库根（${REPO_ROOT}）解析，`);
    console.log("      产物落在 data/runs/<harness>/<runId>/（run.json 是机器接口）。");
    console.log("      默认剧本是 data/scenarios/long-run.json（长剧本，Bash 工具调用，");
    console.log("      peri / opencode / Claude Code 共用这一份），--exhausted 默认 stop。");
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
    // 产物目录的身份：`data/runs/<harness>/<runId>/`。不给也能从启动命令推断，
    // 但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "peri";
    }

    // 默认剧本：长剧本生成器用 Bash 形状造的那份（peri / opencode / Claude Code 共用）。
    // run.ts 的 --script 是必填，默认值因此得由各家 demo 自己带。
    if (!given("--script")) config.scriptPath = resolve(REPO_ROOT, "data/scenarios/long-run.json");
    // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长；loop 会一直供压
    // 到兜底超时，那是已经废弃的固定窗口口径。
    if (!given("--exhausted")) config.exhausted = "stop";
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
