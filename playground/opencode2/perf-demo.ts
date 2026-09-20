#!/usr/bin/env bun
/**
 * opencode v2（`@opencode/cli`，包自带 `opencode2` 这个 bin 别名）压测 demo —— 在
 * playground/opencode2 目录里直接启动一次压测。
 *
 *   cd playground/opencode2
 *   bun perf-demo.ts                      # 起 mock → 起 opencode2 → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run-opencode2.json）
 *   bun perf-demo.ts --help
 *
 * 为什么单开一个沙盒（而不是复用 playground/opencode）：v2 是 opencode 的下一代，与 v1
 * **同一个发布者**（npm 上 `opencode-ai` 与 `@opencode/cli` 的维护者都是 thdxr），但被测对象
 * 是两个二进制，读数不能混。v1 那份（playground/opencode）已退出排名、只留档；这份是参与排名的
 * 那条曲线（harness id `opencode2`，展示名 opencode2）。
 *
 * 与 v1 沙盒的差异（都是实测出来的，换版本要重新验）：
 * - **命令是 `opencode2 run --standalone --model llm-mock/llm-mock --auto <prompt>`**。
 *   `--standalone` 不是可选项：不加它会走「后台服务」模式，起一个常驻的 `serve --service`
 *   进程，压测跑完它还活着、下一轮直接复用它——三次读数就变成「第一轮冷、后两轮热」，
 *   端到端与启动段全不可比（实测残留进程 `opencode serve --service`）。加了之后跑完
 *   `service status` 是 stopped、无残留；
 * - **shell 工具叫 `shell`**（v1 叫 `bash`），参数 `{command, workdir, timeout, background}`，
 *   只有 `command` 必填——所以默认剧本是自家那份 `long-run-opencode2.json`
 *   （`gen-long-run.ts --tool shell`，command 形状），沿用不了 v1 那份 `long-run.json`；
 * - **配置仍然吃 v1 那套**：cwd 的 `opencode.json` 里 `provider.<id>.options.baseURL` 支持
 *   `{env:…}` 插值（换端口不用改文件），但 `npm: "@ai-sdk/openai-compatible"` 这一项**必须写**
 *   ——漏了会直接报 `Unsupported package for llm-mock/llm-mock`（实测）。provider 实现是
 *   编进那个 177MB 单文件二进制的，**运行时不下载任何 npm 包**（沙盒里没有 node_modules，
 *   死代理下照样跑通）；
 * - 隔离还是 `XDG_*`（v2 的 `debug paths` 实测：data / cache / config / state 四路全认 XDG），
 *   经 `deps.harnessEnv` 注入到子进程——**不要用 `process.env.X = …`**：Bun 1.4 的 `Bun.spawn`
 *   不传 env 时用的是进程启动时的环境快照，运行时的改动传不进去（见 scripts/perf/run.ts 的注释）；
 * - **死代理**：与 codex / agy 同一套路。本机在 PAC 代理后面，到公网的连接会停住；把 HTTPS 出口
 *   指到本机拒绝连接端口让遥测/检查类请求快速失败，同时用 NO_PROXY 保住 mock 直连。此沙盒不适用
 *   于需要外部 HTTPS 的剧本；
 * - **消费规律**（实测）：序列**第一条**是会话标题生成（`messages=2`、无 tools，system 写着
 *   "You are a title generator"），之后每轮工具调用一条主请求，100 轮内没有上下文压缩请求
 *   （与 dsh 的标题请求同类，只是位置在最前）。
 *
 * 产物：<仓库>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 opencode v2 版 demo，harness 命令固定为");
    console.log("      `opencode2 run --standalone --model llm-mock/llm-mock --auto <prompt>`；");
    console.log(`      数据/状态/缓存/配置隔离在 ${import.meta.dir} 下的 .data/.state/.cache/.config。`);
    console.log("      默认剧本是 data/scenarios/long-run-opencode2.json（shell 工具调用），--exhausted 默认 stop。");
    process.exit(EXIT_OK);
}

/** 用户显式给了某个选项就不再插手（下面按本家默认值补的那些项都这么判断）。 */
const given = (name: string): boolean => argv.some((arg) => arg === name || arg.startsWith(`${name}=`));

/** 沙盒目录与 mock 地址，经 run.ts 的 deps.harnessEnv 注入子进程（见文件头「不要用 process.env」）。 */
function sandboxEnv(port: number): Record<string, string> {
    return {
        XDG_DATA_HOME: join(import.meta.dir, ".data"),
        XDG_STATE_HOME: join(import.meta.dir, ".state"),
        XDG_CACHE_HOME: join(import.meta.dir, ".cache"),
        // 配置留一份在沙盒里（cwd 那份是给压测用的；这里指到沙盒只是为了不让它去读用户的全局配置）。
        XDG_CONFIG_HOME: join(import.meta.dir, ".config"),
        // 本目录的 opencode.json 把 provider baseURL 写成 `{env:LLM_MOCK_BASE_URL}`（实测支持），
        // 这样换端口不用改配置文件。
        LLM_MOCK_BASE_URL: `http://127.0.0.1:${port}/v1`,
        HTTPS_PROXY: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        // 同时覆盖大小写，避免继承的 NO_PROXY=* 或小写代理让外网绕过快速失败路径。
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        // 默认剧本：v2 的 shell 工具形状（`shell` + command）。必须在**解析时**交出去：
        // --script 的必填校验发生在解析里（见 PerfConfigDefaults）。
        scriptPath: "data/scenarios/long-run-opencode2.json",
    });

    // harness 工作目录默认是 playground/peri，这里固定为 v2 沙盒：cwd 的 opencode.json
    // 定义了 mock provider，**必须在这个目录里启动**。
    if (!given("--work-dir")) config.workDir = import.meta.dir;

    // 产物目录的身份：`data/runs/opencode2/<runId>/`。命令名（opencode2）与目录名一致，
    // 别名表里不需要登记，但显式写出来更稳（命令被包装、换路径都不影响落点）。
    if (!given("--harness")) config.harnessId = "opencode2";

    // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长。
    if (!given("--exhausted")) config.exhausted = "stop";

    // 二进制：显式 --peri 优先，否则从 PATH 找 opencode2。
    // **找 opencode2 而不是 opencode**：`@opencode/cli` 同时提供两个 bin 名，而 PATH 里
    // `~/.npm-global/bin` 排在 `~/.bun/bin` 之前，裸 `opencode` 已经被 v2 顶掉（v1 那份还在
    // ~/.bun/bin 下）。这条曲线要的是 v2，别名让两边都不会认错。
    const explicitBin = given("--peri");
    const bin = explicitBin ? config.periPath : Bun.which("opencode2");
    if (bin === null) {
        throw new Error(
            "PATH 里找不到 opencode2，可 npm i -g @opencode/cli 安装（它同时提供 opencode 与 opencode2），" +
                "或显式传 --peri <path>",
        );
    }

    process.exitCode = await runPerf(config, {
        harnessEnv: (cfg: PerfConfig) => sandboxEnv(cfg.port),
        harnessCommand: (cfg: PerfConfig) => [
            bin,
            "run",
            // 私有 server：不起常驻后台服务（见文件头，这条不加整批读数都不可比）。
            "--standalone",
            "--model",
            "llm-mock/llm-mock",
            // 无头下没有交互提示，权限按「未显式拒绝即批准」自动过（等同别家的 skip-permissions）。
            "--auto",
            cfg.prompt,
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
