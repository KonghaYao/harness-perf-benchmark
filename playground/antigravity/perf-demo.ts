#!/usr/bin/env bun
/**
 * Antigravity CLI（`agy`）压测 demo —— 在 playground/antigravity 目录里直接启动一次
 * `agy -p` 压测。
 *
 *   cd playground/antigravity
 *   bun perf-demo.ts                      # 起 mock → 起 agy → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run-antigravity.json）
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - harness 命令是 `agy -p <prompt> --dangerously-skip-permissions`：`-p`/`--print` 是官方的
 *   无头模式（跑一个 prompt、回答写 stdout、成功退 0）；权限默认是 request-review + headless
 *   下无处可批 → 需要审批的工具被**软拒**（跑得下去，但白费一轮），所以固定带 skip-permissions，
 *   与 Claude Code 那份同理，剧本只放只读命令；
 * - 线协议是 **Google Gemini API**（不是 OpenAI 兼容）：`POST /v1beta/models/{model}:streamGenerateContent?alt=sse`，
 *   mock 侧由 src/gemini.ts 应答。**这也是八家里唯一走这个协议的**——它不吃 base URL 上的
 *   `/v1/chat/completions`，配错端点的症状是启动即报 404；
 * - 隔离靠 **HOME**（本目录下的 .home/）：配置在 `$HOME/.gemini/antigravity-cli/settings.json`，
 *   连同凭据缓存、会话状态一起落在沙盒里。**只改某个 config dir 是不够的**（Claude Code 的
 *   教训：用户级 settings.json 仍按 HOME 找），这里直接把 HOME 换掉；
 * - 免登录靠 **modelProvider=gemini + GEMINI_API_KEY**（settings.json 里那一行）：官方文档
 *   写明的用法，headless/CI 下没有浏览器可走 OAuth，账号模式在这条路径上根本起不来。
 *   key 给个假值即可——mock 不校验鉴权，但变量**必须存在**（缺了 CLI 直接退出）；
 * - 端点开关是 **GOOGLE_GEMINI_BASE_URL**（官方文档明确支持这个变量），值必须是 https 或
 *   loopback（127.0.0.1 / localhost / [::1]）——本 mock 正好在允许范围内，所以不用证书；
 * - **死代理**：agy 会碰 Google 自家的服务（自升级检查、遥测），本机到 Google 的连接是停住的，
 *   不处理就会挂到超时上。把 HTTPS 出口指向本机拒绝连接端口让它们快速失败，同时用
 *   NO_PROXY 保住 mock 直连（与 Codex 那份同一个套路，理由见 playground/codex/perf-demo.ts）；
 * - **消费规律**（实测：100 轮要 104 条剧本）：
 *   1. 序列**第一条**是会话标题生成（模型 gemini-3.1-flash-lite-preview，同一个端点、
 *      同一个 key，systemInstruction 里写着 "conversation title generator"）——它在最前面，
 *      与 peri 的预测请求（在最后）正好相反；
 *   2. 每轮工具调用一条主请求（模型 gemini-3.1-pro-preview，tools=9）；
 *   3. 每约 32 个请求插一条**上下文压缩**（「续写摘要」：
 *      `last=user:"Your main task now is to generate a continuation summary of …"`），
 *      同样取号——与 pi 的压缩是同一类东西，只是节奏更规整。
 *   所以默认剧本生成用 `--turns 104`（104 - 3 次压缩 - 1 条收尾 = 正好 100 个工具轮）；
 * - 工具形状：shell 工具叫 `run_command`，参数五项全必填
 *   （CommandLine / Cwd / WaitMsBeforeAsync / toolSummary / toolAction），所以默认剧本是
 *   自家那份 data/scenarios/long-run-antigravity.json（`gen-long-run.ts --args commandline`）；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承
 *   （实测，见 scripts/perf/run.ts 的 RunDeps.harnessEnv 注释），而 harness 是 run.ts 起的。
 *
 * 产物：<仓库>/data/runs/<harness>/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 沙盒 HOME：agy 的配置（$HOME/.gemini/antigravity-cli/）、凭据缓存、会话状态都落在这里。 */
const SANDBOX_HOME = join(import.meta.dir, ".home");
const SETTINGS_SRC = join(import.meta.dir, "settings.json");

if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    console.log("提示: 这是 Antigravity CLI 版 demo，harness 命令固定为");
    console.log("      `agy -p <prompt> --dangerously-skip-permissions`；");
    console.log(`      HOME 指向 ${SANDBOX_HOME}，端点经 GOOGLE_GEMINI_BASE_URL 指向本次 mock 端口。`);
    console.log("      默认剧本是 data/scenarios/long-run-antigravity.json（run_command 工具调用，--exhausted 默认 stop）。");
    process.exit(EXIT_OK);
}

/** 把沙盒配置同步进 $HOME（每次都覆盖，改了 settings.json 立即生效）。 */
function prepareSandbox(): void {
    const configDir = join(SANDBOX_HOME, ".gemini", "antigravity-cli");
    mkdirSync(configDir, { recursive: true });
    copyFileSync(SETTINGS_SRC, join(configDir, "settings.json"));
}

/**
 * 沙盒环境变量（走 runPerf 的 deps.harnessEnv）：
 * - HOME：配置与状态都指到沙盒，不碰用户真实的 ~/.gemini；
 * - GEMINI_API_KEY：走 API key 模式的前提（值与 settings.json 的 modelProvider 配套），
 *   mock 不校验内容，但**不能缺**——缺了 CLI 起不来；
 * - GOOGLE_GEMINI_BASE_URL：唯一的端点开关，不带 `/v1`（客户端自己拼
 *   `/v1beta/models/{model}:streamGenerateContent`）；
 * - HTTPS 代理指向本机拒绝连接端口，让自升级/遥测快速失败；本地 mock 显式绕过。
 *   此沙盒不适用于需要外部 HTTPS 的剧本。
 */
function sandboxEnv(config: PerfConfig): Record<string, string> {
    return {
        HOME: SANDBOX_HOME,
        GEMINI_API_KEY: "mock-key",
        GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${config.port}`,
        HTTPS_PROXY: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        // 同时覆盖大小写，避免继承的 NO_PROXY=* 或小写代理让外网绕过快速失败路径。
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
    };
}

try {
    const config = loadPerfConfig(argv, REPO_ROOT, {
        // 默认剧本：agy 的 shell 工具叫 run_command、参数是大驼峰的五项，沿用不了别家的。
        // 必须在**解析时**交出去：--script 的必填校验发生在解析里（见 PerfConfigDefaults）。
        scriptPath: "data/scenarios/long-run-antigravity.json",
    });

    // harness 工作目录默认是 playground/peri（peri 沙盒），这里固定为 agy 沙盒。
    if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
        config.workDir = import.meta.dir;
    }
    // 产物目录的身份：`data/runs/<harness>/<runId>/`。不给也能从启动命令推断（别名表里
    // agy → antigravity），但 demo 明确写出来更稳（命令被包装、换路径都不会影响落点）。
    if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
        config.harnessId = "antigravity";
    }

    // 耗尽策略跟着默认剧本走：长剧本要跑到自然结束才测得到端到端时长；loop 会一直供压
    // 到兜底超时，那是已经废弃的固定窗口口径。
    if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
        config.exhausted = "stop";
    }

    // 二进制：显式 --peri 优先，否则从 PATH 找 agy（官方安装脚本装到 ~/.local/bin）。
    const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
    const agyBin = explicitBin ? config.periPath : Bun.which("agy");
    if (agyBin === null) {
        throw new Error(
            "PATH 里找不到 agy，可 curl -fsSL https://antigravity.google/cli/install.sh | bash " +
                "（装到 ~/.local/bin/agy），或显式传 --peri <path>",
        );
    }

    prepareSandbox();

    process.exitCode = await runPerf(config, {
        harnessEnv: sandboxEnv,
        harnessCommand: (cfg: PerfConfig) => [
            agyBin,
            // -p / --print：单次无头运行，回答写 stdout，成功退 0。
            "-p",
            cfg.prompt,
            // headless 下没有交互提示，需要审批的工具会被软拒（白费一轮），剧本只放只读命令。
            "--dangerously-skip-permissions",
            ...cfg.periArgs,
        ],
    });
} catch (error) {
    console.error(`[perf] 启动失败: ${(error as Error).message}`);
    console.error("用法见 bun perf-demo.ts --help");
    process.exitCode = EXIT_SETUP;
}
