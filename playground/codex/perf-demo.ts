#!/usr/bin/env bun
/**
 * Codex 压测 demo —— 在 playground/codex 目录里直接启动一次 codex exec 压测。
 *
 *   cd playground/codex
 *   bun perf-demo.ts --timeout-ms 20000 --port 3462   # 起 mock → 起 codex → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - harness 命令是 `codex exec --skip-git-repo-check -s read-only --ephemeral <prompt>`：
 *   exec 是非交互入口，read-only 沙盒保证剧本里的命令只读，--ephemeral 不往沙盒里堆 session 文件；
 * - 隔离靠 **CODEX_HOME**（本目录下的 .codex/，每次启动把 config.toml 覆盖进去）：
 *   用户全局的 ~/.codex/config.toml 挂着 hooks 与别的 provider，被读到就压不到本 mock；
 * - 端口用命令行覆盖 `-c model_providers.llm-mock.base_url=…`，换 --port 不用改沙盒 config.toml；
 * - 默认剧本是 scripts/codex-scenario.json（peri 的 perf-scenario.json 里是 Bash 工具调用，
 *   codex 不认这个工具名），要换剧本显式传 --script；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承
 *   （实测，见 scripts/perf/run.ts 的 RunDeps.harnessEnv 注释），而 harness 是 run.ts 起的。
 *
 * 产物：<仓库>/data/claude-date/<runId>-{perf.log,samples.csv,harness.log,mock.log}
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 沙盒 CODEX_HOME：codex 的配置与会话状态都落在这里，不碰 ~/.codex。 */
const SANDBOX = join(import.meta.dir, ".codex");
const CONFIG_SRC = join(import.meta.dir, "config.toml");

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 Codex 版 demo，harness 命令固定为 `codex exec --skip-git-repo-check -s read-only --ephemeral <prompt>`；");
    console.log(`      CODEX_HOME 指向 ${SANDBOX}（每次启动用本目录的 config.toml 覆盖），不碰 ~/.codex 的 hooks 与 provider。`);
    console.log("      默认剧本是 scripts/codex-scenario.json（exec 工具调用，配 --exhausted loop 持续供压）。");
    console.log("      想看能自行收尾的完整工具循环（三轮调用后打印回答），用：");
    console.log("        bun perf-demo.ts --script playground/codex/script.json --exhausted hold");
    process.exit(EXIT_OK);
}

/** 把沙盒配置同步进 CODEX_HOME：每次都覆盖，改了 config.toml 立即生效。 */
function prepareSandbox(): void {
    mkdirSync(SANDBOX, { recursive: true });
    copyFileSync(CONFIG_SRC, join(SANDBOX, "config.toml"));
}

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - CODEX_HOME：配置与状态都指到沙盒；
 * - LLM_MOCK_API_KEY：沙盒 config.toml 里 env_key 指的就是它，mock 不校验鉴权，
 *   但变量缺了 codex 会直接报「Missing environment variable」。
 */
function sandboxEnv(): Record<string, string> {
    return {
        CODEX_HOME: SANDBOX,
        LLM_MOCK_API_KEY: "mock-key",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT);

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 codex 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    // 默认剧本：codex 认的工具名/形状与 peri、opencode 都不同，默认值不能沿用它俩的。
    if (!argv.some((arg) => arg === "--script" || arg.startsWith("--script="))) {
        config.scriptPath = resolve(REPO_ROOT, "scripts/codex-scenario.json");
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 codex。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const codexBin = explicitBin ? config.periPath : Bun.which("codex");
    if (codexBin === null) {
        throw new Error("PATH 里找不到 codex，可显式传 --peri <path>");
    }

    prepareSandbox();

    process.exitCode = await runPerf(config, {
        harnessEnv: () => sandboxEnv(),
        harnessCommand: (cfg: PerfConfig) => [
            codexBin,
            "exec",
            // 工作目录不是 git 仓库时才需要，留着让沙盒目录可以随便挪。
            "--skip-git-repo-check",
            // 只读沙盒：压测用的剧本都是只读命令，不该有写盘副作用。
            "-s",
            "read-only",
            // 不落 session 文件，沙盒里不会越压越多。
            "--ephemeral",
            // 端口覆盖：沙盒 config.toml 里写的是默认端口，--port 换端口靠这行生效。
            "-c",
            `model_providers.llm-mock.base_url=http://127.0.0.1:${cfg.port}/v1`,
            cfg.prompt,
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
