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
 * - 默认剧本是 data/scenarios/long-run.json（长剧本生成器用 Bash 形状造的那份，
 *   与 peri / Claude Code 共用），配 `--exhausted stop` 跑到自然结束；
 * - 用 XDG_* 把 opencode 的数据/状态/缓存隔离到本目录下的 .data/.state/.cache，
 *   不碰 ~/.local/share/opencode；变量经 run.ts 的 `deps.harnessEnv` 注入
 *   （**不要用 `process.env.X = …`**：Bun 1.4 的 `Bun.spawn` 不传 env 时用的是进程启动时的
 *   环境快照，运行时改动不会传给子进程——这里曾经因此静默失效）。
 *
 * 产物：<仓库>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { join, resolve } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 用户显式给了某个选项就不再插手（下面按各家默认值补的那些项都这么判断）。 */
const given = (name: string): boolean =>
    argv.some((arg) => arg === name || arg.startsWith(`${name}=`));

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 opencode 版 demo，harness 命令固定为 `opencode run ... --pure`；");
    console.log(`      数据/状态/缓存隔离在 ${import.meta.dir} 下的 .data/.state/.cache。`);
    console.log("      默认剧本是 data/scenarios/long-run.json（长剧本，Bash 工具调用），");
    console.log("      --exhausted 默认 stop。");
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

    // 产物目录的身份：`data/runs/<harness>/<runId>/`。不给也能从启动命令推断，
    // 但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "opencode";
    }

    // 默认剧本：长剧本生成器用 Bash 形状造的那份（opencode 认 Bash，与 peri / Claude Code 共用）。
    // run.ts 的 --script 是必填，默认值因此得由各家 demo 自己带。
    if (!given("--script")) config.scriptPath = resolve(REPO_ROOT, "data/scenarios/long-run.json");
    // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长；loop 会一直供压
    // 到兜底超时，那是已经废弃的固定窗口口径。
    if (!given("--exhausted")) config.exhausted = "stop";

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
