#!/usr/bin/env bun
/**
 * harness 压测采样器：一条命令跑完「起 mock → 起 harness → 定时采样 → 出记录」。
 *
 *   1. 起 mock server（指定剧本，轮询 /__mock/status 等就绪）；
 *   2. 在 work-dir（默认 playground/peri，其 .peri/settings.json 把 provider 指向 mock）下起 harness；
 *   3. 每 interval-ms（默认 100ms）采一次 harness 进程的 CPU 与 RSS——**不采 GPU**；
 *   4. 全程写入 out-dir 下四个文件，结束时在 perf.log 与 stdout 打印摘要。
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
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, formatRunId, loadPerfConfig, type PerfConfig } from "./config";
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
  bun run scripts/perf/run.ts [选项]

选项:
  --turns <n>             传给 harness 的 --max-turns（默认 25）
  --interval-ms <n>       采样间隔毫秒（默认 100）
  --timeout-ms <n>        兜底时限毫秒，到点强制终止 harness（默认 60000）
  --ready-timeout-ms <n>  mock 就绪等待上限毫秒（默认 10000）
  --prompt <text>         harness 的提示词
  --script <path>         mock 剧本（默认 scripts/perf-scenario.json）
  --peri <path>           harness 二进制（默认 ../perihelion/target/debug/peri）
  --work-dir <path>       harness 工作目录（默认 playground/peri）
  --out-dir <path>        产物目录（默认 data/claude-date）
  --port <n>              mock 端口（默认 3457）
  --exhausted <policy>    mock 剧本耗尽策略：loop（默认，可持续供压）| hold | error；
                            hold/error 下剧本走完即停，harness 有机会自行退出并写出 harness.log
  --sampler <kind>        采样后端：rusage（默认，FFI proc_pid_rusage）| ps（兜底）
  --no-tree               不统计 harness 的后代进程（默认统计，含其拉起的 MCP 子进程）
  --peri-arg <arg>        透传给 harness 的参数，可重复。值以 - 开头时必须用 --peri-arg=<值>：
                            --peri-arg=--db-path --peri-arg=/tmp/peri.db
  -h, --help              显示本帮助

产物（<runId> 形如 20260919-153012）:
  <out-dir>/<runId>-perf.log      时间线事件 + 每秒采样摘要 + 末尾总摘要
  <out-dir>/<runId>-samples.csv   原始采样，列：${CSV_HEADER}
  <out-dir>/<runId>-harness.log   harness 的 stdout/stderr
  <out-dir>/<runId>-mock.log      mock server 的输出

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
}

function defaultHarnessCommand(config: PerfConfig): string[] {
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
        return response.ok;
    } catch {
        return false;
    }
}

/** 命令行的可读形式（含引号，方便直接复制重跑）。 */
function quote(command: readonly string[]): string {
    return command
        .map((part) => (/^[\w./=:-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
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

/** mock 的访问日志每消费一条剧本记一行，用它统计请求数（游标在 loop 策略下不累计）。 */
function countMockRequests(path: string): number {
    try {
        return readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => line.includes("→ 消费第")).length;
    } catch {
        return 0;
    }
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
    const stdout = deps.log ?? ((line: string) => console.log(line));
    const probeReady = deps.probeReady ?? defaultProbeReady;
    const harnessCommand = deps.harnessCommand ?? defaultHarnessCommand;
    const mockCommand = deps.mockCommand ?? defaultMockCommand;

    const runId = formatRunId(new Date());
    const files = {
        perf: join(config.outDir, `${runId}-perf.log`),
        samples: join(config.outDir, `${runId}-samples.csv`),
        harness: join(config.outDir, `${runId}-harness.log`),
        mock: join(config.outDir, `${runId}-mock.log`),
    };
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

    try {
        mkdirSync(config.outDir, { recursive: true });
        writeFileSync(
            files.perf,
            [
                "# llm-mock 压测记录",
                `runId: ${runId}`,
                `开始: ${new Date().toISOString()}`,
                `产物目录: ${config.outDir}`,
                "",
            ].join("\n") + "\n",
            { flag: "a" },
        );
        if (!existsSync(files.samples)) writeFileSync(files.samples, CSV_HEADER + "\n");
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);

        for (const [label, path] of [
            ["harness 二进制", config.periPath],
            ["mock 剧本", config.scriptPath],
            ["harness 工作目录", config.workDir],
        ] as const) {
            if (!existsSync(path)) {
                fail(`${label}不存在: ${path}`);
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
        while (clock() < readyDeadline) {
            if (mock.exitCode !== null) {
                const tail = tailOf(files.mock);
                const portTaken = /in use|EADDRINUSE|Failed to start server/i.test(tail);
                fail(
                    `mock 启动失败（退出码 ${mock.exitCode}），日志末尾: ${tail}` +
                        (portTaken ? `；端口 ${config.port} 已被占用，用 --port 换一个` : ""),
                );
                return EXIT_SETUP;
            }
            if (await probeReady(statusUrl)) {
                ready = true;
                break;
            }
            await Bun.sleep(READY_POLL_MS);
        }
        if (!ready) {
            fail(
                `等待 mock 就绪超时（${config.readyTimeoutMs}ms）: ${statusUrl} 无响应；` +
                    `端口 ${config.port} 可能被别的进程占用，或 mock 卡在启动`,
            );
            return EXIT_SETUP;
        }
        const status = await fetchMockStatus(statusUrl);
        timeline(
            `mock 就绪: http://127.0.0.1:${config.port}（剧本 ${status?.size ?? "?"} 条，` +
                `耗尽策略 ${status?.policy ?? "?"}）`,
        );

        // 3. 起 harness
        const command = harnessCommand(config);
        timeline(`启动 harness: ${quote(command)}（cwd=${config.workDir}）`);
        harnessFd = openSync(files.harness, "a");
        harness = Bun.spawn(command, {
            cwd: config.workDir,
            detached: true,
            stdin: "ignore",
            stdout: harnessFd,
            stderr: harnessFd,
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
        timeline(
            `采样开始: ${backend.describe()}，间隔 ${config.intervalMs}ms，` +
                `落盘周期 ${FLUSH_INTERVAL_MS}ms`,
        );
        const sampler = new ProcessSampler({ pid: harnessPid, backend, withTree: config.withTree });
        if (!sampler.prime()) {
            fail(
                `采样对象 pid=${harnessPid} 在首次采样前已退出` +
                    `（退出码 ${harnessProc.exitCode ?? "null"}）；` +
                    `harness 日志末尾: ${tailOf(files.harness, 3)}`,
            );
            return EXIT_HARNESS;
        }
        if (config.withTree) sampler.refreshTree();
        stdout(`[perf] 产物: ${files.perf}`);

        const samples: ProcessSample[] = [];
        const csvBuffer: string[] = [];
        const samplingStart = clock();
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
        timeline(`harness 退出: code=${exit.code ?? "null"} signal=${exit.signal ?? "无"}`);

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

        const requests = countMockRequests(files.mock);
        const summary = summarize(samples);
        perfBuffer.push("", "=== 摘要 ===", ...summaryLines(summary, config));
        perfBuffer.push(
            `mock 请求数: ${requests}` +
                (summary.durationMs > 0
                    ? `（${(requests / (summary.durationMs / 1000)).toFixed(1)} 次/秒）`
                    : ""),
            `mock 游标: index=${finalStatus?.index ?? "?"} / ${finalStatus?.size ?? "?"}`,
            `产物: ${files.perf} · ${files.samples} · ${files.harness} · ${files.mock}`,
        );
        flushPerf();
        stdout("[perf] === 摘要 ===");
        for (const line of summaryLines(summary, config)) stdout(`[perf] ${line}`);
        stdout(`[perf] mock 请求数: ${requests} · 产物: ${config.outDir}`);

        if (interrupted) return EXIT_INTERRUPTED;
        if (timedOut) return EXIT_TIMEOUT;
        if (exit.code === 0) return EXIT_OK;
        stdout(`[perf] harness 非 0 退出，详见 ${files.harness}`);
        return EXIT_HARNESS;
    } catch (unexpected) {
        fail((unexpected as Error).message);
        return EXIT_SETUP;
    } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        // 无论走到哪一步都不留孤儿进程。
        if (harness !== null) await stopProcess(harness, "harness", () => {});
        if (mock !== null) await stopProcess(mock, "mock", () => {});
        closeFileDescriptors();
        flushPerf();
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
