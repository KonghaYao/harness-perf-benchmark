#!/usr/bin/env bun
/**
 * dsh（DeepSeek Harness）压测 demo —— 在 playground/deepseek 目录里直接启动一次
 * `dsh --profile headless` 压测。
 *
 *   cd playground/deepseek
 *   bun perf-demo.ts                      # 起 mock → 起 dsh → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 一致
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - harness 命令是 `dsh --profile headless "<prompt>"`：headless 是官方的一次性模式
 *   （跑一个任务、把最终回答写到 stdout、退出码 0），不起端口、不留后台进程；
 * - 隔离靠 **DSH_HOME**（本目录下的 .dsh-home/）：profile 树、会话库、storages、
 *   匿名用户 id 全从这里找，指到沙盒就不会读 ~/.dsh；
 * - **provider 全靠环境变量注入，不用生成配置文件**（与 pi / grok 不同）：dsh 内置的
 *   deepseek 适配器认 `$DEEPSEEK_BASE_URL`（优先于默认的 https://api.deepseek.com）与
 *   `$DEEPSEEK_API_KEY`（凭据引用名），换端口只改环境变量；
 * - 线协议是 **OpenAI Chat Completions**（`POST {baseURL}/chat/completions`，stream），
 *   所以 baseURL 要带 /v1；模型 id 是配置里的 `deepseek-flash`，不需要命令行指定；
 * - 权限保持沙盒默认（不设 `DSH_PERMISSION_MODE` = workspace-write + 审批 ask）：实测工作区内的
 *   只读命令直接执行、不需要审批；需要升权的命令在 headless 下无人可批（不会有 flaky 的
 *   自动放行），所以剧本请自觉只放只读命令；
 * - `DSH_TELEMETRY_DISABLED` 关遥测（启动器认这个开关，任何非空值都算关），压测不掺外部流量；
 * - 默认剧本是 scripts/dsh-scenario.json：dsh 的 shell 工具叫 `bash`，参数
 *   `{command, description}` **两个都必填**（缺 description 会被工具自己拒掉）；
 * - 消费规律：一次 prompt = 主请求 + 一条「会话标题生成」请求（同 provider，messages=2），
 *   之后每轮工具调用再各一条主请求——编排剧本要把标题那条算进去；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承
 *   （实测，见 scripts/perf/run.ts 的 RunDeps.harnessEnv 注释），而 harness 是 run.ts 起的。
 *
 * 产物：<仓库>/data/claude-date/<runId>-{perf.log,samples.csv,harness.log,mock.log}
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 沙盒 DSH_HOME：profile 树、会话库、匿名 id 都落在这里，不碰 ~/.dsh。 */
const SANDBOX = join(import.meta.dir, ".dsh-home");

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 dsh 版 demo，harness 命令固定为 `dsh --profile headless <prompt>`；");
    console.log(`      DSH_HOME 指向 ${SANDBOX}，provider 走环境变量（$DEEPSEEK_BASE_URL / $DEEPSEEK_API_KEY，不用改配置文件）。`);
    console.log("      默认剧本是 scripts/dsh-scenario.json（bash 工具调用，配 --exhausted loop 持续供压）。");
    console.log("      想看能自行收尾的完整工具循环（三轮调用后打印回答），用：");
    console.log("        bun perf-demo.ts --script playground/deepseek/script.json --exhausted stop");
    process.exit(EXIT_OK);
}

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - DSH_HOME：配置与状态目录（profile 树 → 会话库）指到沙盒；
 * - DEEPSEEK_BASE_URL：内置 deepseek 适配器的端点，优先于默认的官方地址——按本次端口生成，
 *   换端口不用改任何文件；
 * - DEEPSEEK_API_KEY：适配器的凭据引用名就是这个变量，给个假值即可（mock 不校验 Authorization；
 *   解析为空才会以 MISSING_CREDENTIAL 失败）；
 * - DSH_TELEMETRY_DISABLED：关遥测。
 */
function sandboxEnv(config: PerfConfig): Record<string, string> {
    return {
        DSH_HOME: SANDBOX,
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${config.port}/v1`,
        DEEPSEEK_API_KEY: "mock-key",
        DSH_TELEMETRY_DISABLED: "1",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT);

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 dsh 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    // 默认剧本：dsh 的 bash 工具要 description，别的 harness 那几份都不能直接用。
    if (!argv.some((arg) => arg === "--script" || arg.startsWith("--script="))) {
        config.scriptPath = resolve(REPO_ROOT, "scripts/dsh-scenario.json");
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 dsh（npm i -g @deepseek-ai/dsh）。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const dshBin = explicitBin ? config.periPath : Bun.which("dsh");
    if (dshBin === null) {
        throw new Error("PATH 里找不到 dsh，可 npm i -g @deepseek-ai/dsh 或显式传 --peri <path>");
    }

    // 沙盒目录先建出来：DSH_HOME 下的 profile 树由 dsh 首次启动时按内置模板初始化。
    mkdirSync(SANDBOX, { recursive: true });

    process.exitCode = await runPerf(config, {
        harnessEnv: sandboxEnv,
        harnessCommand: (cfg: PerfConfig) => [
            dshBin,
            "--profile",
            "headless",
            // 任务文本是位置参数，必须排在启动器 flag 之后（启动器把第一个不认识的 token
            // 之后的全部参数交给 profile 自己的 app，这里就是 headless runner 的 task）。
            cfg.prompt,
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
