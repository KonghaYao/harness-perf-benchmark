#!/usr/bin/env bun
/**
 * MiniMax Code CLI（`mcode`）压测 demo —— 在 playground/minimax-code 目录里直接启动一次
 * `mcode exec` 压测。
 *
 *   cd playground/minimax-code
 *   bun perf-demo.ts                      # 起 mock → 起 mcode → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run-minimax-code.json）
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - harness 命令是 `mcode exec --permission off --cwd <沙盒> --model <provider/model> "<prompt>"`：
 *   `exec` 是官方的**无头模式**（跑一个任务、最终回答写 stdout、成功退 0），不依赖 Electron；
 *   仓库 MiniMax-AI/minimax-code 本身只是桌面 App 的 issue 收集页，能进压测的就是这条 CLI；
 * - 隔离靠 **MINIMAX_DATA_DIR**（本目录下的 .minimax/）：config.yaml 与 v2 运行时状态
 *   （会话库、日志、缓存、shims）全从这里找，指到沙盒就不会读写 ~/.minimax；
 * - provider 只能靠**配置文件**：custom_provider.<id>.options.baseURL 不吃环境变量插值，
 *   换端口得按本次端口重写 $MINIMAX_DATA_DIR/config.yaml（与 pi 的 models.json 同理）。
 *   形状按 0.4.12 实测——就是 `mcode provider add` 写出来的那份；apiKey 直接写文件
 *   （mock 不校验 Authorization），也就不用 MCODE_PROVIDER_API_KEY 了；
 * - 线协议是 **OpenAI Chat Completions**（POST {baseURL}/chat/completions，stream），
 *   与 peri / opencode / pi / dsh 同协议；
 * - 工具名**全小写**：shell 工具叫 `bash`、参数 `{command}`（与 pi 同形，不是 peri 的 `Bash`），
 *   所以默认剧本是自家那份 data/scenarios/long-run-minimax-code.json；
 * - 权限：headless **不支持 ask**，demo 固定 `--permission off`——一次性任务、剧本只放只读命令；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承
 *   （实测，见 scripts/perf/run.ts 的 RunDeps.harnessEnv 注释），而 harness 是 run.ts 起的。
 *
 * 产物：<仓库>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 沙盒数据目录（MINIMAX_DATA_DIR）：config.yaml 与 v2 运行时状态都落在这里，不碰 ~/.minimax。 */
const SANDBOX = join(import.meta.dir, ".minimax");
/** 自定义 provider 的 id 与模型名：模型引用写 `custom_provider:llm-mock/llm-mock`。 */
const PROVIDER_ID = "llm-mock";
const MODEL = "llm-mock";
const MODEL_REF = `custom_provider:${PROVIDER_ID}/${MODEL}`;

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 MiniMax Code CLI 版 demo，harness 命令固定为");
    console.log("      `mcode exec --permission off --cwd <沙盒> --model custom_provider:llm-mock/llm-mock <prompt>`；");
    console.log(`      MINIMAX_DATA_DIR 指向 ${SANDBOX}，provider 按本次端口写进 $MINIMAX_DATA_DIR/config.yaml。`);
    console.log("      默认剧本是 data/scenarios/long-run-minimax-code.json（bash 工具调用，--exhausted 默认 stop）。");
    process.exit(EXIT_OK);
}

/**
 * 按本次端口重写 $MINIMAX_DATA_DIR/config.yaml。
 *
 * provider 配置只在文件里（baseURL 不做环境变量插值），所以每个端口一份——但文件是**全量覆盖**，
 * 沙盒里不会越压越多份。形状按 0.4.12 实测（`mcode provider add` 的产物）：custom_provider 下
 * options.apiKey / options.baseURL / authMode + models.<modelId>；reasoning 保持 provider add
 * 的默认，mcode 会照它发 `reasoning_effort`（对 mock 无影响，少一个与真实用法的差异）。
 */
function writeProviderConfig(port: number): void {
    const yaml = [
        "logLevel: info",
        "custom_provider:",
        `  ${PROVIDER_ID}:`,
        `    name: ${PROVIDER_ID}`,
        "    kind: custom",
        "    enabled: true",
        "    api: openai-completions",
        "    options:",
        "      apiKey: mock-key",
        `      baseURL: http://127.0.0.1:${port}/v1`,
        "      authMode: api-key",
        "    models:",
        `      ${MODEL}:`,
        "        reasoning: true",
        "        thinking_config:",
        "          mode: switchable",
        "          default_value: 'true'",
        "",
    ].join("\n");
    mkdirSync(SANDBOX, { recursive: true });
    writeFileSync(join(SANDBOX, "config.yaml"), yaml);
}

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - MINIMAX_DATA_DIR：配置与运行时状态目录指到沙盒（不碰 ~/.minimax）；
 * - PI_TELEMETRY=0：关安装/更新遥测（mcode 的遥测开关沿用了这个名字，0.4.12 实测包内引用的是
 *   `process.env.PI_TELEMETRY`）；压测不该掺外部流量；
 * - NO_PROXY：本机代理配置不参与（mock 走 127.0.0.1，mcode 自己也会绕过 localhost，写上是双保险）。
 */
function sandboxEnv(): Record<string, string> {
    return {
        MINIMAX_DATA_DIR: SANDBOX,
        PI_TELEMETRY: "0",
        NO_PROXY: "127.0.0.1,localhost",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        // 默认剧本：mcode 的 shell 工具叫 bash（小写）+ {command}，与 pi 同形，
        // 不能沿用 peri / opencode / Claude Code 那三家的 Bash 剧本。
        // 必须在**解析时**交出去：--script 的必填校验发生在解析里（见 PerfConfigDefaults）。
        scriptPath: "data/scenarios/long-run-minimax-code.json",
    });

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 mcode 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    // 产物目录的身份：`data/runs/<harness>/<runId>/`。不给也能从启动命令推断（别名表里
    // mcode → minimax-code），但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "minimax-code";
    }

    // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长；loop 会一直供压
    // 到兜底超时，那是已经废弃的固定窗口口径。
    if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
        config.exhausted = "stop";
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 mcode（npm i -g @minimax-ai/code）。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const mcodeBin = explicitBin ? config.periPath : Bun.which("mcode");
    if (mcodeBin === null) {
        throw new Error(
            "PATH 里找不到 mcode，可 npm i -g @minimax-ai/code 或显式传 --peri <path>",
        );
    }

    writeProviderConfig(config.port);

    process.exitCode = await runPerf(config, {
        harnessEnv: sandboxEnv,
        harnessCommand: (cfg: PerfConfig) => [
            mcodeBin,
            "exec",
            // 权限：headless 下 ask 不可用；剧本只放只读命令，用 off 免掉一切审批等待。
            "--permission",
            "off",
            // 工作区固定成沙盒目录，工具调用都在里面跑（与 workDir 同源）。
            "--cwd",
            cfg.workDir,
            // 别名不参与：直接写 provider/id，免得落到 MiniMax 官方模型（那样就打不到 mock）。
            "--model",
            MODEL_REF,
            // 任务文本是位置参数，放在选项之后。
            cfg.prompt,
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
