#!/usr/bin/env bun
/**
 * grok 压测 demo —— 在 playground/grok 目录里直接启动一次 grok -p 压测。
 *
 *   cd playground/grok
 *   bun perf-demo.ts                      # 起 mock → 起 grok -p → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 30000   # 参数与 scripts/perf/run.ts 一致
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - harness 命令是 `grok -p "<prompt>" -m llm-mock --yolo --no-auto-update`：grok 的工具执行要
 *   权限放行（--yolo = always-approve），剧本请自觉只放只读命令；--no-auto-update 关掉更新检查；
 * - 隔离靠 **GROK_HOME**（本目录下的 .grok-home/）：配置、sessions、hooks、marketplace 全从它找，
 *   指到沙盒就不会读 ~/.grok（那里有用户自己的 model 配置与凭据）；
 * - **XAI_API_KEY 必须给**（值任意，这里就是 "mock-key"）：grok 启动时先做登录检查，即便
 *   model 段自己带 api_key 也照样拦（实测报 "Not signed in"），给了它才走到发请求这一步；
 *   mock 不校验 Authorization，所以这个值只是给 grok 看的；
 * - 沙盒 config.toml **每次启动由本文件生成**：读同目录的 config.toml（人读的源文件，base_url
 *   写的是默认端口），只把 base_url 换成本次端口再写进沙盒。TOML 没法像 JSON 那样改字段，
 *   所以这里按行替换；
 * - 默认剧本是 scripts/grok-scenario.json：grok 的 shell 工具叫 run_terminal_command（全称，
 *   required 里 command 与 description 都得给），照抄 peri 的 Bash 会被当成未知工具；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承
 *   （实测，见 scripts/perf/run.ts 的 RunDeps.harnessEnv 注释），而 harness 是 run.ts 起的。
 *
 * 二进制：默认从 PATH 找 `grok`，再退回官方布局 ~/.grok/bin/grok；本机两者都没有，
 * 用源码编译的 target/debug/xai-grok-pager（grok 0.2.120，debug 构建启动慢、读数不能与
 * release 版横向比），可显式传 --peri <path> 指定。
 *
 * 产物：<仓库>/data/claude-date/<runId>-{perf.log,samples.csv,harness.log,mock.log}
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 沙盒 GROK_HOME：配置与状态都落在这里，不碰 ~/.grok。 */
const SANDBOX = join(import.meta.dir, ".grok-home");
/** 人读的 provider 源配置；每次启动经 prepareSandbox 换端口后写进沙盒。 */
const CONFIG_SRC = join(import.meta.dir, "config.toml");
/** `-m` 用的模型名，对应 config.toml 里的 [model.llm-mock]。 */
const MODEL = "llm-mock";

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 grok 版 demo，harness 命令固定为 `grok -p <prompt> -m llm-mock --yolo --no-auto-update`；");
    console.log(`      GROK_HOME 指向 ${SANDBOX}（每次启动用本目录的 config.toml 换端口后覆盖），`);
    console.log("      XAI_API_KEY 固定注入 mock-key（只为过 grok 的登录检查，mock 不校验）。");
    console.log("      默认剧本是 scripts/grok-scenario.json（run_terminal_command 工具调用，配 --exhausted loop）。");
    console.log("      想看能自行收尾的完整工具循环（三轮调用后打印回答），用：");
    console.log("        bun perf-demo.ts --script playground/grok/script.json --exhausted hold");
    process.exit(EXIT_OK);
}

/** 查找 grok 二进制：PATH → 官方安装布局 ~/.grok/bin/grok。 */
function findGrok(): string | null {
    const fromPath = Bun.which("grok");
    if (fromPath !== null) {
        return fromPath;
    }
    const official = join(homedir(), ".grok", "bin", "grok");
    return Bun.file(official).size > 0 ? official : null;
}

/**
 * 把沙盒配置同步进 GROK_HOME：每次都覆盖，改了 config.toml 立即生效。
 * 只替换 base_url 一行，源文件保持人类可读、可手工加别的 model 段。
 */
function prepareSandbox(port: number): void {
    const text = readFileSync(CONFIG_SRC, "utf8");
    // 用正则自身判断有没有命中，不能拿「替换后是否变化」当判据：源文件里写的默认端口
    // 恰好等于本次端口时，替换结果与原文件一模一样，会被误判成没找到。
    const baseUrlLine = /^base_url = ".*"$/m;
    if (!baseUrlLine.test(text)) {
        throw new Error(`${CONFIG_SRC} 里没找到 base_url 行`);
    }
    const updated = text.replace(baseUrlLine, `base_url = "http://127.0.0.1:${port}/v1"`);
    mkdirSync(SANDBOX, { recursive: true });
    writeFileSync(join(SANDBOX, "config.toml"), updated);
}

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - GROK_HOME：配置目录（config.toml / sessions / hooks）指到沙盒；
 * - XAI_API_KEY：过启动时的登录检查（值任意，mock 不校验）；
 * - GROK_TELEMETRY_ENABLED：关遥测，压测不该掺外部流量。
 */
function sandboxEnv(): Record<string, string> {
    return {
        GROK_HOME: SANDBOX,
        XAI_API_KEY: "mock-key",
        GROK_TELEMETRY_ENABLED: "0",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT);

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 grok 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    // 默认剧本：grok 的 shell 工具名与其它 harness 都不同，不能沿用全局默认那份。
    if (!argv.some((arg) => arg === "--script" || arg.startsWith("--script="))) {
        config.scriptPath = resolve(REPO_ROOT, "scripts/grok-scenario.json");
    }

    // 二进制：显式 --peri 优先，否则 PATH / 官方布局；都没有就报错。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const grokBin = explicitBin ? config.periPath : findGrok();
    if (grokBin === null) {
        throw new Error("找不到 grok 二进制，可装官方版（见 x.ai/cli）或显式传 --peri <path>");
    }

    prepareSandbox(config.port);

    process.exitCode = await runPerf(config, {
        harnessEnv: () => sandboxEnv(),
        harnessCommand: (cfg: PerfConfig) => [
            grokBin,
            "-p",
            cfg.prompt,
            // 模型名对应沙盒 config.toml 的 [model.llm-mock]。
            "-m",
            MODEL,
            // 放行工具执行（headless 下没有交互确认）。
            "--yolo",
            // 关掉更新检查，压测不掺外部流量。
            "--no-auto-update",
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
