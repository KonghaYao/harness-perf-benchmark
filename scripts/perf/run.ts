#!/usr/bin/env bun
/**
 * harness 压测采样器：一条命令跑完「起 mock → 起 harness → 定时采样 → 出记录」。
 *
 *   1. 起 mock server（指定剧本，轮询 /__mock/status 等就绪）；
 *   2. 在 work-dir（默认 playground/peri，其 .peri/settings.json 把 provider 指向 mock）下起 harness；
 *   3. 每 interval-ms（默认 100ms）采一次 harness 进程的 CPU 与 RSS——**不采 GPU**；
 *   4. 全程写进一次运行自己的目录 `<out-dir>/<harness>/<runId>/`（见下），结束时打印摘要。
 *
 * 产物布局（一次运行 = 一个可整个拷走的目录）：
 *
 *   <out-dir>/<harness>/<runId>/run.json      机器接口：身份 / 配置 / 时间线 / 分段 / 摘要 / 退出码
 *                              samples.csv    逐拍原始采样
 *                              perf.log       人读时间线 + 末尾摘要
 *                              harness.log    harness stdout/stderr 原文
 *                              mock.log       mock 输出原文
 *
 * `run.json` 分两次写：开跑时写 `status:"running"` 的那批（即使进程被 kill -9，也知道这是谁在跑什么），
 * 结束时原子替换补全（`finally` 里兜底，早退路径也会留下 status）。读取端只认 `run.json`，
 * 不再从中文日志里正则扒字段——那是老布局的坑，见 legacy-run.ts。
 *
 * 采样口径与选型依据见 scripts/perf/sampler.ts 的文件头；可用 `bun run scripts/perf/verify.ts`
 * 复现「已知负载 → 读数」的验证实验。
 *
 * 异常路径一律收敛到明确日志 + 退出码，并在 finally 里按**进程组**回收 mock 与 harness
 * （harness 会 spawn 子进程，只杀父进程会留孤儿）。采样数据先进内存缓冲、每 1s 落盘一次，
 * 避免每拍同步 I/O 干扰被测对象。
 */

import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { cpus, hostname, loadavg, platform, release, totalmem } from "node:os";
import { join, relative } from "node:path";
import { REPO_ROOT, formatRunId, loadPerfConfig, type PerfConfig } from "./config";
import { harnessIdFromCommand } from "./harness-id";
import {
    RUN_META_SCHEMA_VERSION,
    hostSnapshot,
    writeJsonAtomic,
    type RunMeta,
    type RunStatus,
} from "./run-meta";
import {
    CSV_HEADER,
    ProcessSampler,
    createPsBackend,
    createRusageBackend,
    formatCsvRow,
    summarize,
    type ProcessSample,
    type SampleSummary,
    type SamplerBackend,
} from "./sampler";

export const EXIT_OK = 0;
/** 配置 / mock / 环境错误。 */
export const EXIT_SETUP = 1;
/** 采样对象提前退出且退出码非 0。 */
export const EXIT_HARNESS = 2;
/** 超时被强制终止。 */
export const EXIT_TIMEOUT = 3;
/** 被 SIGINT / SIGTERM 中断。 */
export const EXIT_INTERRUPTED = 130;

/** 收到终止信号后等待进程自行退出的宽限期，超时再 SIGKILL。 */
const KILL_GRACE_MS = 3000;
/** 就绪探活轮询间隔。 */
const READY_POLL_MS = 100;
/** 采样数据落盘周期（毫秒）。 */
const FLUSH_INTERVAL_MS = 1000;

/** 命令行说明；playground/peri/perf-demo.ts 也复用它。 */
export const USAGE = `llm-mock 压测采样器 —— 起 mock、起 harness、定时采样、出记录

用法:
  bun run scripts/perf/run.ts --script data/scenarios/long-run.json --exhausted stop --timeout-ms 600000
  bun run scripts/perf/run.ts [选项]

选项:
  --turns <n>             传给 harness 的 --max-turns（默认 25）
  --interval-ms <n>       采样间隔毫秒（默认 100）
  --timeout-ms <n>        兜底时限毫秒，到点强制终止 harness（默认 60000）
  --ready-timeout-ms <n>  mock 就绪等待上限毫秒（默认 10000）
  --prompt <text>         harness 的提示词
  --script <path>         mock 剧本（**必填**；剧本由生成器现造，例：data/scenarios/long-run.json）
  --peri <path>           harness 二进制（默认只认 PATH 里的发布版 peri；PATH 里没有就必须显式指定，
                          本工具不会去猜 ../perihelion 的本地 debug 构建）
  --work-dir <path>       harness 工作目录（默认 playground/peri）
  --out-dir <path>        产物根目录（默认 data/runs）
  --harness <id>          harness 身份（目录名，如 claude-code）。不给就从启动命令推断
  --label <text>          批次/场景标签，写进 run.json，便于日后按批次筛（可选）
  --port <n>              mock 端口（默认 3457）
  --exhausted <policy>    mock 剧本耗尽策略：loop（默认，可持续供压）| stop | hold | error
                           stop 让 mock 在剧本走完后返回「任务结束」纯文本，harness 自行收尾退出，
                           用于「跑完一整个长剧本、测端到端时长」（超时只作兜底，读数不该用它）；
                           hold/error 下剧本走完即停，harness 有机会自行退出并写出 harness.log
  --sampler <kind>        采样后端：rusage（默认，FFI proc_pid_rusage）| ps（兜底）
  --no-tree               不统计 harness 的后代进程（默认统计，含其拉起的 MCP 子进程）
  --peri-arg <arg>        透传给 harness 的参数，可重复。值以 - 开头时必须用 --peri-arg=<值>：
                            --peri-arg=--db-path --peri-arg=/tmp/peri.db
  -h, --help              显示本帮助

产物（一次运行 = 一个目录，可整个拷走）:
  <out-dir>/<harness>/<runId>/run.json     机器接口：身份 / 配置 / 时间线 / 分段 / 摘要 / 退出码
                             samples.csv   逐拍原始采样，列：${CSV_HEADER}
                             perf.log      时间线事件 + 每秒采样摘要 + 末尾总摘要（人读）
                             harness.log   harness 的 stdout/stderr
                             mock.log      mock server 的输出
  <runId> 形如 20260919-153012；同秒第二次运行自动加 -2 后缀。

退出码:
  0 正常   1 配置/mock/环境错误   2 harness 非 0 退出   3 超时被强制终止   130 被中断
`;

/** 一次进程的退出结果。 */
interface ExitInfo {
    code: number | null;
    signal: string | null;
}

/** 被托管的子进程：只需这些字段即可做回收。 */
interface ManagedProcess {
    readonly pid: number;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly exited: Promise<number>;
}

export interface RunDeps {
    /** 构造 harness 命令行（测试注入假 harness）。 */
    harnessCommand?: (config: PerfConfig) => string[];
    /**
     * 追加到 harness 进程的环境变量。
     *
     * **必须走这里而不是 `process.env.X = …`**：Bun 1.4 下 `Bun.spawn` 不继承运行时对
     * `process.env` 的赋值（实测子进程读到空值），只有显式传 `env` 才生效。
     * harness 的沙盒隔离（HOME / XDG_* / CODEX_HOME 等）都依赖它。
     */
    harnessEnv?: (config: PerfConfig) => Record<string, string>;
    /** 构造 mock server 命令行（测试注入假 mock）。 */
    mockCommand?: (config: PerfConfig) => string[];
    /** mock 就绪探活（测试注入）。 */
    probeReady?: (url: string) => Promise<boolean>;
    /** 采样后端（测试注入假后端）。 */
    backend?: SamplerBackend;
    /** stdout 输出。 */
    log?: (line: string) => void;
    /** 单调时钟（毫秒）。 */
    clock?: () => number;
    /** 墙上时钟（epoch 毫秒）：与 mock 侧记的请求时刻同源，用于把端到端时长拆段。 */
    epochNow?: () => number;
}

function defaultHarnessCommand(config: PerfConfig): string[] {
    if (config.periPath === null) {
        throw new Error(
            "PATH 里找不到 peri：装好发布版（Bun.which(\"peri\") 能命中），或用 --peri <path> 显式指定。" +
                "本工具不会回退 ../perihelion 的 debug 构建——那种读数不能与发布版混着用",
        );
    }
    return [
        config.periPath,
        "-p",
        config.prompt,
        "--max-turns",
        String(config.turns),
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        ...config.periArgs,
    ];
}

function defaultMockCommand(config: PerfConfig): string[] {
    return [
        process.execPath,
        "run",
        join(REPO_ROOT, "src/server.ts"),
        "--script",
        config.scriptPath,
        "--port",
        String(config.port),
        "--exhausted",
        config.exhausted,
    ];
}

async function defaultProbeReady(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) return false;
        // 只看 HTTP 200 不够：端口上可能蹲着别的 HTTP 服务（实测踩过——一个对任意路径都回 200 的
        // 抓包服务器让探活误判成功，随后 mock 因 EADDRINUSE 退出，整轮压测静默打到别人身上）。
        // 因此按 /__mock/status 的契约校验字段。
        // 注意这仍拦不住「端口上蹲着**另一个 llm-mock 实例**」（字段当然齐备），那一路由
        // 「我们起的 mock 进程是否还活着」来兜——见 waitMockReady 的注释。
        const status = (await response.json()) as Record<string, unknown>;
        return typeof status.size === "number" && typeof status.index === "number";
    } catch {
        return false;
    }
}

/**
 * mock 启动失败的报错文案（退出码 + 日志末尾）。端口被占是最常见的一种，
 * 单独点出来——要判断端口被占只能看 mock 自己的日志（`Failed to start server. Is port … in use?`）。
 */
function mockStartFailure(code: number, logFile: string, port: number): string {
    const tail = tailOf(logFile);
    const portTaken = /in use|EADDRINUSE|Failed to start server/i.test(tail);
    return (
        `mock 启动失败（退出码 ${code}），日志末尾: ${tail}` +
        (portTaken ? `；端口 ${port} 已被占用，用 --port 换一个` : "")
    );
}

/** 命令行的可读形式（含引号，方便直接复制重跑）。 */
function quote(command: readonly string[]): string {
    return command
        .map((part) => (/^[\w./=:-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
        .join(" ");
}

/** 环境变量摘要：打印键名与值，但凭据类只留键名（避免把密钥写进日志）。 */
function describeEnv(env: Record<string, string>): string {
    const CREDENTIAL = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
    return Object.entries(env)
        .map(([key, value]) => {
            const shown = CREDENTIAL.test(key) ? "***" : value;
            return `${key}=${quote([shown])}`;
        })
        .join(" ");
}

function mb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 单行采样摘要（每个落盘周期写一行，便于肉眼扫时间线）。 */
function progressLine(sample: ProcessSample, index: number): string {
    return (
        `采样 #${index} t=${(sample.elapsedMs / 1000).toFixed(2)}s ` +
        `cpu=${sample.cpuPercent.toFixed(1)}% rss=${mb(sample.rssBytes)} | ` +
        `进程树 cpu=${sample.treeCpuPercent.toFixed(1)}% rss=${mb(sample.treeRssBytes)} ` +
        `procs=${sample.procs}`
    );
}

function summaryLines(summary: SampleSummary, config: PerfConfig): string[] {
    if (summary.count === 0) {
        return ["样本数: 0（采样对象在首次采样前就退出了）"];
    }
    const cpuMean = `CPU 主进程: 平均 ${summary.cpuMean.toFixed(1)}%`;
    const rss = {
        mean: mb(summary.rssMeanBytes),
        max: mb(summary.rssMaxBytes),
        last: mb(summary.rssLastBytes),
    };
    return [
        `样本数: ${summary.count}（间隔 ${config.intervalMs}ms）`,
        `总时长: ${(summary.durationMs / 1000).toFixed(1)}s`,
        `${cpuMean} · 峰值 ${summary.cpuMax.toFixed(1)}%（单核为 100%）`,
        `RSS 主进程: 平均 ${rss.mean} · 峰值 ${rss.max} · 末尾 ${rss.last}`,
        `CPU 进程树: 平均 ${summary.treeCpuMean.toFixed(1)}% · 峰值 ${summary.treeCpuMax.toFixed(1)}%`,
        `RSS 进程树: 平均 ${mb(summary.treeRssMeanBytes)} · 峰值 ${mb(summary.treeRssMaxBytes)}`,
    ];
}

/** 按进程组发信号；进程组不可用（已退出等）时退回单进程。 */
function signalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    try {
        process.kill(-pid, signal);
        return;
    } catch {
        // 进程组不存在：继续尝试单进程。
    }
    try {
        process.kill(pid, signal);
    } catch {
        // 已退出：无需处理。
    }
}

/** 优雅终止：SIGTERM → 宽限 → SIGKILL。 */
async function stopProcess(
    proc: ManagedProcess,
    label: string,
    note: (line: string) => void,
): Promise<void> {
    if (proc.exitCode !== null) return;
    signalProcess(proc.pid, "SIGTERM");
    const exited = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(KILL_GRACE_MS).then(() => false),
    ]);
    if (exited) return;
    note(`警告 ${label} 未在 ${KILL_GRACE_MS}ms 内退出，发送 SIGKILL`);
    signalProcess(proc.pid, "SIGKILL");
    await proc.exited;
}

function tailOf(path: string, lines = 5): string {
    try {
        const content = readFileSync(path, "utf8").trimEnd().split("\n");
        return content.slice(-lines).join(" | ");
    } catch {
        return "(无日志)";
    }
}

/**
 * 从 mock 日志里数请求数——**只作兜底**（mock 提前挂掉、读不到 /__mock/status 时）。
 * 主路径用 status.requests：stop 策略下剧本耗尽后的收尾响应不消费剧本，日志里也不会写
 * 「消费第 N 条」，按行数数会漏掉尾巴上的几次请求。
 */
function countMockRequests(path: string): number {
    try {
        return readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => line.includes("→ 消费第")).length;
    } catch {
        return 0;
    }
}

/**
 * 把端到端时长拆成三段：启动（起进程 → 首个请求）、运转（首个请求 → 末次请求）、
 * 收尾（末次请求 → 退出）。mock 侧记的请求时刻与 harness 起止是同一台机器的同一个钟，
 * 直接相减即可。实测这个拆分很有必要：peri / Codex 的所谓「启动开销」大半是收尾期的
 * 固定等待（见 docs/perf-compare.md），只看总时长会把账记到启动头上。
 *
 * 日志（segmentLines）与 run.json（segments 字段）共用这一处计算，免得两处各算一遍。
 * mock 一个请求都没收到时返回 null——拆不出来就说拆不出来，不猜。
 */
export function segmentsOf(
    status: Record<string, unknown> | null,
    startEpoch: number,
    exitEpoch: number,
): { startupMs: number; spanMs: number; tailMs: number; idleTail: boolean } | null {
    const first = typeof status?.firstRequestAt === "number" ? status.firstRequestAt : null;
    const last = typeof status?.lastRequestAt === "number" ? status.lastRequestAt : null;
    if (first === null || last === null) return null;
    const tailMs = exitEpoch - last;
    return {
        startupMs: first - startEpoch,
        spanMs: last - first,
        tailMs,
        // 收尾段一秒以上没有任何请求 = harness 在自己的宽限期里空等（peri 5s / Codex 10s）。
        idleTail: tailMs >= 1000,
    };
}

function segmentLines(
    status: Record<string, unknown> | null,
    startEpoch: number,
    exitEpoch: number,
): string[] {
    const segments = segmentsOf(status, startEpoch, exitEpoch);
    if (segments === null) return ["时长分段: （mock 未收到请求，拆不出来）"];
    const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
    return [
        `时长分段: 启动 → 首个请求 ${seconds(segments.startupMs)} ｜ 首个请求 → 末次请求 ` +
            `${seconds(segments.spanMs)} ｜ 末次请求 → 退出 ${seconds(segments.tailMs)}` +
            (segments.idleTail ? "（收尾零请求：harness 自己的退出等待，与剧本轮数无关）" : ""),
    ];
}

/** 文件 stat → run.json 的 binary 字段（不存在给 null，不抛）。 */
function statOrNull(path: string): { path: string; sizeBytes: number; mtimeMs: number } | null {
    try {
        const info = statSync(path);
        return { path, sizeBytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
    } catch {
        return null;
    }
}

/** 剧本的 sha256 前 16 位（跨机器复测时确认「同一份剧本」）。 */
function hashOrNull(path: string): string | null {
    try {
        return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
    } catch {
        return null;
    }
}

/**
 * runId：`YYYYMMDD-HHMMSS`（本地时区）。同一秒里的第二次运行加 `-2` / `-3` 后缀——
 * 否则两次运行会写进同一组文件（老布局用 `flag:"a"` 追加，实测会静默交错）。
 */
export function uniqueRunId(dir: string): string {
    const base = formatRunId(new Date());
    if (!existsSync(join(dir, base))) return base;
    for (let n = 2; ; n += 1) {
        const candidate = `${base}-${n}`;
        if (!existsSync(join(dir, candidate))) return candidate;
    }
}

/** 产物文件清单 → run.json 的 artifacts（字节数用来判断 harness.log 是否为空的强杀产物）。 */
function artifactsOf(
    files: Record<"perf" | "samples" | "harness" | "mock", string>,
): RunMeta["artifacts"] {
    const entries = Object.entries(files).map(([role, path]) => {
        const info = statOrNull(path);
        return [role, info === null ? null : { file: path.split("/").pop()!, bytes: info.sizeBytes }];
    });
    return Object.fromEntries(entries) as RunMeta["artifacts"];
}

async function fetchMockStatus(url: string): Promise<Record<string, unknown> | null> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) return null;
        return (await response.json()) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/**
 * 跑一次压测。返回退出码（不抛异常），便于测试直接断言。
 */
export async function runPerf(config: PerfConfig, deps: RunDeps = {}): Promise<number> {
    const clock = deps.clock ?? (() => performance.now());
    const epochNow = deps.epochNow ?? (() => Date.now());
    const stdout = deps.log ?? ((line: string) => console.log(line));
    const probeReady = deps.probeReady ?? defaultProbeReady;
    const harnessCommand = deps.harnessCommand ?? defaultHarnessCommand;
    const mockCommand = deps.mockCommand ?? defaultMockCommand;

    // 命令行要在建目录之前算出来：harness 身份要么由 --harness / demo 显式给出，
    // 要么就从它的第一个 token 推断（见 harness-id.ts 的解析顺序）。
    const command = harnessCommand(config);
    const harnessId = config.harnessId ?? harnessIdFromCommand(command);
    const runId = uniqueRunId(join(config.outDir, harnessId));
    // 一次运行 = 一个自包含目录：整个拷走就是一次完整记录。
    const runDir = join(config.outDir, harnessId, runId);
    const files = {
        perf: join(runDir, "perf.log"),
        samples: join(runDir, "samples.csv"),
        harness: join(runDir, "harness.log"),
        mock: join(runDir, "mock.log"),
    };
    const metaPath = join(runDir, "run.json");
    const statusUrl = `http://127.0.0.1:${config.port}/__mock/status`;

    let perfBuffer: string[] = [];
    let t0 = clock();
    const flushPerf = (): void => {
        if (perfBuffer.length === 0) return;
        try {
            appendFileSync(files.perf, perfBuffer.join("\n") + "\n");
        } catch {
            // 落盘失败不应掩盖真正的错误；内容仍在内存里，最后由调用方报错。
        }
        perfBuffer = [];
    };
    const timeline = (message: string): void => {
        perfBuffer.push(`[+${((clock() - t0) / 1000).toFixed(3)}s] ${message}`);
        stdout(`[perf] ${message}`);
    };
    const fail = (message: string): void => {
        perfBuffer.push(`[+${((clock() - t0) / 1000).toFixed(3)}s] 错误 ${message}`);
        stdout(`[perf] 失败: ${message}`);
    };

    let mock: ManagedProcess | null = null;
    let harness: ManagedProcess | null = null;
    let mockFd: number | null = null;
    let harnessFd: number | null = null;
    let timedOut = false;
    let interrupted = false;
    const onSignal = (): void => {
        interrupted = true;
    };

    // run.json 的内容随跑随填（时间线、分段、摘要都要等跑完）；finish() 负责落盘并定 status。
    const meta: RunMeta = {
        schemaVersion: RUN_META_SCHEMA_VERSION,
        runId,
        status: "running",
        error: null,
        legacy: null,
        harness: {
            id: harnessId,
            idSource: config.harnessId === null ? "command" : "explicit",
            command,
            commandLine: quote(command),
            cwd: config.workDir,
            binary: statOrNull(command[0]),
            version: null,
            env: null,
        },
        scenario: {
            path: config.scriptPath,
            relPath: relative(REPO_ROOT, config.scriptPath).startsWith("..")
                ? null
                : relative(REPO_ROOT, config.scriptPath),
            name: config.scriptPath.split("/").pop() ?? config.scriptPath,
            sizeBytes: statOrNull(config.scriptPath)?.sizeBytes ?? null,
            sha256: hashOrNull(config.scriptPath),
        },
        mock: {
            port: config.port,
            exhausted: config.exhausted,
            readyMs: null,
            requests: null,
            requestsSource: null,
            cursor: null,
        },
        sampling: {
            intervalMs: config.intervalMs,
            // 开跑先记请求值，跑完由实际 backend 覆盖（rusage 不可用时会回退到 ps）。
            backend: config.sampler,
            withTree: config.withTree,
            format: "csv",
        },
        limits: {
            timeoutMs: config.timeoutMs,
            readyTimeoutMs: config.readyTimeoutMs,
            maxTurns: config.turns,
        },
        prompt: config.prompt,
        label: config.label,
        host: hostSnapshot(),
        startedAtMs: epochNow(),
        startedAt: new Date().toISOString(),
        endedAtMs: null,
        endedAt: null,
        duration: { endToEndMs: null, samplingWindowMs: null },
        timing: {
            harnessStartedAtMs: null,
            samplingStartedAtMs: null,
            firstRequestAtMs: null,
            lastRequestAtMs: null,
            harnessExitedAtMs: null,
        },
        segments: null,
        summary: null,
        summarySource: null,
        exit: null,
        artifacts: null,
    };

    let finalized = false;
    /** 定稿并原子落盘。早退路径也要调它——半截的 run 与跑完的 run 必须能分辨。 */
    const finish = (status: RunStatus): void => {
        if (finalized) return;
        finalized = true;
        meta.status = status;
        meta.endedAtMs = epochNow();
        meta.endedAt = new Date(meta.endedAtMs).toISOString();
        if (meta.host !== null) {
            const [one, five, fifteen] = loadavg();
            meta.host.loadAvgEnd = [one ?? 0, five ?? 0, fifteen ?? 0];
        }
        meta.artifacts = artifactsOf(files);
        try {
            writeJsonAtomic(metaPath, meta);
        } catch {
            // 落盘失败不该掩盖真正的错误。
        }
    };

    try {
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
            files.perf,
            [
                "# llm-mock 压测记录",
                `runId: ${runId}`,
                `harness: ${harnessId}`,
                `开始: ${meta.startedAt}`,
                `产物目录: ${runDir}`,
                "",
            ].join("\n") + "\n",
        );
        writeFileSync(files.samples, CSV_HEADER + "\n");
        writeJsonAtomic(metaPath, meta);
        // 起手就把 run.json 落盘：即使进程随后被 kill -9，也留下「谁在跑什么」。
        stdout(`[perf] 产物目录: ${runDir}`);
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);

        // 查的是真正会被 spawn 的那个二进制（command[0]）：各 demo 用自家 harness 时
        // config.periPath 可能是 null（PATH 里没有 peri），不该拿它当判据。
        for (const [label, path] of [
            ["harness 二进制", command[0]],
            ["mock 剧本", config.scriptPath],
            ["harness 工作目录", config.workDir],
        ] as const) {
            if (!existsSync(path)) {
                fail(`${label}不存在: ${path}`);
                meta.error = `${label}不存在: ${path}`;
                finish("setup-error");
                return EXIT_SETUP;
            }
        }

        // 1. 起 mock
        const mockCmd = mockCommand(config);
        timeline(`启动 mock: ${quote(mockCmd)}`);
        mockFd = openSync(files.mock, "a");
        mock = Bun.spawn(mockCmd, {
            cwd: REPO_ROOT,
            detached: true,
            stdin: "ignore",
            stdout: mockFd,
            stderr: mockFd,
        });

        // 2. 等 mock 就绪
        const readyDeadline = clock() + config.readyTimeoutMs;
        let ready = false;
        let status: Record<string, unknown> | null = null;
        while (clock() < readyDeadline) {
            if (mock.exitCode !== null) {
                const message = mockStartFailure(mock.exitCode, files.mock, config.port);
                fail(message);
                meta.error = message;
                finish("setup-error");
                return EXIT_SETUP;
            }
            if (await probeReady(statusUrl)) {
                status = await fetchMockStatus(statusUrl);
                // 探活成功 ≠ 端口上听着的就是**我们起的那个 mock**：可能蹲着上一轮残留的实例
                // （实测踩过——旧的 mock 占着端口、/__mock/status 字段齐备，我们自己的 mock
                // 已因 EADDRINUSE 退出，整轮压测于是静默打到旧实例上：请求数 0，harness 收到的
                // 是别人剧本的回复）。用剧本路径做身份核对：它由本进程按绝对路径指定，
                // 别人的实例对不上；对不上就直接失败，别拿别人的数据出报告。
                if (status?.source === config.scriptPath) {
                    ready = true;
                    break;
                }
                const message =
                    `端口 ${config.port} 上听着的不是本次启动的 mock：状态里的剧本是 ` +
                    `${status === null ? "（读不到）" : String(status.source)}，` +
                    `本次是 ${config.scriptPath}；多半是上一轮残留的 mock，` +
                    `用 --port 换一个端口，或先把它杀掉`;
                fail(message);
                meta.error = message;
                finish("setup-error");
                return EXIT_SETUP;
            }
            await Bun.sleep(READY_POLL_MS);
        }
        if (!ready) {
            const message =
                `等待 mock 就绪超时（${config.readyTimeoutMs}ms）: ${statusUrl} 无响应；` +
                `端口 ${config.port} 可能被别的进程占用，或 mock 卡在启动`;
            fail(message);
            meta.error = message;
            finish("setup-error");
            return EXIT_SETUP;
        }
        meta.mock.readyMs = Math.round(clock() - t0);
        meta.mock.cursor = {
            index: typeof status?.index === "number" ? status.index : 0,
            size: typeof status?.size === "number" ? status.size : 0,
            exhausted: status?.exhausted === true,
        };
        timeline(
            `mock 就绪: http://127.0.0.1:${config.port}（剧本 ${status?.size ?? "?"} 条，` +
                `耗尽策略 ${status?.policy ?? "?"}）`,
        );

        // 3. 起 harness
        const extraEnv = deps.harnessEnv?.(config);
        if (extraEnv !== undefined) {
            // 凭据只留键名：run.json 与 perf.log 都会被分享出去。
            meta.harness.env = Object.fromEntries(
                Object.entries(extraEnv).map(([key, value]) => [
                    key,
                    /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) ? "***" : value,
                ]),
            );
        }
        timeline(
            `启动 harness: ${quote(command)}（cwd=${config.workDir}` +
                (extraEnv === undefined ? "" : `，env +${describeEnv(extraEnv)}`) +
                "）",
        );
        harnessFd = openSync(files.harness, "a");
        const harnessStart = clock();
        // 墙上时刻另记一份：mock 侧的首/末次请求时刻也是 epoch 毫秒，两边要能相减。
        const harnessStartEpoch = epochNow();
        meta.timing.harnessStartedAtMs = harnessStartEpoch;
        harness = Bun.spawn(command, {
            cwd: config.workDir,
            detached: true,
            stdin: "ignore",
            stdout: harnessFd,
            stderr: harnessFd,
            ...(extraEnv === undefined ? {} : { env: { ...process.env, ...extraEnv } }),
        });
        const harnessProc = harness;
        const harnessPid = harness.pid;

        // 4. 采样
        let backend = deps.backend;
        if (backend === undefined) {
            const rusage = createRusageBackend();
            if (config.sampler === "ps") backend = createPsBackend();
            else if (rusage !== null) backend = rusage;
            else {
                timeline("警告 proc_pid_rusage 不可用，回退到 ps 后端（分辨率约 50ms）");
                backend = createPsBackend();
            }
        }
        meta.sampling.backend = backend.kind;
        timeline(
            `采样开始: ${backend.describe()}，间隔 ${config.intervalMs}ms，` +
                `落盘周期 ${FLUSH_INTERVAL_MS}ms`,
        );
        const sampler = new ProcessSampler({ pid: harnessPid, backend, withTree: config.withTree });
        if (!sampler.prime()) {
            const message =
                `采样对象 pid=${harnessPid} 在首次采样前已退出` +
                `（退出码 ${harnessProc.exitCode ?? "null"}）；` +
                `harness 日志末尾: ${tailOf(files.harness, 3)}`;
            fail(message);
            meta.error = message;
            finish("harness-exit");
            return EXIT_HARNESS;
        }
        if (config.withTree) sampler.refreshTree();

        const samples: ProcessSample[] = [];
        const csvBuffer: string[] = [];
        const samplingStart = clock();
        meta.timing.samplingStartedAtMs = epochNow();
        const deadline = samplingStart + config.timeoutMs;
        let nextTick = samplingStart + config.intervalMs;
        let lastReadAt = samplingStart;
        let nextFlushAt = samplingStart + FLUSH_INTERVAL_MS;

        while (harnessProc.exitCode === null && !interrupted) {
            const now = clock();
            if (now >= deadline) {
                timedOut = true;
                break;
            }
            const wait = nextTick - now;
            if (wait > 0) await Bun.sleep(wait);
            nextTick += config.intervalMs;

            const readAt = clock();
            const sample = sampler.sample({
                elapsedMs: readAt - samplingStart,
                deltaMs: readAt - lastReadAt,
            });
            lastReadAt = readAt;
            if (sample === null) {
                timeline(`采样中止: harness 进程 pid=${harnessPid} 已不存在`);
                break;
            }
            samples.push(sample);
            csvBuffer.push(formatCsvRow(sample));

            if (readAt >= nextFlushAt) {
                // 落盘：CSV 原始行 + 一行人读摘要。周期内只进内存，避免每拍同步 I/O。
                if (csvBuffer.length > 0) {
                    appendFileSync(files.samples, csvBuffer.join("\n") + "\n");
                    csvBuffer.length = 0;
                }
                perfBuffer.push(
                    `[+${((readAt - t0) / 1000).toFixed(3)}s] ${progressLine(sample, samples.length)}`,
                );
                flushPerf();
                nextFlushAt = readAt + FLUSH_INTERVAL_MS;
            }
        }

        // 5. 收尾：先停 harness（超时/中断时它还活着），再查 mock 状态、停 mock
        if (harnessProc.exitCode === null) {
            const reason = interrupted ? "收到中断信号" : `超时 ${config.timeoutMs}ms`;
            timeline(
                `${reason}: 终止 harness（pid=${harnessPid}，按进程组回收）；注意 peri 在 -p 模式下` +
                    "只在自行退出时 flush 输出，强杀会让 harness.log 为空",
            );
            await stopProcess(harnessProc, "harness", timeline);
        }
        const exit: ExitInfo = { code: harnessProc.exitCode, signal: harnessProc.signalCode };
        // 端到端时长单独记：采样窗口的 durationMs 只覆盖「首次采样 → 最后一次采样」，
        // 比 harness 真实存活时间略短。长剧本实验比的就是这个数，口径要说清楚。
        const harnessElapsedMs = clock() - harnessStart;
        const harnessExitEpoch = epochNow();
        meta.exit = exit;
        meta.timing.harnessExitedAtMs = harnessExitEpoch;
        meta.duration.endToEndMs = Math.round(harnessElapsedMs);
        timeline(
            `harness 退出: code=${exit.code ?? "null"} signal=${exit.signal ?? "无"}，` +
                `存活 ${(harnessElapsedMs / 1000).toFixed(1)}s`,
        );

        const finalStatus = await fetchMockStatus(statusUrl);
        await stopProcess(mock, "mock", timeline);
        timeline(
            `mock 已停止: code=${mock.exitCode ?? "null"} signal=${mock.signalCode ?? "无"}`,
        );
        if (csvBuffer.length > 0) {
            appendFileSync(files.samples, csvBuffer.join("\n") + "\n");
            csvBuffer.length = 0;
        }
        closeFileDescriptors();

        const requests =
            typeof finalStatus?.requests === "number"
                ? finalStatus.requests
                : countMockRequests(files.mock);
        const summary = summarize(samples);
        meta.mock.requests = requests;
        meta.mock.requestsSource = typeof finalStatus?.requests === "number" ? "status" : "mock-log";
        if (finalStatus !== null) {
            meta.mock.cursor = {
                index: typeof finalStatus.index === "number" ? finalStatus.index : 0,
                size: typeof finalStatus.size === "number" ? finalStatus.size : 0,
                exhausted: finalStatus.exhausted === true,
            };
        }
        meta.timing.firstRequestAtMs =
            typeof finalStatus?.firstRequestAt === "number" ? finalStatus.firstRequestAt : null;
        meta.timing.lastRequestAtMs =
            typeof finalStatus?.lastRequestAt === "number" ? finalStatus.lastRequestAt : null;
        meta.duration.samplingWindowMs = Math.round(summary.durationMs);
        meta.segments = segmentsOf(finalStatus, harnessStartEpoch, harnessExitEpoch);
        meta.summary = { ...summary };
        meta.summarySource = "runtime";
        perfBuffer.push("", "=== 摘要 ===", ...summaryLines(summary, config));
        perfBuffer.push(
            `mock 请求数: ${requests}` +
                (summary.durationMs > 0
                    ? `（${(requests / (summary.durationMs / 1000)).toFixed(1)} 次/秒）`
                    : ""),
            `mock 游标: index=${finalStatus?.index ?? "?"} / ${finalStatus?.size ?? "?"}`,
            `端到端时长: ${(harnessElapsedMs / 1000).toFixed(1)}s（harness 启动 → 退出；` +
                `采样窗口 ${(summary.durationMs / 1000).toFixed(1)}s）`,
            ...segmentLines(finalStatus, harnessStartEpoch, harnessExitEpoch),
            `产物: ${runDir}（run.json · perf.log · samples.csv · harness.log · mock.log）`,
        );
        flushPerf();
        stdout("[perf] === 摘要 ===");
        for (const line of summaryLines(summary, config)) stdout(`[perf] ${line}`);
        stdout(`[perf] mock 请求数: ${requests} · 产物: ${runDir}`);
        stdout(`[perf] 端到端时长: ${(harnessElapsedMs / 1000).toFixed(1)}s`);
        for (const line of segmentLines(finalStatus, harnessStartEpoch, harnessExitEpoch)) {
            stdout(`[perf] ${line}`);
        }

        if (interrupted) {
            finish("interrupted");
            return EXIT_INTERRUPTED;
        }
        if (timedOut) {
            finish("timeout");
            return EXIT_TIMEOUT;
        }
        if (exit.code === 0) {
            finish("ok");
            return EXIT_OK;
        }
        stdout(`[perf] harness 非 0 退出，详见 ${files.harness}`);
        finish("harness-exit");
        return EXIT_HARNESS;
    } catch (unexpected) {
        const message = (unexpected as Error).message;
        fail(message);
        meta.error = message;
        finish("setup-error");
        return EXIT_SETUP;
    } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        // 无论走到哪一步都不留孤儿进程。
        if (harness !== null) await stopProcess(harness, "harness", () => {});
        if (mock !== null) await stopProcess(mock, "mock", () => {});
        closeFileDescriptors();
        flushPerf();
        // 兜底：任何没想到的提前返回（或抛异常）也要留下一份能断定「没跑完」的 run.json。
        finish("incomplete");
    }

    function closeFileDescriptors(): void {
        if (harnessFd !== null) {
            try {
                closeSync(harnessFd);
            } catch {
                // 已关闭。
            }
            harnessFd = null;
        }
        if (mockFd !== null) {
            try {
                closeSync(mockFd);
            } catch {
                // 已关闭。
            }
            mockFd = null;
        }
    }
}

if (import.meta.main) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.log(USAGE);
        process.exit(EXIT_OK);
    }
    try {
        const code = await runPerf(loadPerfConfig());
        process.exit(code);
    } catch (error) {
        console.error(`[perf] 启动失败: ${(error as Error).message}`);
        console.error("用法见 bun run scripts/perf/run.ts --help");
        process.exit(EXIT_SETUP);
    }
}
