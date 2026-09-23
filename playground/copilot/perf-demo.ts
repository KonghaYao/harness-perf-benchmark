#!/usr/bin/env bun
/**
 * GitHub Copilot CLI 压测 demo —— 在 playground/copilot 目录里启动一次 `copilot -p` 压测。
 *
 *   cd playground/copilot
 *   bun perf-demo.ts                      # 起 mock → 起 Copilot CLI → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 一致
 *   bun perf-demo.ts --help
 *
 * 接入约定（GitHub Copilot CLI 1.0.87-0 实测）：
 * - 自定义 provider 走 OpenAI Chat Completions，端点是
 *   `POST <COPILOT_PROVIDER_BASE_URL>/chat/completions`，默认剧本因此使用小写 bash + {command}；
 * - COPILOT_HOME 指向本目录的 .copilot/，隔离用户的登录态、配置、插件、日志与 session store；
 * - COPILOT_OFFLINE=true 禁止 GitHub 鉴权、遥测、Web 工具、GitHub MCP 与自动更新；
 * - 非交互 `-p` 必须带 --allow-all-tools 才能执行工具。剧本只允许只读命令；不用 --yolo，
 *   避免额外放开路径与 URL；
 * - --no-custom-instructions 与 --disable-builtin-mcps 保证仓库/用户指令和 GitHub MCP 不参与读数。
 * - 标准 100×4KB 长剧本会在约第 62 次请求插入一次上下文摘要请求；实测总计 102 次请求、
 *   100 个成功 bash 工具轮。摘要请求返回的工具调用仍会执行，因此生成器不用额外补工具条目。
 *
 * 产物：<仓库>/data/runs/copilot/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
const SANDBOX = join(import.meta.dir, ".copilot");
const MODEL = "llm-mock";

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 GitHub Copilot CLI 版 demo，harness 命令固定为");
    console.log("      `copilot -p <prompt> --allow-all-tools --no-custom-instructions --disable-builtin-mcps --silent`；");
    console.log(`      COPILOT_HOME 指向 ${SANDBOX}，provider 走本次端口的 OpenAI Chat Completions。`);
    console.log("      默认剧本是 data/scenarios/long-run-copilot.json（100×4KB 实测 102 请求 / 100 个 bash 工具轮）。");
    console.log("      想看能自行收尾的完整工具循环（三轮调用后打印回答），用：");
    console.log("        bun perf-demo.ts --script playground/copilot/script.json --exhausted hold");
    process.exit(EXIT_OK);
}

function sandboxEnv(port: number): Record<string, string> {
    return {
        COPILOT_HOME: SANDBOX,
        COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`,
        COPILOT_PROVIDER_TYPE: "openai",
        COPILOT_PROVIDER_WIRE_API: "completions",
        COPILOT_PROVIDER_API_KEY: "mock-key",
        COPILOT_MODEL: MODEL,
        COPILOT_PROVIDER_MODEL_ID: MODEL,
        COPILOT_PROVIDER_WIRE_MODEL: MODEL,
        COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "128000",
        COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "16384",
        COPILOT_OFFLINE: "true",
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        scriptPath: "data/scenarios/long-run-copilot.json",
    });

    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "copilot";
    }
    if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
        config.exhausted = "stop";
    }

    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const copilotBin = explicitBin ? config.periPath : Bun.which("copilot");
    if (copilotBin === null) {
        throw new Error("PATH 里找不到 copilot，请安装 GitHub Copilot CLI 或显式传 --peri <path>");
    }

    mkdirSync(SANDBOX, { recursive: true });

    process.exitCode = await runPerf(config, {
        harnessEnv: (cfg: PerfConfig) => sandboxEnv(cfg.port),
        harnessCommand: (cfg: PerfConfig) => [
            copilotBin,
            "-p",
            cfg.prompt,
            "--allow-all-tools",
            "--no-custom-instructions",
            "--disable-builtin-mcps",
            "--no-auto-update",
            "--stream",
            "on",
            "--output-format",
            "text",
            "--silent",
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
