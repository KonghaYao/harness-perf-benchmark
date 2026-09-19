#!/usr/bin/env bun
/**
 * Claude Code 压测 demo —— 在 playground/claude-code 目录里直接启动一次 claude -p 压测。
 *
 *   cd playground/claude-code
 *   bun perf-demo.ts                      # 起 mock → 起 claude -p → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 一致
 *   bun perf-demo.ts --help
 *
 * 与 peri / opencode 版 demo 的差异：
 * - harness 命令是 `claude -p "<prompt>" --dangerously-skip-permissions --no-session-persistence`
 *   （本版本没有 --max-turns，`-p` 模式下也没有轮数上限；默认剧本是有限长的长剧本，
 *   配 `--exhausted stop` 让它在剧本走完后自行收尾，所以端到端时长是完整的；
 *   换剧本时请只配只读工具——权限检查被跳过了）；
 * - Claude Code 没有随 cwd 生效的 provider 配置，接入点只能靠环境变量；沙盒变量经
 *   `deps.harnessEnv` 注入（见 sandboxEnv），逐个覆盖全局同名变量，否则会打到用户自己的代理；
 * - **隔离必须改 HOME**：状态目录可以用 CLAUDE_CONFIG_DIR 挪走，但用户级 settings
 *   （~/.claude/settings.json 里的 model / env / hooks / 插件 / MCP）只按 HOME 找，
 *   实测只设 CLAUDE_CONFIG_DIR 时它仍会被读取，里面的 env 块会把 ANTHROPIC_BASE_URL 抢回去，
 *   压测就完全打不到本 mock。所以 HOME 与 CLAUDE_CONFIG_DIR 一起指到沙盒内。
 *
 * 注意：工作目录是沙盒，但 Claude Code 会向上找到仓库根的 CLAUDE.md 当项目记忆，
 * 每次请求都会带上（属预期，与本 mock 无关）。
 *
 * 产物：<仓库>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { join, resolve } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
const MODEL = "llm-mock";
/** 用户显式给了某个选项就不再插手（下面按各家默认值补的那些项都这么判断）。 */
const given = (name: string): boolean =>
    argv.some((arg) => arg === name || arg.startsWith(`${name}=`));

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 Claude Code 版 demo，harness 命令固定为 `claude -p <prompt> --dangerously-skip-permissions --no-session-persistence`；");
    console.log(`      沙盒在 ${join(import.meta.dir, ".home")}（HOME + CLAUDE_CONFIG_DIR），不碰 ~/.claude 的 settings 与 hooks。`);
    console.log("      默认剧本是 data/scenarios/long-run.json（长剧本，Bash 工具调用，");
    console.log("      与 peri / opencode 共用），--exhausted 默认 stop。");
    console.log("      想看能自行收尾的完整工具循环（三轮调用后打印回答），用：");
    console.log("        bun perf-demo.ts --script playground/claude-code/script.json --exhausted hold");
    process.exit(EXIT_OK);
}

/**
 * 沙盒环境变量，经 run.ts 的 `deps.harnessEnv` 注入子进程。
 * 不要写成 `process.env.X = …`：Bun 1.4 的 `Bun.spawn` 不传 `env` 时用的是进程启动时的
 * 环境快照，运行时对 process.env 的改动不会传给子进程（实测子进程读到空值）。
 */
function sandboxEnv(port: number): Record<string, string> {
    // 用户级 settings 只按 HOME 找，必须挪到沙盒里，否则用户配置会反手改掉下面这些变量。
    const home = join(import.meta.dir, ".home");
    return {
        HOME: home,
        // 会话、shell 快照等状态目录（不设也能跟着 HOME 走，显式写出来便于排查）。
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        // Claude Code 的 base URL **不带 /v1**：客户端自己拼出 /v1/messages（实测 2.1.277 抓包）。
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: "mock-key",
        // AUTH_TOKEN 优先于 API_KEY，不改掉会把用户全局 token 带给 mock。
        ANTHROPIC_AUTH_TOKEN: "mock-key",
        ANTHROPIC_MODEL: MODEL,
        // 别名（opus/sonnet/haiku）也指到 mock，免得全局的别名映射混进来。
        ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
        // 模型名不在 Claude Code 的模型目录里，显式给上下文窗口，免得启动时刷告警。
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
        // 压测不该掺外部流量或更新检查：遥测、错误上报、自动更新都关掉。
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_AUTOUPDATER: "1",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT);

    // 产物目录的身份：`data/runs/<harness>/<runId>/`。不给也能从启动命令推断，
    // 但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "claude-code";
    }

    // 默认剧本：长剧本生成器用 Bash 形状造的那份（Claude Code 认 Bash，与 peri / opencode 共用）。
    // run.ts 的 --script 是必填，默认值因此得由各家 demo 自己带。
    if (!given("--script")) config.scriptPath = resolve(REPO_ROOT, "data/scenarios/long-run.json");
    // 耗尽策略跟着默认剧本走：`-p` 模式自己不会收敛，靠 stop 让它在剧本走完后收尾退出，
    // 端到端时长才完整；loop 会一直供压到兜底超时，那是已经废弃的固定窗口口径。
    if (!given("--exhausted")) config.exhausted = "stop";

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 claude-code 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 claude。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const claudeBin = explicitBin ? config.periPath : Bun.which("claude");
    if (claudeBin === null) {
        throw new Error("PATH 里找不到 claude，可显式传 --peri <path>");
    }

    process.exitCode = await runPerf(config, {
        harnessEnv: (cfg: PerfConfig) => sandboxEnv(cfg.port),
        harnessCommand: (cfg: PerfConfig) => [
            claudeBin,
            "-p",
            cfg.prompt,
            "--dangerously-skip-permissions",
            "--no-session-persistence",
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
