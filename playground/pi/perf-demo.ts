#!/usr/bin/env bun
/**
 * pi 压测 demo —— 在 playground/pi 目录里直接启动一次 pi -p 压测。
 *
 *   cd playground/pi
 *   bun perf-demo.ts                      # 起 mock → 起 pi -p → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 一致
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - harness 命令是 `pi -p "<prompt>" --model llm-mock/llm-mock --no-session --no-extensions`：
 *   pi 没有权限确认弹窗（设计上就不含 permission popups），所以没有 claude-code 那样的
 *   --dangerously-skip-permissions；剧本请自觉只放只读命令；
 * - 隔离靠 **PI_CODING_AGENT_DIR**（本目录下的 .pi-agent/）：pi 的配置、凭据、trust 记录、
 *   extensions 全从这里找，指到沙盒就不会读 ~/.pi/agent（里面有用户自己的 extensions 与登录态）；
 * - 沙盒 models.json **每次启动由本文件生成**：读同目录的 models.json（人读的源文件，
 *   baseUrl 写的是默认端口），只把 provider 的 baseUrl 换成本次端口再写进沙盒。pi 的 models.json
 *   只对 apiKey / headers 做 `$VAR` 插值（0.85.1 实测），baseUrl 不吃环境变量，换端口只能改文件；
 * - 默认剧本是 data/scenarios/long-run-pi.json：pi 的内建工具名全小写（bash 而非 peri 的 Bash），
 *   照抄 peri 那份长剧本（`--tool Bash`）会被 pi 当成未知工具；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承
 *   （实测，见 scripts/perf/run.ts 的 RunDeps.harnessEnv 注释），而 harness 是 run.ts 起的。
 *
 * 注意：工作目录是沙盒，但 pi 会向上找到仓库根的 CLAUDE.md 当上下文文件，每次请求都带上（属预期，
 * 与 Claude Code 相同；想关掉给 harness 加 --no-context-files）。
 *
 * 产物：<仓库>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 沙盒 PI_CODING_AGENT_DIR：配置与状态都落在这里，不碰 ~/.pi/agent。 */
const SANDBOX = join(import.meta.dir, ".pi-agent");
/** 人读的 provider 源配置；每次启动经 prepareSandbox 换端口后写进沙盒。 */
const MODELS_SRC = join(import.meta.dir, "models.json");
/** provider 与模型同名，`--model` 要写 `provider/id` 才能绕开 pi 的默认 provider（google）。 */
const PROVIDER = "llm-mock";
const MODEL = `${PROVIDER}/llm-mock`;

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 pi 版 demo，harness 命令固定为 `pi -p <prompt> --model llm-mock/llm-mock --no-session --no-extensions`；");
    console.log(`      PI_CODING_AGENT_DIR 指向 ${SANDBOX}（每次启动用本目录的 models.json 换端口后覆盖），不碰 ~/.pi/agent。`);
    console.log("      默认剧本是 data/scenarios/long-run-pi.json（bash 工具调用，--exhausted 默认 stop）。");
    console.log("      想看能自行收尾的完整工具循环（三轮调用后打印回答），用：");
    console.log("        bun perf-demo.ts --script playground/pi/script.json --exhausted hold");
    process.exit(EXIT_OK);
}

/** models.json 里我们关心的部分：只改 provider 的 baseUrl，其余字段原样保留。 */
interface ModelsFile {
    providers: Record<string, { baseUrl?: string }>;
}

/**
 * 把沙盒配置同步进 PI_CODING_AGENT_DIR：每次都覆盖，改了 models.json 立即生效。
 * 只替换 baseUrl 一个字段，源文件保持人类可读、可手工加模型。
 */
function prepareSandbox(port: number): void {
    const models = JSON.parse(readFileSync(MODELS_SRC, "utf8")) as ModelsFile;
    const provider = models.providers[PROVIDER];
    if (provider === undefined) {
        throw new Error(`${MODELS_SRC} 里没有 providers.${PROVIDER}`);
    }
    provider.baseUrl = `http://127.0.0.1:${port}/v1`;
    mkdirSync(SANDBOX, { recursive: true });
    writeFileSync(join(SANDBOX, "models.json"), `${JSON.stringify(models, null, 4)}\n`);
}

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - PI_CODING_AGENT_DIR：配置目录（models.json / auth / trust / extensions）指到沙盒；
 * - PI_OFFLINE：关掉启动时的联网（更新检查、包更新、遥测）——压测不该掺外部流量；
 * - PI_TELEMETRY：显式关掉安装/更新遥测与 provider attribution 头。
 */
function sandboxEnv(): Record<string, string> {
    return {
        PI_CODING_AGENT_DIR: SANDBOX,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        // 默认剧本：pi 的工具名与 peri / opencode / Claude Code 都不同（bash 小写），不能沿用它们那份。
        // 必须在**解析时**交出去：--script 的必填校验发生在解析里（见 PerfConfigDefaults）。
        scriptPath: "data/scenarios/long-run-pi.json",
    });

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 pi 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    // 产物目录的身份：`data/runs/<harness>/<runId>/`。不给也能从启动命令推断，
    // 但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "pi";
    }

    // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长；loop 会一直供压
    // 到兜底超时，那是已经废弃的固定窗口口径。
    if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
        config.exhausted = "stop";
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 pi（npm i -g @earendil-works/pi-coding-agent）。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const piBin = explicitBin ? config.periPath : Bun.which("pi");
    if (piBin === null) {
        throw new Error("PATH 里找不到 pi，可装 @earendil-works/pi-coding-agent 或显式传 --peri <path>");
    }

    prepareSandbox(config.port);

    process.exitCode = await runPerf(config, {
        harnessEnv: () => sandboxEnv(),
        harnessCommand: (cfg: PerfConfig) => [
            piBin,
            "-p",
            cfg.prompt,
            // 别名不参与：直接指定 provider/id，免得落到默认 provider（google）。
            "--model",
            MODEL,
            // 不落 session 文件，沙盒里不会越压越多。
            "--no-session",
            // 跳过扩展发现（沙盒里本来就没有，写上保证冷启动可比，同 opencode 的 --pure）。
            "--no-extensions",
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
