#!/usr/bin/env bun
/**
 * Grok Build（`grok`，xAI）压测 demo —— 在 playground/grok 目录里直接启动一次
 * `grok -p <prompt>` 压测。
 *
 *   cd playground/grok
 *   bun perf-demo.ts                      # 起 mock → 起 grok → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run-grok.json）
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - 二进制是官方安装脚本落到的 `grok`（`curl -fsSL https://x.ai/cli/install.sh | bash`，
 *   默认 `~/.grok/bin/grok`，再软链进 PATH）。从 PATH 找（`Bun.which("grok")`），
 *   `--peri <path>` 可显式指定；
 * - harness 命令是 `grok -p '<prompt>' -m llm-mock --yolo --tools run_terminal_cmd`：
 *   `-p` 是官方无头模式。`--yolo` 免掉无人可批的确认；`--tools run_terminal_cmd` 把内置工具
 *   收成 shell（模型侧名字是 `run_terminal_command`，CLI 过滤名是 `run_terminal_cmd`）。
 *   MCP 元工具 `search_tool` / `use_tool` 文档写明会留在工具集里，剧本不调用它们；
 * - 线协议是 **OpenAI Chat Completions**（`POST {base_url}/chat/completions`、`stream: true`）。
 *   自定义模型写在沙盒 `config.toml` 的 `[model.llm-mock]`，`api_backend = "chat_completions"`，
 *   `base_url` 带 `/v1`；
 * - **隔离靠 `GROK_HOME` + `HOME`**：`GROK_HOME` 是官方数据根（config / sessions / auth），
 *   指到沙盒就不读用户的 `~/.grok`。`HOME` 也指到沙盒，免得 `~/.agents` 里的个人 skill
 *   和 shell 配置混进每次请求（Claude Code / agy 同一条：用户级文件只按 HOME 找）；
 * - provider **不吃环境变量插值**，demo 每次按本次端口全量重写 `config.toml`
 *   （与 pi 的 models.json、kimi 的 config.toml 同理）。`api_key` 给假值，mock 不校验鉴权；
 * - shell 工具参数是 `{command, description}`，**两个都必填**（缺 description 会被工具拒掉），
 *   所以默认剧本用 `--args command+description`；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承。
 *
 * 产物：<仓库>/data/runs/grok/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 沙盒数据根（GROK_HOME / HOME）：config.toml 与 sessions 都落这里。 */
const SANDBOX = join(import.meta.dir, ".grok-home");
/** `[model.<id>]` 的键名，也是 `-m` 点名的模型 id。 */
const MODEL = "llm-mock";

if (import.meta.main && (argv.includes("-h") || argv.includes("--help"))) {
    console.log(USAGE);
    console.log("提示: 这是 Grok Build 版 demo，harness 命令固定为");
    console.log(`      grok -p '<prompt>' -m ${MODEL} --yolo --tools run_terminal_cmd`);
    console.log("      GROK_HOME 与 HOME 都指向本目录 .grok-home/，provider 按本次端口写进 config.toml。");
    console.log("      默认剧本是 data/scenarios/long-run-grok.json（run_terminal_command + {command, description}）。");
    process.exit(EXIT_OK);
}

/**
 * 按本次端口生成沙盒 config.toml。base_url 带 `/v1`（CLI 自己拼 /chat/completions）。
 * context_window 拉到 100 万、压缩阈值 100%，避免 100×4KB 剧本中途插压缩请求。
 * title_refresh 关掉后续改标题；首条标题请求仍会发，剧本条数按它留。
 */
export function sandboxConfig(port: number): string {
    return `[cli]
auto_update = false

[features]
telemetry = "off"
title_refresh = false

[memory]
enabled = false

[memory_v2]
enabled = false

[ui]
prompt_suggestions = false

[session]
auto_compact_threshold_percent = 100

[models]
default = "${MODEL}"
session_summary = "${MODEL}"

[model.${MODEL}]
model = "${MODEL}"
name = "${MODEL}"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "mock-key"
api_backend = "chat_completions"
context_window = 1000000
stream_tool_calls = false
supports_backend_search = false
max_retries = 0
`;
}

export function harnessCommand(
    grokBin: string,
    cfg: Pick<PerfConfig, "prompt" | "periArgs">,
): string[] {
    return [
        grokBin,
        "-p",
        cfg.prompt,
        "-m",
        MODEL,
        "--yolo",
        "--tools",
        "run_terminal_cmd",
        "--disable-web-search",
        "--no-subagents",
        "--no-auto-update",
        "--no-plan",
        "--output-format",
        "plain",
        ...cfg.periArgs,
    ];
}

// 被测试或其他模块导入时，只提供配置函数，不启动压测或修改宿主进程的退出码。
if (import.meta.main) {
    try {
        const config = loadPerfConfig(argv, REPO_ROOT, {
            scriptPath: "data/scenarios/long-run-grok.json",
        });
        if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
            config.workDir = import.meta.dir;
        }
        if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
            config.harnessId = "grok";
        }
        if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
            config.exhausted = "stop";
        }
        const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
        const grokBin = explicitBin ? config.periPath : Bun.which("grok");
        if (grokBin === null) {
            throw new Error(
                "PATH 里找不到 grok：装官方发布版（curl -fsSL https://x.ai/cli/install.sh | bash），" +
                    "或用 --peri <path> 显式指定",
            );
        }
        // 官方 `--version` 形如 `grok 1.0.41 (4220f3b224a6)`。对不上就别拿错二进制出读数。
        const version = Bun.spawnSync([grokBin, "--version"], { stderr: "pipe" });
        const versionText = version.stdout.toString().trim();
        if (version.exitCode !== 0 || !/^grok \d+\.\d+\.\d+/.test(versionText)) {
            throw new Error(
                `${grokBin} --version 输出不符合 Grok Build 的形状（实测 \`grok 1.0.41 (…)\`），收到: ` +
                    `${JSON.stringify(versionText.slice(0, 80))}`,
            );
        }
        mkdirSync(SANDBOX, { recursive: true });
        writeFileSync(join(SANDBOX, "config.toml"), sandboxConfig(config.port));
        process.exitCode = await runPerf(config, {
            harnessEnv: () => ({
                HOME: SANDBOX,
                GROK_HOME: SANDBOX,
                GROK_DISABLE_AUTOUPDATER: "1",
                GROK_MEMORY: "0",
                GROK_TITLE_REFRESH: "0",
                NO_PROXY: "127.0.0.1,localhost,::1",
                no_proxy: "127.0.0.1,localhost,::1",
            }),
            harnessCommand: (cfg) => harnessCommand(grokBin, cfg),
        });
    } catch (error) {
        console.error(`[perf] 启动失败: ${(error as Error).message}`);
        console.error("用法见 bun perf-demo.ts --help");
        process.exitCode = EXIT_SETUP;
    }
}
