#!/usr/bin/env bun
/**
 * Hermes Agent（`hermes`，Nous Research）压测 demo —— 在 playground/hermes 目录里直接启动一次
 * `hermes -z` 压测。
 *
 *   cd playground/hermes
 *   bun perf-demo.ts                      # 起 mock → 起 hermes → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run-hermes.json）
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - harness 命令是 `hermes --yolo -z <prompt>`：`-z`/`--oneshot` 是官方的**脚本化一次性入口**
 *   （单 prompt 进、最终回答出，stdout 上不带 banner/spinner/工具预览）；`--yolo` 是全局选项，
 *   关掉危险命令的审批弹窗——headless 下无人可批，与 Claude Code / agy / mcode 同理，剧本只放
 *   只读命令；
 * - 线协议是 **OpenAI Chat Completions**（POST {base_url}/chat/completions，stream），
 *   与 peri / opencode / pi / dsh / mcode 同协议；
 * - 隔离靠 **HERMES_HOME**（本目录下的 .hermes/）：config.yaml、.env、sessions/、state.db、
 *   skills/、logs/ 全从这里找（官方安装脚本自己也认这个变量，`--hermes-home` 就是它）。
 *   **代码不在这里**——安装脚本把仓库放在 ~/.hermes/hermes-agent，~/.local/bin/hermes 是个
 *   固定指向它的启动壳，所以换 HERMES_HOME 只换数据、不动代码（实测）；
 * - provider 只能靠**配置文件**：`model.provider: custom` + `model.base_url`，配 `providers:`
 *   具名条目也行，但没有环境变量插值这一说，所以每个端口重写一份 $HERMES_HOME/config.yaml
 *   （与 pi 的 models.json、mcode 的 config.yaml 同理）。形状取自官方模板 cli-config.yaml.example
 *   与官方自测里的 mock 配置（`provider: custom` + `base_url` + `default`）；
 * - **消费规律**（实测：104 条剧本 = 100 个工具轮，两笔手续费都要算进条数）：
 *   1. **会话标题生成**（stream=false、messages=2、无 tools，system 是 "You name chat sessions."）
 *      与主请求几乎同时发出、**谁先不定**（5 次实测 3 次标题在前、2 次主请求在前），
 *      合计吃掉开头一条——与 opencode2 / agy 的标题请求同类（那两家固定在第一条）；
 *   2. 途中**一次上下文压缩**（约 170 条消息时，`messages=1`、
 *      `last=user:"You are a summarization agent creating a context checkpoint."`），
 *      压完历史剩 21 条、紧接着一条把原任务重述的主请求——**前后两条都取号**；
 *   之后每轮工具调用一条主请求（stream=true、tools=24），收尾文本吃到即退出，没有 peri 那样的预测
 *   请求；收尾**之后**还可能再发一条技能库复盘（4 次里 1 次），落在尾部那条空白收尾上。
 *   注意带工具结果的续跑请求比轮数少 1（压缩前那一轮的结果折进摘要、没单独回传）——
 *   数轮数要看剧本被执行到第几条，别数 `last=tool`；
 * - 工具形状：shell 工具叫 **`terminal`**（不是 peri 的 `Bash`、也不是 pi/mcode 的 `bash`），
 *   参数 `{command}` 必填（另有 background/timeout/workdir/pty/notify 可选），所以默认剧本是
 *   自家那份 data/scenarios/long-run-hermes.json（`gen-long-run.ts --tool terminal` 生成）；
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
/** 沙盒数据目录（HERMES_HOME）：config.yaml、.env、会话库、日志全落在这里，不碰 ~/.hermes。 */
const SANDBOX = join(import.meta.dir, ".hermes");
/** mock 的模型名：写进剧本的响应体无所谓，但请求里要有个模型 id（config 的 model.default）。 */
const MODEL = "llm-mock";

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 Hermes Agent 版 demo，harness 命令固定为 `hermes --yolo -z <prompt>`；");
    console.log(`      HERMES_HOME 指向 ${SANDBOX}，provider（custom + base_url）按本次端口写进 $HERMES_HOME/config.yaml。`);
    console.log("      默认剧本是 data/scenarios/long-run-hermes.json（terminal 工具调用，--exhausted 默认 stop）。");
    process.exit(EXIT_OK);
}

/**
 * 按本次端口重写 $HERMES_HOME/config.yaml 与 .env。
 *
 * 只写压测需要的三块：model（custom provider + base_url + 模型名）、terminal.backend=local
 * （工具在沙盒 cwd 里真跑）、memory/user_profile 关掉（个人记忆不参与测量，也免得往 ~/.hermes
 * 之外写东西）。其余一律走内置默认——`agent.max_turns` 默认是 null（不限轮），正好让长剧本
 * 跑到自然结束。
 *
 * `.env` 只是模拟真人装完 `hermes setup` 的样子（api_key 引用名）；mock 不校验鉴权，
 * 值给假的即可，但文件得在——provider: custom 的凭据解析会读它。
 */
function writeSandboxConfig(port: number): void {
    const config = [
        "model:",
        "  provider: custom",
        `  default: ${MODEL}`,
        `  base_url: http://127.0.0.1:${port}/v1`,
        "  api_key: mock-key",
        "terminal:",
        "  backend: local",
        "memory:",
        "  memory_enabled: false",
        "  user_profile_enabled: false",
        "",
    ].join("\n");
    mkdirSync(SANDBOX, { recursive: true });
    writeFileSync(join(SANDBOX, "config.yaml"), config);
    writeFileSync(join(SANDBOX, ".env"), "OPENAI_API_KEY=mock-key\n");
}

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - HERMES_HOME：数据目录指到沙盒（代码仍在 ~/.hermes/hermes-agent，由启动壳固定）；
 * - HERMES_SKIP_UPDATE_CHECK=1：跳过启动时的 GitHub 版本检查（Hermes 自己的 evals 也用这个
 *   开关，见仓库里 evals/codebase_navigability/runtime_bench.py）；NO_COLOR/TERM 同源，
 *   压测不该把 ANSI 渲染算进 CPU；
 * - HTTPS 代理指向本机拒绝连接端口，让自升级/遥测/模型目录这类外部请求快速失败（与 Codex /
 *   agy 同一套路；本机到外网的连接经常是停住的，不处理会挂到超时上）；本地 mock 显式绕过，
 *   所以本沙盒不适用于需要外部 HTTPS 的剧本。
 */
function sandboxEnv(config: PerfConfig): Record<string, string> {
    return {
        HERMES_HOME: SANDBOX,
        HERMES_SKIP_UPDATE_CHECK: "1",
        NO_COLOR: "1",
        TERM: "dumb",
        HTTPS_PROXY: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        // 同时覆盖大小写，避免继承的 NO_PROXY=* 或小写代理让外网绕过快速失败路径。
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        // 默认剧本：hermes 的 shell 工具叫 terminal、参数 {command}，沿用不了 peri 那份 Bash 剧本。
        // 必须在**解析时**交出去：--script 的必填校验发生在解析里（见 PerfConfigDefaults）。
        scriptPath: "data/scenarios/long-run-hermes.json",
    });

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 hermes 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    // 产物目录的身份：`data/runs/<harness>/<runId>/`。命令名与目录名同名（hermes），
    // 别名表里不吃特殊规则，但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "hermes";
    }

    // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长；loop 会一直供压
    // 到兜底超时，那是已经废弃的固定窗口口径。
    if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
        config.exhausted = "stop";
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 hermes（官方安装脚本装到 ~/.local/bin）。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const hermesBin = explicitBin ? config.periPath : Bun.which("hermes");
    if (hermesBin === null) {
        throw new Error(
            "PATH 里找不到 hermes，可 curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash " +
                "（装到 ~/.local/bin/hermes），或显式传 --peri <path>",
        );
    }

    writeSandboxConfig(config.port);

    process.exitCode = await runPerf(config, {
        harnessEnv: sandboxEnv,
        harnessCommand: (cfg: PerfConfig) => [
            hermesBin,
            // 全局选项：审批弹窗在 headless 下无人可批，关掉它（剧本只放只读命令）。
            "--yolo",
            // -z / --oneshot：单 prompt 进、最终回答出，stdout 上不带 banner/spinner。
            "-z",
            cfg.prompt,
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
