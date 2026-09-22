#!/usr/bin/env bun
/**
 * Kimi Code CLI（`kimi`，Moonshot）压测 demo —— 在 playground/kimi 目录里直接启动一次
 * `kimi -p <prompt>` 压测。
 *
 *   cd playground/kimi
 *   bun perf-demo.ts                      # 起 mock → 起 kimi → 每 100ms 采样 → 出记录
 *   bun perf-demo.ts --timeout-ms 600000  # 默认跑长剧本（data/scenarios/long-run-kimi.json）
 *   bun perf-demo.ts --help
 *
 * 与其他 demo 的差异：
 * - 二进制是官方单文件原生程序（macOS arm64 Mach-O，实测 2.0.0；官方安装脚本
 *   `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash` 装到 ~/.kimi-code/bin），
 *   从 PATH 找（`Bun.which("kimi")`），`--peri <path>` 可显式指定；
 * - harness 命令是 `kimi -p '<prompt>' -m llm-mock`：`-p`/`--prompt` 是官方**无头模式**
 *   （单个 prompt 进、最终回答出，stdout 是转录式输出，thinking / 工具进度走 stderr），
 *   成功退 0。`-p` 模式**自动按 auto 权限跑**（不再问审批，`--yolo` / `--auto` 与 `-p`
 *   互斥、传了会被拒），剧本自觉只放只读命令；
 * - 线协议是 **OpenAI Chat Completions**（`POST {base_url}/chat/completions`、stream），
 *   与 peri / opencode / pi / dsh / mcode / hermes / cline 同协议：provider 用
 *   `type = "openai"`，`/chat/completions` 由 CLI 自己拼，所以 base_url 要带 `/v1`；
 * - **隔离靠 `KIMI_CODE_HOME`** 指向本目录的 .kimi-home/：官方文档写明的数据根开关，
 *   config.toml / sessions / logs / credentials 全从它找，指到沙盒就不读用户的
 *   ~/.kimi-code（那里面有登录态与 hooks）。**不用换 HOME**——HOME 只在解析默认数据根时
 *   用一下，被 KIMI_CODE_HOME 覆盖（与 cline 同理，与 Claude Code / agy 相反）；
 * - provider 配置**只能靠 config.toml**（`[providers.llm-mock]` + `[models."llm-mock"]`，
 *   官方文档的 providers/models 两张表；CLI 明确不从 shell 环境变量取凭据，api_key 直接
 *   写文件、给假值即可——mock 不校验鉴权），每次启动按本次端口重写那份（与 pi 的
 *   models.json、mcode 的 config.yaml、hermes 的 config.yaml 同理）；
 * - **不注入死代理**（Codex / agy 那份）：loopback 恒直连（官方代理规则里
 *   localhost / 127.0.0.1 / ::1 永远不过代理），mock 直连没有悬念；它自己的外部请求
 *   （更新预检、遥测）用 KIMI_CODE_NO_AUTO_UPDATE=1 / KIMI_DISABLE_TELEMETRY=1 关掉，
 *   KIMI_DISABLE_CRON=1 关掉定时任务工具（Cline 的教训：对着死代理重试反而拖慢 4~5 倍）；
 * - **消费规律是几家里最干净的之一**（实测 2.0.0，标准 100 轮 × 4KB 剧本）：
 *   1. 一次 prompt 起步就是主请求（`messages=4`：system + 带 auto 权限 system-reminder 的
 *      user，**没有标题生成那一步**），之后每轮工具调用一条主请求；
 *   2. **没有上下文压缩**（max_context_size 给到 262144，末次请求 messages=204 也没触顶）、
 *      没有 peri 那样的预测请求、收尾后也不再发请求；
 *   3. 主流程吃到剧本尾部「任务结束」纯文本即自行收敛退出（退出码 0），
 *      `--exhausted stop` 的兜底收尾它用不到；
 *   所以默认剧本用 `--turns 100`（102 条 = 100 轮 + 2 条收尾），实测 101 条请求 =
 *   1 条初始 + 100 个工具轮 + 1 条收尾，**100 个工具轮正好跑满**（与 mcode 同一档）；
 * - 工具集含 Read / Write / Edit / Grep / Glob / **Bash** / WebSearch / FetchURL /
 *   TodoList / Agent / Skill / Task* / Cron* 等，shell 工具叫 **`Bash`**、参数
 *   `{command}` 必填（cwd / timeout 等可选）——与 peri / Claude Code 同形，所以剧本形状
 *   就是默认的 Bash + command（`gen-long-run.ts` 不带 --tool / --args 那一档）；
 * - harness.log 有内容（自行收尾时 stdout 里是最终回答，首行是 `kimi version 2.0.0`）；
 * - 环境变量必须走 deps.harnessEnv：Bun 1.4 下 `process.env.X = …` 不会被 Bun.spawn 继承
 *   （实测，见 scripts/perf/run.ts 的 RunDeps.harnessEnv 注释），而 harness 是 run.ts 起的。
 *
 * 产物：<仓库>/data/runs/kimi/<runId>/{run.json,perf.log,samples.csv,harness.log,mock.log}
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadPerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
/** 沙盒数据根（KIMI_CODE_HOME）：config.toml / sessions / logs 全落这里（CLI 默认 ~/.kimi-code）。 */
const SANDBOX = join(import.meta.dir, ".kimi-home");
/** 自定义 provider 的 id（config.toml 里 [providers.<id>] 的键名）。 */
const PROVIDER = "llm-mock";
/** 模型别名（config.toml 里 [models."<alias>"] 的键名，`-m` 与 default_model 都指它）。 */
const MODEL = "llm-mock";

if (import.meta.main && (argv.includes("-h") || argv.includes("--help"))) {
    console.log(USAGE);
    console.log("提示: 这是 Kimi Code CLI 版 demo，harness 命令固定为");
    console.log(`      kimi -p '<prompt>' -m ${MODEL}`);
    console.log(`      KIMI_CODE_HOME 指向本目录 .kimi-home/，provider 按本次端口写进它的 config.toml。`);
    console.log("      默认剧本是 data/scenarios/long-run-kimi.json（Bash 工具调用，--exhausted 默认 stop）。");
    process.exit(EXIT_OK);
}

/**
 * 按本次端口生成沙盒的 config.toml（官方 providers/models 两张表的形状，见
 * https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html ）。
 * base_url 必须带 `/v1`（CLI 自己拼 /chat/completions）；api_key 给假值——mock 不校验鉴权。
 * max_context_size 取 262144（kimi-for-coding 的真实窗口）：100 轮 × 4KB 剧本实测不触发压缩。
 */
export function sandboxConfig(port: number): string {
    return `default_model = "${MODEL}"
telemetry = false
default_permission_mode = "auto"
builtin_product_skills = false

[providers.${PROVIDER}]
type = "openai"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "mock-key"

[models."${MODEL}"]
provider = "${PROVIDER}"
model = "${MODEL}"
max_context_size = 262144
`;
}

// 被测试或其他模块导入时，只提供配置函数，不启动压测或修改宿主进程的退出码。
if (import.meta.main) {
    try {
        const config = loadPerfConfig(argv, REPO_ROOT, {
            scriptPath: "data/scenarios/long-run-kimi.json",
        });
        if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
            config.workDir = import.meta.dir;
        }
        if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
            config.harnessId = "kimi";
        }
        if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
            config.exhausted = "stop";
        }
        // 二进制：PATH 里的 kimi（官方安装脚本落 ~/.kimi-code/bin），--peri 可显式指定。
        const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
        const kimiBin = explicitBin ? config.periPath : Bun.which("kimi");
        if (kimiBin === null) {
            throw new Error(
                "PATH 里找不到 kimi：装官方发布版（curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash），" +
                    "或用 --peri <path> 显式指定",
            );
        }
        // 版本自查：官方 kimi-code 的 --version 只打一个裸语义版本号（实测 2.0.0）。
        // 老的 kimi-cli（另一个产品）也提供 kimi 这个 bin 名，输出不是这个形状，先挡掉。
        const version = Bun.spawnSync([kimiBin, "--version"], { stderr: "pipe" });
        const versionText = version.stdout.toString().trim();
        if (version.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(versionText)) {
            throw new Error(
                `${kimiBin} --version 输出不符合 kimi-code 的形状（实测 2.0.0 只打印裸版本号），收到: ` +
                    `${JSON.stringify(versionText.slice(0, 80))}；注意别把老 kimi-cli 的 bin 当成 kimi-code`,
            );
        }
        mkdirSync(SANDBOX, { recursive: true });
        const configFile = join(SANDBOX, "config.toml");
        // 全量覆盖：沙盒里不会越压越多份，端口变化只影响这一个文件。
        writeFileSync(configFile, sandboxConfig(config.port));
        process.exitCode = await runPerf(config, {
            harnessEnv: () => ({
                KIMI_CODE_HOME: SANDBOX,
                KIMI_DISABLE_TELEMETRY: "1",
                KIMI_CODE_NO_AUTO_UPDATE: "1",
                KIMI_DISABLE_CRON: "1",
                NO_PROXY: "127.0.0.1,localhost,::1",
                no_proxy: "127.0.0.1,localhost,::1",
            }),
            harnessCommand: (cfg) => [kimiBin, "-p", cfg.prompt, "-m", MODEL, ...cfg.periArgs],
        });
    } catch (error) {
        console.error(`[perf] 启动失败: ${(error as Error).message}`);
        process.exitCode = EXIT_SETUP;
    }
}
