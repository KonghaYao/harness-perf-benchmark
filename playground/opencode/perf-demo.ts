#!/usr/bin/env bun
/**
 * opencode 压测 demo —— 在 playground/opencode 目录里直接启动一次 opencode 压测。
 *
 *   cd playground/opencode
 *   bun perf-demo.ts                      # 起 mock → 起 opencode run → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 一致
 *   bun perf-demo.ts --help
 *
 * 与 peri 版 demo 的差异：
 * - harness 命令是 `opencode run "<prompt>" --model llm-mock/llm-mock --pure`
 *   （`--pure` 跳过全局插件；模型指向本目录 opencode.json 里定义的 mock provider，
 *   该配置随 cwd 生效，所以压测也必须在这个目录启动 opencode）；
 * - 用 XDG_* 把 opencode 的数据/状态/缓存隔离到本目录下的 .data/.state/.cache，
 *   不碰 ~/.local/share/opencode；变量经 run.ts 的 `deps.harnessEnv` 注入
 *   （**不要用 `process.env.X = …`**：Bun 1.4 的 `Bun.spawn` 不传 env 时用的是进程启动时的
 *   环境快照，运行时改动不会传给子进程——这里曾经因此静默失效）。
 *
 * 产物：<仓库>/data/claude-date/<runId>-{perf.log,samples.csv,harness.log,mock.log}
 */
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 opencode 版 demo，harness 命令固定为 `opencode run ... --pure`；");
    console.log(`      数据/状态/缓存隔离在 ${import.meta.dir} 下的 .data/.state/.cache。`);
    process.exit(EXIT_OK);
}

/** opencode 的沙盒目录（数据/状态/缓存）与 mock 地址，经 run.ts 的 harnessEnv 注入子进程。 */
function sandboxEnv(port: number): Record<string, string> {
    return {
        XDG_DATA_HOME: join(import.meta.dir, ".data"),
        XDG_STATE_HOME: join(import.meta.dir, ".state"),
        XDG_CACHE_HOME: join(import.meta.dir, ".cache"),
        // 本目录的 opencode.json 把 provider baseURL 写成 `{env:LLM_MOCK_BASE_URL}`，
        // 这样换端口不用改配置文件（opencode 支持 {env:…} 变量替换）。
        LLM_MOCK_BASE_URL: `http://127.0.0.1:${port}/v1`,
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT);

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 opencode 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 opencode。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const opencodeBin = explicitBin ? config.periPath : Bun.which("opencode");
    if (opencodeBin === null) {
        throw new Error("PATH 里找不到 opencode，可显式传 --peri <path>");
    }

    process.exitCode = await runPerf(config, {
        harnessEnv: (cfg: PerfConfig) => sandboxEnv(cfg.port),
        harnessCommand: (cfg: PerfConfig) => [
            opencodeBin,
            "run",
            cfg.prompt,
            "--model",
            "llm-mock/llm-mock",
            "--pure",
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
