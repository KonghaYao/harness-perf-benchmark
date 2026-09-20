#!/usr/bin/env bun
/**
 * Cline CLI（`cline`）压测 demo —— 在 playground/cline 目录里直接启动一次 `cline <prompt>`
 * 压测。
 *
 *   cd playground/cline
 *   bun perf-demo.ts                      # 起 mock → 起 cline → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run-cline.json）
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - 二进制是 npm 上的 `cline`（`npm i -g cline`，实测 3.0.62；官方仓库 cline/cline 的
 *   apps/cli）：位置参数就是 prompt，默认进 act 模式、**自动批准所有工具**
 *   （`--auto-approve` 默认 true，headless 下没有确认弹窗，剧本自觉只放只读命令）；
 * - 线协议是 **OpenAI Chat Completions**（`POST {baseURL}/chat/completions`、stream，
 *   带 `stream_options.include_usage`），与 peri / opencode / pi / dsh / mcode 同协议；
 *   provider 固定用内置的 `openai-compatible` 这一支，base URL 由它自己拼 `/chat/completions`，
 *   所以配置里的 baseUrl 要带 `/v1`；
 * - **隔离靠 `--config` + `--data-dir`**（都指到本目录的 .cline/，见 prepareSandbox）：
 *   provider 配置、会话库、缓存、hooks 全在沙盒内。实测在 `$HOME/.cline` 里放一份指向死端口的
 *   provider 配置当诱饵，本 demo 的命令照样打到 mock（HOME 级配置抢不走），所以不换 HOME
 *   ——这点与 Claude Code / agy 那两家相反（它们的用户级配置只按 HOME 找，必须换 HOME）；
 * - provider 配置**只能靠文件**：`$CLINE_DIR/data/settings/providers.json`（就是 `cline auth`
 *   写出来的那份），CLI 不吃 base URL 的环境变量插值，所以每次启动按本次端口重写一份
 *   （与 pi 的 models.json、mcode 的 config.yaml 同理）。文件是**全量覆盖**，沙盒里不会越压越多份；
 * - **不要给 cline 注入死代理**（那是 Codex / agy 的做法）：实测把 HTTPS 出口指向
 *   127.0.0.1:9 之后，5 轮小剧本的端到端从 1.7~2.2s 涨到 8~10s（它对着代理重试），
 *   而它自己的外部请求（feature-flags 拉取，落成沙盒里的 cache/feature-flags.json）
 *   首次之后就走缓存、不阻塞主流程。所以这里只关遥测与自升级检查，不碰代理；
 * - **消费规律**（实测，与其余八家的对照见 gen-long-run.ts 的 USAGE）：
 *   1. 一次 prompt 起步就是主请求（`messages=2`：system + user，没有标题生成那一步），
 *      之后每轮工具调用一条主请求；
 *   2. **上下文压缩会吃掉一条剧本**：默认 `--compaction agentic`，上下文长到阈值时它把当轮
 *      换成一条「续写摘要」请求（`messages=2`、`last=user:"Summarize this session for
 *      continuation…"`）——**响应被当摘要用掉、当轮工具调用不再执行**。标准剧本
 *      （100 轮 × 4KB 正文）实测触发 1 次，所以默认剧本用 `--turns 101`：
 *      101 条工具轮 − 1 条被压缩吃掉 + 1 条收尾 = **102 条请求 / 100 个工具轮**；
 *   3. 主流程吃到尾部那条纯文本收尾即自行退出（退出码 0），不用等到 `--timeout-ms`；
 * - 工具集 26 个（run_commands / editor / read_files / search_codebase / skills / team_* …），
 *   shell 工具叫 **`run_commands`**、参数是**字符串数组** `{commands: [...]}`（不是别家的
 *   `{command}`），所以默认剧本是自家那份 data/scenarios/long-run-cline.json
 *   （`gen-long-run.ts --args commands` 生成）；
 * - **读数口径的两个已知点**（详见 CLAUDE.md 的 Cline 一节）：
 *   1. npm 的 bin 只是 Node 启动壳，真干活的是它 spawn 的子进程（实测 97% 的 CPU 在子进程上、
 *      进程树 procs 峰值 2）——所以计分必须看进程树；
 *   2. 工具命令又是那个**子进程**拉起的短命 shell（拿 `sleep 2` 当命令做探针，procs 能顶到 3）：
 *      它活不过 2s 的进程树刷新窗口，CPU 也记在子进程（不是根进程）的 child 计数器上，而采样器
 *      只读根进程的计数器——这一小笔（按本机 `sh -c` 单价估 0.2~0.3 核·秒/100 轮）没进 CU，
 *      所以它的 CU 是**下界**；
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
/** 沙盒配置目录（`--config`）：CLI 默认是 ~/.cline，指到沙盒就不会读用户的全局配置。 */
const SANDBOX = join(import.meta.dir, ".cline");
/** 沙盒状态目录（`--data-dir`）：provider 配置 / 会话库 / 缓存都落在这里（CLI 默认 ~/.cline/data）。 */
const SANDBOX_DATA = join(SANDBOX, "data");
/** provider 配置里那份自定义 provider 的 id（cline 内置的一支，认 baseUrl）。 */
const PROVIDER_ID = "openai-compatible";
const MODEL = "llm-mock";

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 Cline CLI 版 demo，harness 命令固定为");
    console.log("      `cline --config <沙盒> --data-dir <沙盒>/data --hooks-dir <沙盒>/hooks \\");
    console.log(`             -c <work-dir> -P ${PROVIDER_ID} -m ${MODEL} '<prompt>'`);
    console.log(`      provider 按本次端口写进 $CLINE_DATA_DIR/settings/providers.json。`);
    console.log("      默认剧本是 data/scenarios/long-run-cline.json（run_commands 工具调用，--exhausted 默认 stop）。");
    process.exit(EXIT_OK);
}

/**
 * 按本次端口写 $SANDBOX_DATA/settings/providers.json。
 *
 * 这份就是 `cline auth --provider openai-compatible --baseurl … --modelid …` 写出来的形状
 * （3.0.62 实测），只是把 baseUrl 换成当前端口——不调 `cline auth` 子进程：那会多起一个进程、
 * 还带一次外部请求，压测的启动段不该混进这些。文件全量覆盖，重复跑不会越堆越多。
 */
function prepareSandbox(port: number): void {
    const settingsDir = join(SANDBOX_DATA, "settings");
    mkdirSync(settingsDir, { recursive: true });
    const providers = {
        version: 1,
        lastUsedProvider: PROVIDER_ID,
        modes: {},
        providers: {
            [PROVIDER_ID]: {
                settings: {
                    provider: PROVIDER_ID,
                    // mock 不校验鉴权，给个假值即可（模型选择靠 -m，不看这里）。
                    apiKey: "mock-key",
                    model: MODEL,
                    baseUrl: `http://127.0.0.1:${port}/v1`,
                },
                updatedAt: new Date().toISOString(),
                tokenSource: "manual",
            },
        },
    };
    writeFileSync(
        join(settingsDir, "providers.json"),
        `${JSON.stringify(providers, null, 2)}\n`,
    );
}

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - CLINE_NO_AUTO_UPDATE：关掉启动时的自升级检查（压测不该掺外部流量）；
 * - DISABLE_TELEMETRY：关遥测（cline 认这个变量，也认 DO_NOT_TRACK，实测取值链见
 *   telemetry 等级解析；给任何非空值即生效）；
 * - NO_PROXY：本机代理配置不参与（mock 走 127.0.0.1）。**不注入死代理**——实测那样反而慢
 *   （见文件头）。
 */
function sandboxEnv(): Record<string, string> {
    return {
        CLINE_NO_AUTO_UPDATE: "1",
        DISABLE_TELEMETRY: "1",
        NO_PROXY: "127.0.0.1,localhost,::1",
    };
}

/**
 * cline 把位置参数当 prompt 的条件是**它含有空白字符**（3.0.62 实测：包内
 * `function fo(t){return!!t&&/\s/.test(t)}`，不含空白就落进「当作子命令解析」的分支，报
 * `Unknown command or unquoted prompt` 并以 1 退出）。仓库默认 prompt 是中文、没有空格，
 * 会被它拒掉；这里补一个尾随空格——剧本里的 prompt 文本只进 messages 首条 user，
 * 对 mock 与读数都没有影响，但少了它整轮跑不起来。
 */
function clinePrompt(prompt: string): string {
    return /\s/.test(prompt) ? prompt : `${prompt} `;
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        // 默认剧本：cline 的 shell 工具叫 run_commands、参数是 {commands: [...]} 数组，
        // 沿用不了别家的 {command}。剧本要 101 轮（压缩吃掉一条，见文件头）。
        // 必须在**解析时**交出去：--script 的必填校验发生在解析里（见 PerfConfigDefaults）。
        scriptPath: "data/scenarios/long-run-cline.json",
    });

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 cline 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    // 产物目录的身份：`data/runs/<harness>/<runId>/`。二进制名与目录名同为 cline，从命令也能
    // 推断出来，但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "cline";
    }

    // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长；loop 会一直供压
    // 到兜底超时，那是已经废弃的固定窗口口径。
    if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
        config.exhausted = "stop";
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 cline（npm i -g cline）。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const clineBin = explicitBin ? config.periPath : Bun.which("cline");
    if (clineBin === null) {
        throw new Error("PATH 里找不到 cline，可 npm i -g cline，或显式传 --peri <path>");
    }

    prepareSandbox(config.port);

    process.exitCode = await runPerf(config, {
        harnessEnv: sandboxEnv,
        harnessCommand: (cfg: PerfConfig) => [
            clineBin,
            // 配置与状态都锁在沙盒里（不读也不写 ~/.cline）。
            "--config",
            SANDBOX,
            "--data-dir",
            SANDBOX_DATA,
            // hooks 默认按 HOME 找（~/.cline/hooks），显式指到沙盒，免得用户装了什么运行时钩子。
            "--hooks-dir",
            join(SANDBOX, "hooks"),
            // 工作区固定成沙盒目录（run_commands 相对它执行，剧本只放只读命令）。
            "-c",
            cfg.workDir,
            // provider / 模型都显式点名：落到 cline 官方 provider 就打不到 mock 了。
            "-P",
            PROVIDER_ID,
            "-m",
            MODEL,
            // 任务文本是位置参数，放在选项之后；**必须含空白**才被当作 prompt（见 clinePrompt）。
            clinePrompt(cfg.prompt),
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
