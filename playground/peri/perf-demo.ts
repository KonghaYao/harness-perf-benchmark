#!/usr/bin/env bun
/**
 * llm-mock 压测 demo —— 在 playground/peri 目录里直接启动一次 harness 压测。
 *
 *   cd playground/peri
 *   bun perf-demo.ts                      # 起 mock → 起 peri → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 完全一致
 *   bun perf-demo.ts --help
 *
 * 为什么入口放在这里：peri 的 provider 配置取自 `{cwd}/.peri/settings.json`，
 * 只有 cwd 命中 playground/peri 时才指向本仓库的 mock server；压测器默认就把
 * harness 的工作目录固定为本目录，所以从这里启动即可复现整套流程。
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

try {
    const config = loadPerfConfig(argv, REPO_ROOT);
    // 全局会话库 ~/.peri/threads/threads.db 里 playground/peri 的 workspace 快照已过期，
    // 直接启动 peri 会报 "workspace identity changed"；demo 默认换用沙盒内的独立库。
    // 想指定别的库：自行传 --peri-arg=--db-path --peri-arg=<path>。
    const userPickedDb = argv.some((arg) => arg.startsWith("--peri-arg") && arg.includes("db-path"));
    if (!userPickedDb) {
        config.periArgs.push("--db-path", join(import.meta.dir, ".peri/perf-threads.db"));
    }
    process.exitCode = await runPerf(config);
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
