#!/usr/bin/env bun
/**
 * ccode 压测 demo —— 在 playground/ccode 目录里直接启动一次 `ccode-cli --write --auto-approve -p`
 * 压测。
 *
 *   cd playground/ccode
 *   bun perf-demo.ts                      # 起 mock → 起 ccode-cli → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run-ccode.json）
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - 被测对象是 ccode 自己（纯 C89 + 保守 POSIX，单个静态二进制，没有运行时依赖）：`make ccode-cli`
 *   的产物 `./ccode-cli` 放进 PATH 即可（先认 `Bun.which("ccode-cli")`，再认 `ccode`），
 *   `--peri <path>` 可显式指定。**PATH 里没有就直接报错，不猜本地构建产物**——与 peri 同一条纪律：
 *   猜出来的二进制（比如某个 debug 构建）读数不可比，等于悄悄换了被测对象。
 * - harness 命令是 `ccode-cli --write --auto-approve [--max-turns N] -p '<prompt>'`：ccode 的默认
 *   工具集是只读的（`--read-only`），要跑到 `bash` 必须开 `--write`；`--auto-approve` 免掉 headless
 *   下无人可批的确认（与 claude-code 的 `--dangerously-skip-permissions`、agy / mcode / hermes 的
 *   同类开关一个道理，剧本自觉只放只读命令）。**不能用 `--default`**：它是交互预设
 *   （`config.c` 里 interactive 优先），在 `-p` 模式下会让 prompt 被忽略掉。
 * - 隔离靠 **`CCODE_SESSION_DIR`** 指向本目录的 .ccode-sandbox/sessions：`-p` 一次性模式实测不落
 *   session 文件，但指到沙盒能保证不碰用户已有的会话目录（ccode 默认落 `~/.ccode/sessions`）；
 * - provider 全走环境变量（`CCODE_API_BASE` / `CCODE_API_KEY` / `CCODE_MODEL`，不用生成配置文件）：
 *   客户端自己拼 `/chat/completions`，所以 base_url 要带 `/v1`；mock 是 loopback http，ccode 默认
 *   放行（只有远程明文 http 才要 `--allow-http`）；
 * - 线协议是 **OpenAI Chat Completions**（`POST {base_url}/chat/completions`、stream），与 peri /
 *   pi / dsh / mcode / hermes / cline / kimi 同协议；
 * - 工具集里的 shell 工具叫 **`bash`**、参数 `{command}`（`timeout_ms` 可选），与 pi / mcode 同形，
 *   所以默认剧本是自家那份 data/scenarios/long-run-ccode.json（`gen-long-run.ts --tool bash`）；
 * - **消费规律（实测）**：`--turns N` 直接映射成 ccode 的 `--max-turns N`（同一个语义：单次 prompt
 *   的轮数上限；不传就用 ccode 自己的默认 50，0 = 不限）。没有标题生成、没有上下文压缩
 *   （默认 context-tokens 1000000，100 轮远未触顶），也没有 peri 那样的预测请求，所以剧本按
 *   「轮数 + 2 条收尾」生成就够：
 *     1. 撞到上限时**到顶即止**——`--max-turns N` 配 N 轮剧本实测正好 N 条请求，尾部收尾它不发
 *        （3 轮冒烟 3 条、100 轮长剧本 100 条，两次都成立）；
 *     2. 不设上限（`--max-turns 0`）时它跑到剧本尾部、吃掉那条「任务结束」再退，即「轮数 + 1」条；
 *        **本 demo 永远显式给这个 flag**：调用方给了 `--turns` 就用它，没给就传 0（不限）。
 *        两边配错时它照样画出一条正常的柱子，只是少干了一半活——读 CU 时看不出来；
 *     3. 撞上限时 ccode 往 stderr 打一行 `[turn limit]`（harness.log 里能看到），可用来判形状；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承
 *   （实测，见 scripts/perf/run.ts 的 RunDeps.harnessEnv 注释），而 harness 是 run.ts 起的；
 * - 主流程包在 `import.meta.main` 里（其余 demo 直接铺在模块顶层）：这样测试 import
 *   `sandboxEnv` / `resolveBinary` 时不会顺手起一次压测。
 *
 * 产物：<仓库>/data/runs/ccode/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

/** 沙盒：session 目录落在这里（`-p` 模式实测不落文件，指到沙盒是保证不碰用户的会话目录）。 */
export const SANDBOX = join(import.meta.dir, ".ccode-sandbox");
export const SESSION_DIR = join(SANDBOX, "sessions");
/** 模型名：mock 不校验，写什么都行（与其余各家共用同一个别名，读日志时好认）。 */
export const MODEL = "llm-mock";

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - CCODE_API_BASE：OpenAI 兼容端点，按本次端口生成（客户端自己拼 /chat/completions，所以带 /v1）；
 * - CCODE_API_KEY：假值即可（mock 不校验 Authorization）；
 * - CCODE_MODEL：模型名，mock 不校验；
 * - CCODE_SESSION_DIR：会话目录指到沙盒。
 */
export function sandboxEnv(port: number): Record<string, string> {
    return {
        CCODE_API_BASE: `http://127.0.0.1:${port}/v1`,
        CCODE_API_KEY: "mock-key",
        CCODE_MODEL: MODEL,
        CCODE_SESSION_DIR: SESSION_DIR,
    };
}

/**
 * 二进制解析：显式 `--peri` 由调用方处理；否则按 PATH 里的 ccode-cli → ccode 顺序找，都没有返回
 * null。先认 ccode-cli：`ccode` 是含 TUI 的单体构建，读数口径与默认构建的 ccode-cli 不是一回事。
 * PATH 当参数传（默认取进程环境），测试才能不起进程就把这个顺序钉住。
 */
export function resolveBinary(argv: string[], path: string = process.env.PATH ?? ""): string | null {
    if (argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="))) return null;
    return Bun.which("ccode-cli", { PATH: path }) ?? Bun.which("ccode", { PATH: path });
}

/**
 * harness 命令：`ccode-cli --write --auto-approve --max-turns <N> -p <prompt>`。
 *
 * **`--max-turns` 永远显式给**：调用方给了 `--turns` 就用它，没给就传 0（ccode 的「不限轮」）。
 * 这个 flag 不能省——省了 ccode 会落回它自己的默认 50，于是 100 轮的剧本只跑一半，而柱子照画、
 * 读 CU 看不出来。上游 CI 跑批正是「不带 --turns 调 demo」（`.github/workflows/benchmark-pages.yml`
 * 只传 --timeout-ms 与 --label），所以这不是防御性代码，是必须的。
 */
export function harnessCommand(
    ccodeBin: string,
    cfg: Pick<PerfConfig, "turns" | "prompt" | "periArgs">,
    turnsGiven: boolean,
): string[] {
    return [
        ccodeBin,
        // 默认只读工具集跑不到 bash，必须开 --write；headless 下无人可批，配 --auto-approve。
        "--write",
        "--auto-approve",
        "--max-turns",
        turnsGiven ? String(cfg.turns) : "0",
        "-p",
        cfg.prompt,
        ...cfg.periArgs,
    ];
}

export async function main(argv: string[]): Promise<number> {
    if (argv.includes("-h") || argv.includes("--help")) {
        console.log(USAGE);
        console.log("提示: 这是 ccode 版 demo，harness 命令固定为 `ccode-cli --write --auto-approve -p <prompt>`；");
        console.log(`      CCODE_SESSION_DIR 指向 ${SESSION_DIR}，provider 走环境变量（$CCODE_API_BASE / $CCODE_API_KEY / $CCODE_MODEL）。`);
        console.log("      默认剧本是 data/scenarios/long-run-ccode.json（bash + {command}，--exhausted 默认 stop）。");
        console.log("      --turns N 映射成 ccode 的 --max-turns N；不传则显式传 0（不限轮），让它跑完整份剧本。");
        console.log("      二进制找 PATH 里的 ccode-cli / ccode（make ccode-cli 的产物），或显式传 --peri <path>。");
        return EXIT_OK;
    }

    try {
        const config = loadPerfConfig(argv, REPO_ROOT, {
            // 默认剧本：ccode 的 bash 工具形状是 {command}，与 mcode / pi 同形。
            // 必须在**解析时**交出去：--script 的必填校验发生在解析里（见 PerfConfigDefaults）。
            scriptPath: "data/scenarios/long-run-ccode.json",
        });

        // harness 工作目录：固定为 ccode 沙盒（默认是 playground/peri）。
        if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
            config.workDir = import.meta.dir;
        }
        // 产物目录的身份：`data/runs/<harness>/<runId>/`。
        if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
            config.harnessId = "ccode";
        }
        // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长。
        if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
            config.exhausted = "stop";
        }

        const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
        const ccodeBin = explicitBin ? config.periPath : resolveBinary(argv);
        if (ccodeBin === null) {
            throw new Error(
                "PATH 里找不到 ccode-cli：在 ccode 仓库 `make ccode-cli` 后把 ./ccode-cli 放进 PATH" +
                    "（或软链到 ~/.local/bin），或用 --peri <path> 显式指定",
            );
        }

        mkdirSync(SESSION_DIR, { recursive: true });

        // --turns 是 harness 侧的轮数上限（run.ts 的语义，不传时它自己的默认是 25）：见 harnessCommand()。
        const turnsGiven = argv.some((arg) => arg === "--turns" || arg.startsWith("--turns="));

        return await runPerf(config, {
            harnessEnv: (cfg) => sandboxEnv(cfg.port),
            harnessCommand: (cfg) => harnessCommand(ccodeBin as string, cfg, turnsGiven),
        });
    } catch (error) {
        console.error(`[perf] 启动失败: ${(error as Error).message}`);
        console.error("用法见 bun perf-demo.ts --help");
        return EXIT_SETUP;
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
}
