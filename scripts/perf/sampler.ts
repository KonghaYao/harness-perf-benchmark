/**
 * 进程采样：按固定间隔读取 harness 进程的累计 CPU 时间与常驻内存（RSS）。
 *
 * ## 为什么用 proc_pid_rusage
 *
 * macOS 的 `ps -o %cpu` 是**进程生命周期均值**，不能当瞬时值；可行的做法是对累计 CPU
 * 时间做差分。两个候选方案的实测对比（macOS 26.5.1 / Apple Silicon，可用
 * `bun run scripts/perf/verify.ts` 复现）：
 *
 *   方案                        单次开销   读数分辨率   对单核满转的读数
 *   ps -p <pid> -o time= 差分    1.2 ms    50 ms       98.5%（±50ms 量化误差）
 *   proc_pid_rusage 差分         0.8 µs    ~1 µs       98.0%
 *
 * 100ms 采样窗口下 ps 的 50ms 量化误差相当于 ±50%，因此默认用 rusage；ps 仅作兜底
 * （FFI 不可用时）。rsusage 是纯函数调用，不 spawn 子进程，对被测对象几乎无干扰。
 *
 * ## 陷阱：返回值不是纳秒
 *
 * 文档称 ri_user_time / ri_system_time 为纳秒，但本机实测是 **Mach 绝对时基的 tick 数**
 * （mach_timebase_info: numer=125 denom=3 → 1 tick ≈ 41.67 ns）。不换算会把 CPU 低估
 * 41.7 倍（单核满转读成 2.4%）。这里始终用 mach_timebase_info 动态换算：Intel 机器
 * timebase 为 1/1，换算退化为恒等，不影响正确性。
 *
 * CPU% 的单位是「单核 100%」，多线程进程可超过 100%。
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

export type SamplerKind = "rusage" | "ps";

/** Mach 时基：1 tick = numer / denom 纳秒。 */
export interface MachTimebase {
    numer: number;
    denom: number;
}

/** 一次累计读数：CPU 累计时间（纳秒）与常驻内存（字节）。 */
export interface CumulativeReading {
    cpuNs: number;
    rssBytes: number;
}

/** 一个采样点。 */
export interface ProcessSample {
    /** 采样时刻（epoch 毫秒）。 */
    ts: number;
    /** 距采样开始的毫秒数。 */
    elapsedMs: number;
    /** 根进程瞬时 CPU（单核为 100%）。 */
    cpuPercent: number;
    rssBytes: number;
    /** 根进程 + 全部后代进程的瞬时 CPU 合计。 */
    treeCpuPercent: number;
    treeRssBytes: number;
    /** 进程树内成功读到读数的进程数（含根进程）。 */
    procs: number;
}

/** 采样读数来源；可注入假后端以便测试。 */
export interface SamplerBackend {
    kind: SamplerKind;
    /** 供日志说明的一行描述。 */
    describe(): string;
    /** 读取累计读数；进程不存在时返回 null。 */
    read(pid: number): CumulativeReading | null;
}

export const CSV_COLUMNS = [
    "ts",
    "elapsed_ms",
    "cpu_pct",
    "rss_kb",
    "tree_cpu_pct",
    "tree_rss_kb",
    "procs",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const CSV_HEADER = CSV_COLUMNS.join(",");

// ---------------------------------------------------------------------------
// 纯计算：便于单测
// ---------------------------------------------------------------------------

/** Mach tick → 纳秒。 */
export function ticksToNs(ticks: number, timebase: MachTimebase): number {
    return ticks * (timebase.numer / timebase.denom);
}

/** 累计 CPU 时间差 → 瞬时 CPU 百分比（单核 100%）。 */
export function cpuPercent(deltaNs: number, elapsedMs: number): number {
    if (!(elapsedMs > 0) || !(deltaNs > 0)) return 0;
    return (deltaNs / (elapsedMs * 1e6)) * 100;
}

/** 解析 `ps -o time=` 的 `[[HH:]MM:]SS[.cc]`，得到毫秒；空值/异常返回 null。 */
export function parsePsTimeToMs(raw: string): number | null {
    const text = raw.trim();
    if (text === "" || text === "-") return null;
    const parts = text.split(":");
    if (parts.length > 3) return null;
    let seconds = 0;
    for (const part of parts) {
        const value = Number(part);
        if (!Number.isFinite(value) || value < 0) return null;
        seconds = seconds * 60 + value;
    }
    return seconds * 1000;
}

/** 依据 pid/ppid 表收集根进程及其全部后代（广度优先，纯函数）。 */
export function collectTree(
    rootPid: number,
    processes: ReadonlyArray<{ pid: number; ppid: number }>,
): number[] {
    const childrenOf = new Map<number, number[]>();
    for (const { pid, ppid } of processes) {
        const siblings = childrenOf.get(ppid);
        if (siblings === undefined) childrenOf.set(ppid, [pid]);
        else siblings.push(pid);
    }
    const seen = new Set<number>([rootPid]);
    const queue = [rootPid];
    while (queue.length > 0) {
        const current = queue.shift() as number;
        for (const child of childrenOf.get(current) ?? []) {
            if (seen.has(child)) continue;
            seen.add(child);
            queue.push(child);
        }
    }
    return [...seen];
}

/** CSV 行（不含换行）。 */
export function formatCsvRow(sample: ProcessSample): string {
    return [
        new Date(sample.ts).toISOString(),
        sample.elapsedMs.toFixed(0),
        sample.cpuPercent.toFixed(2),
        (sample.rssBytes / 1024).toFixed(0),
        sample.treeCpuPercent.toFixed(2),
        (sample.treeRssBytes / 1024).toFixed(0),
        String(sample.procs),
    ].join(",");
}

/**
 * 采样 CSV → 采样点。**按表头名映射列，不按下标写死**：
 * 加一列指标不该让读取端失效，但**必需列缺失必须报错**——宁可炸，
 * 也不要把 cpu 读成内存、画出一张看起来很正常但完全错的图。
 */
export function parseSamplesCsv(text: string): ProcessSample[] {
    const lines = text.trim().split("\n");
    const header = (lines[0] ?? "").split(",").map((name) => name.trim());
    const columnIndex = new Map(header.map((name, index) => [name, index]));
    const missing = CSV_COLUMNS.filter((name) => !columnIndex.has(name));
    if (missing.length > 0) {
        throw new Error(
            `采样 CSV 缺必需列 ${missing.join(", ")}（表头: ${header.join(",")}）`,
        );
    }
    const cell = (cells: string[], name: CsvColumn): string => cells[columnIndex.get(name)!]!;

    const samples: ProcessSample[] = [];
    for (const line of lines.slice(1)) {
        if (line.trim() === "") continue;
        const cells = line.split(",");
        const ts = Date.parse(cell(cells, "ts"));
        samples.push({
            ts: Number.isNaN(ts) ? 0 : ts,
            elapsedMs: Number(cell(cells, "elapsed_ms")),
            cpuPercent: Number(cell(cells, "cpu_pct")),
            rssBytes: Number(cell(cells, "rss_kb")) * 1024,
            treeCpuPercent: Number(cell(cells, "tree_cpu_pct")),
            treeRssBytes: Number(cell(cells, "tree_rss_kb")) * 1024,
            procs: Number(cell(cells, "procs")),
        });
    }
    return samples;
}

export interface SampleSummary {
    count: number;
    durationMs: number;
    cpuMean: number;
    cpuMax: number;
    rssMeanBytes: number;
    rssMaxBytes: number;
    rssLastBytes: number;
    treeCpuMean: number;
    treeCpuMax: number;
    treeRssMeanBytes: number;
    treeRssMaxBytes: number;
}

/** 汇总：均值 / 峰值；空样本集返回全 0。 */
export function summarize(samples: readonly ProcessSample[]): SampleSummary {
    const empty: SampleSummary = {
        count: 0,
        durationMs: 0,
        cpuMean: 0,
        cpuMax: 0,
        rssMeanBytes: 0,
        rssMaxBytes: 0,
        rssLastBytes: 0,
        treeCpuMean: 0,
        treeCpuMax: 0,
        treeRssMeanBytes: 0,
        treeRssMaxBytes: 0,
    };
    if (samples.length === 0) return empty;
    const sum = (pick: (sample: ProcessSample) => number) =>
        samples.reduce((total, sample) => total + pick(sample), 0);
    const max = (pick: (sample: ProcessSample) => number) =>
        samples.reduce((peak, sample) => Math.max(peak, pick(sample)), 0);
    const last = samples[samples.length - 1] as ProcessSample;
    return {
        count: samples.length,
        durationMs: last.elapsedMs,
        cpuMean: sum((s) => s.cpuPercent) / samples.length,
        cpuMax: max((s) => s.cpuPercent),
        rssMeanBytes: sum((s) => s.rssBytes) / samples.length,
        rssMaxBytes: max((s) => s.rssBytes),
        rssLastBytes: last.rssBytes,
        treeCpuMean: sum((s) => s.treeCpuPercent) / samples.length,
        treeCpuMax: max((s) => s.treeCpuPercent),
        treeRssMeanBytes: sum((s) => s.treeRssBytes) / samples.length,
        treeRssMaxBytes: max((s) => s.treeRssBytes),
    };
}

// ---------------------------------------------------------------------------
// 后端实现
// ---------------------------------------------------------------------------

/** rusage 结构体（rusage_info_v4）中我们用到的字段偏移，已实机核对。 */
const RUSAGE_INFO_V4 = 4;
const OFF_RI_USER_TIME = 16;
const OFF_RI_SYSTEM_TIME = 24;
const OFF_RI_RESIDENT_SIZE = 64;
/** 结构体足够容纳 v4 的全部字段（v4 约 296 字节）。 */
const RUSAGE_BUFFER_BYTES = 512;

/** libSystem 里我们用到的两个符号；失败（非 macOS / 无符号）时返回 null。 */
function loadLibSystem(): {
    proc_pid_rusage: (pid: number, flavor: number, buffer: unknown) => number;
    mach_timebase_info: (out: unknown) => number;
} | null {
    try {
        const lib = dlopen("/usr/lib/libSystem.B.dylib", {
            proc_pid_rusage: {
                args: [FFIType.i32, FFIType.i32, FFIType.ptr],
                returns: FFIType.i32,
            },
            mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
        });
        return lib.symbols as never;
    } catch {
        return null;
    }
}

/** 读取 Mach 时基；失败返回 null。 */
function readTimebase(symbols: {
    mach_timebase_info: (out: unknown) => number;
}): MachTimebase | null {
    const buffer = new Uint8Array(8);
    if (symbols.mach_timebase_info(ptr(buffer)) !== 0) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    const numer = view.getUint32(0, true);
    const denom = view.getUint32(4, true);
    if (!(numer > 0) || !(denom > 0)) return null;
    return { numer, denom };
}

/** 首选后端：FFI 调 proc_pid_rusage，不 spawn 任何子进程。 */
export function createRusageBackend(): SamplerBackend | null {
    const symbols = loadLibSystem();
    if (symbols === null) return null;
    const timebase = readTimebase(symbols);
    if (timebase === null) return null;
    const buffer = new Uint8Array(RUSAGE_BUFFER_BYTES);
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    return {
        kind: "rusage",
        describe: () =>
            `proc_pid_rusage（1 tick = ${(timebase.numer / timebase.denom).toFixed(2)} ns，单次约 0.8µs）`,
        read(pid: number): CumulativeReading | null {
            if (symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buffer)) !== 0) return null;
            const ticks = Number(
                view.getBigUint64(OFF_RI_USER_TIME, true) +
                    view.getBigUint64(OFF_RI_SYSTEM_TIME, true),
            );
            return {
                cpuNs: ticksToNs(ticks, timebase),
                rssBytes: Number(view.getBigUint64(OFF_RI_RESIDENT_SIZE, true)),
            };
        },
    };
}

/** 兜底后端：`ps -p <pid> -o time=,rss=` 差分（单次约 1.2ms，读数分辨率约 50ms）。 */
export function createPsBackend(): SamplerBackend {
    return {
        kind: "ps",
        describe: () => "ps -p <pid> -o time=,rss= 差分（兜底：单次约 1.2ms、分辨率约 50ms）",
        read(pid: number): CumulativeReading | null {
            const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "time=,rss="]);
            if (result.exitCode !== 0) return null;
            const fields = result.stdout.toString().trim().split(/\s+/);
            if (fields.length < 2) return null;
            const cpuMs = parsePsTimeToMs(fields[0] as string);
            const rssKb = Number(fields[1]);
            if (cpuMs === null || !Number.isFinite(rssKb)) return null;
            return { cpuNs: cpuMs * 1e6, rssBytes: rssKb * 1024 };
        },
    };
}

/** 枚举全部进程的 pid/ppid（一次 `ps -axo`，约 13ms）。 */
export function listProcesses(): Array<{ pid: number; ppid: number }> {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]);
    if (result.exitCode !== 0) return [];
    const rows: Array<{ pid: number; ppid: number }> = [];
    for (const line of result.stdout.toString().split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 2) continue;
        const pid = Number(fields[0]);
        const ppid = Number(fields[1]);
        if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid });
    }
    return rows;
}

// ---------------------------------------------------------------------------
// 采样器
// ---------------------------------------------------------------------------

export interface SamplerOptions {
    /** 根进程（harness）。 */
    pid: number;
    backend: SamplerBackend;
    /** 是否连带统计后代进程（如 harness 拉起的 MCP 子进程）。 */
    withTree?: boolean;
    /** 进程树刷新间隔（毫秒），默认 2000；期间沿用上次的 pid 集合。 */
    treeRefreshMs?: number;
    /** 进程表来源，测试可注入。 */
    listProcesses?: () => Array<{ pid: number; ppid: number }>;
    /** 时间源，测试可固定。 */
    now?: () => number;
}

export class ProcessSampler {
    private readonly previous = new Map<number, CumulativeReading>();
    private readonly options: Required<Omit<SamplerOptions, "now">> & { now: () => number };
    private tree: number[] = [];
    private treeRefreshedAt = Number.NEGATIVE_INFINITY;

    constructor(options: SamplerOptions) {
        this.options = {
            withTree: false,
            treeRefreshMs: 2000,
            listProcesses,
            ...options,
            now: options.now ?? Date.now,
        };
        this.tree = [options.pid];
    }

    /** 建立基线读数：必须在第一次 sample 之前调用，否则首拍差值为 0。 */
    prime(): boolean {
        const reading = this.options.backend.read(this.options.pid);
        if (reading === null) return false;
        this.previous.set(this.options.pid, reading);
        return true;
    }

    /** 刷新进程树；读不到全表时退回只有根进程。 */
    refreshTree(): number[] {
        if (!this.options.withTree) {
            this.tree = [this.options.pid];
            return this.tree;
        }
        const processes = this.options.listProcesses();
        this.tree =
            processes.length === 0 ? [this.options.pid] : collectTree(this.options.pid, processes);
        this.treeRefreshedAt = this.options.now();
        return this.tree;
    }

    /**
     * 取一拍。elapsedMs 是距采样开始的实测时长（进 CSV 用于画图）；deltaMs 是距上一拍的
     * 实测间隔（作为 CPU 差分的分母，别用名义间隔，否则定时器抖动会被算成 CPU 变化）。
     * 根进程已不存在时返回 null。
     */
    sample(timing: { elapsedMs: number; deltaMs: number }): ProcessSample | null {
        const now = this.options.now();
        if (this.options.withTree && now - this.treeRefreshedAt >= this.options.treeRefreshMs) {
            this.refreshTree();
        }

        const current = new Map<number, CumulativeReading>();
        let root: CumulativeReading | null = null;
        let rootCpuNs = 0;
        let treeCpuNs = 0;
        let treeRssBytes = 0;
        let procs = 0;

        for (const pid of this.tree.length > 0 ? this.tree : [this.options.pid]) {
            const reading = this.options.backend.read(pid);
            if (reading === null) continue;
            current.set(pid, reading);
            procs += 1;
            treeRssBytes += reading.rssBytes;
            const before = this.previous.get(pid);
            // 中途新出现的进程没有基线，本拍记 0，避免把「自启动以来的总量」当成瞬时值。
            const delta = before === undefined ? 0 : Math.max(0, reading.cpuNs - before.cpuNs);
            treeCpuNs += delta;
            if (pid === this.options.pid) {
                root = reading;
                rootCpuNs = delta;
            }
        }
        this.previous.clear();
        for (const [pid, reading] of current) this.previous.set(pid, reading);

        if (root === null) return null;
        return {
            ts: now,
            elapsedMs: timing.elapsedMs,
            cpuPercent: cpuPercent(rootCpuNs, timing.deltaMs),
            rssBytes: root.rssBytes,
            treeCpuPercent: cpuPercent(treeCpuNs, timing.deltaMs),
            treeRssBytes,
            procs,
        };
    }
}
