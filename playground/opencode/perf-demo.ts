#!/usr/bin/env bun
/**
 * opencode 压测 demo（**v1**）—— 在 playground/opencode 目录里直接启动一次 opencode 压测。
 * 它已退出排名（读数见 docs/perf-compare.md），代码与沙盒留着供复测；v2 走隔壁的
 * playground/opencode2（`npm i -g @opencode/cli`，bin 名 `opencode2`）。
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
 *   环境快照，运行时改动不会传给子进程——这里曾经因此静默失效）；
 * - **启动前读版本号，认不出 1.x 直接报错退出**（assertOpencodeV1）：`npm i -g @opencode/cli`
 *   装的 v2 也叫 `opencode` 且通常排在 `~/.bun/bin` 前面，会把这里的 v1 静默顶掉。
 *
 * 产物：<仓库>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { join } from "node:path";
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

/**
 * 二进制守卫：确认手里这个 `opencode` 还是 v1（读版本号，认不出 1.x 就不让跑）。
 *
 * 为什么需要它（实测）：`npm i -g @opencode/cli` 装的是 **opencode v2**，而它的 bin 里同时有
 * `opencode` 与 `opencode2` 两个名字，npm 全局目录又通常排在 `~/.bun/bin` 前面——于是本沙盒
 * 原先指向的 v1 被**静默顶掉**：压测照跑不误，只是被测对象悄悄换了一代，读数全部不作数。
 * 两个版本的命令行、工具名与消费规律都不同（v2 要 `--standalone`、shell 工具叫 `shell`），
 * 混着跑测出来的既不是 v1 也不是 v2。所以这里在读版本号这一步就拦下来：宁可 EXIT_SETUP。
 *
 * 对照：v1 输出 `1.17.12`，v2 输出 `opencode v2.0.10`——取第一个 x.y.z 数字，只认 1.x。
 */
function assertOpencodeV1(binary: string): void {
    const probe = Bun.spawnSync([binary, "--version"]);
    const raw = `${probe.stdout.toString()}${probe.stderr.toString()}`.trim();
    const version = raw.match(/\d+\.\d+\.\d+/)?.[0];
    if (version === undefined || !version.startsWith("1.")) {
        throw new Error(
            `PATH 里的 opencode 不是 v1（读到的版本：${raw === "" ? "<空输出>" : raw}，路径 ${binary}）。\n` +
                "  v1 与 v2 是两个不同的 harness，读数不可混用：`npm i -g @opencode/cli` 会把 v2 的\n" +
                "  `opencode` 装进 npm 全局目录，通常排在 ~/.bun/bin 前面，v1 就这样被顶掉了。\n" +
                `  要复测 v1：bun perf-demo.ts --peri <指向 v1 的路径>（本机 v1 在 ~/.bun/bin/opencode）\n` +
                "  要压测 v2：cd playground/opencode2 && bun perf-demo.ts（沙盒与剧本都是它的）",
        );
    }
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        // 默认剧本：长剧本生成器用 Bash 形状造的那份（opencode 认 Bash，与 peri / Claude Code 共用）。
        // 必须在**解析时**交出去：--script 的必填校验发生在解析里（见 PerfConfigDefaults）。
        scriptPath: "data/scenarios/long-run.json",
    });

    // 产物目录的身份：`data/runs/<harness>/<runId>/`。不给也能从启动命令推断，
    // 但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "opencode";
    }

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
    assertOpencodeV1(opencodeBin);

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
