/**
 * 本机 CPU 校准：拿**真实的 7-Zip 内置基准**把「本机一秒」折成「项目标准 CPU 单位秒」。
 *
 * **没有真实参考机器**：baseline（1000）是本项目自定的换算基准，不是某台机器的实测值；
 * 折算出来的数只写「多少个项目标准 CPU 单位秒」，不写「等于某台参考机器的几秒」。
 *
 * ## 为什么需要它
 *
 * CU 里那一项「核·秒」是**本机的秒**：同一部剧本、同一个 harness，在一台快机器上只有 0.6 核·秒，
 * 在慢机器上可能 4 核·秒——这个差额不是 harness 省或费，而是机器快慢。要跨机器谈「成本」，
 * 得先把秒折算到同一把尺子上。这把尺子就是**固定版本的 7-Zip 内置基准（`7zz b`）**：
 * 它自带一套与硬件无关的评分（Rating，单位即 7-Zip 自己的 MIPS 口径），按同一份参数跑一遍
 * 就能量出「本机有多快」。
 *
 * ## 口径（不可反向，错了就是整整一个方向的偏差）
 *
 * 1. **固定 7-Zip 26.01 + 固定参数 `b 1 -mmt1 -md25`**：`-mmt1` 是单线程，`-md25` 让 32MiB
 *    字典那一组出现在输出里（`25:` = 2^25 字节 = 32MiB），`b 1` 只跑一轮、不做内部迭代。
 *    **换版本或换参数就是换了一把尺子**，这两样都记进校准 JSON，读取端认它们、不认「差不多」。
 * 2. **只取 `25:` 那一行的八列**——压缩与解压各四列 `Speed / Usage / R/U / Rating`，
 *    别的行（1MiB / 4MiB / 8MiB…）一概不看：列的含义随 `b <n>` 变，混着读就是读错列。
 * 3. **单线程那一路取 `R/U` 的算术平均**（每轮 = 压缩与解压两个 `R/U` 的均值，再对轮次取均值）：
 *    `cpuScale = meanRU / baseline`，**乘**进 core·秒。baseline 固定 **1000 benchmark MIPS per
 *    CPU-second**——7-Zip 历史 normalized rating 的项目单位，**不是**真实机器指令数，也不是
 *    SPEC / 云商的 vCPU 数。
 * 4. **重复 ≥3 次**（默认 5），先跑 1 轮 warmup 且**不计入统计**；每轮都算均值、样本标准差、
 *    变异系数（CV），CV 超阈值就出 warning——重复不是可选项，单线程读数会随机器负载漂。
 * 5. **另有 `-mmt<threads>` 一路的原始 Rating 均值 / baseline**，作为**整机吞吐标准单位**
 *    （默认线程数 = `availableParallelism()`）。它是「这台机器整机有多快」的**观察值**，
 *    **不是**「单线程读数 × 逻辑核数」——后者是假装的实测，本文件里没有这条路径。
 *
 * ## 方向（踩过）
 *
 * `cpuScale` 是**乘**的：机器越快，同样的核·秒折出的标准单位秒越**多**（Rating 本身的含义
 * 就是「本机一秒相当于多少个基准单位」）。写成除法会让快机器显得更便宜——恰好是反的。
 *
 * ## 边界
 *
 * 只读本机既有二进制并 spawn 它：**不下载、不安装、不执行 shell**（参数以数组形式交给
 * `Bun.spawn`），拿不到二进制就报错退出。stdout / stderr 边跑边读（不排空管道会把子进程堵死），
 * 超时即杀进程并判本轮失败。原始输出**逐份落盘并记 sha256**：JSON 只是索引，读数可复核。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, formatRunId } from "./config";
import { hostSnapshot } from "./run-meta";

/** 固定版本：banner 里必须出现它，否则这份校准值不成立（换版本 = 换尺子）。 */
export const SEVEN_ZIP_VERSION = "26.01";
/** PATH 里找不到 `7zz` 时的兜底路径（Homebrew 的固定位置）。 */
export const SEVEN_ZIP_FALLBACK_PATH = "/opt/homebrew/bin/7zz";
/** 参数 `-md25` 的字典尺寸：2^25 字节 = 32MiB，就是输出里 `25:` 那一行。 */
export const BENCHMARK_DICT_SIZE = 25;
/** 固定参数：`b 1`（只跑一轮）`-mmt1`（单线程）`-md25`（32MiB 字典）。 */
export const BENCHMARK_ARGS = ["b", "1", "-mmt1", "-md25"] as const;
/** 32MiB 行的四列，与 7-Zip 表头 `Speeds: Usage : R/U : Rating` 一一对应。 */
export const BENCHMARK_COLUMNS = ["speed", "usage", "ru", "rating"] as const;
/** baseline：1 标准核·秒 = 1000 个 7-Zip normalized benchmark MIPS（项目单位）。 */
export const BASELINE_MIPS_PER_CPU_SECOND = 1000;
/** 默认重复次数；低于 `MIN_REPEATS` 拒绝。 */
export const DEFAULT_REPEATS = 5;
export const MIN_REPEATS = 3;
/** 单次基准的默认超时（秒）。 */
export const DEFAULT_TIMEOUT_S = 600;
/** 单线程 CV 超过它就出 warning：这份 cpuScale 只是「这一刻的机器」。 */
export const CV_WARN_PERCENT = 5;
/** 整机 CV 超过它就出 warning（后台负载会吃掉一部分核）。 */
export const WHOLE_MACHINE_CV_WARN_PERCENT = 10;
/** 校准 JSON 的 schema 与方法名（读取端按 method 判「这批读数同不同口径」）。 */
export const CALIBRATION_SCHEMA_VERSION = 1;
export const CALIBRATION_METHOD = "cpu-calibration-7zip-v1";

/** 32MiB 那一行的四列读数。 */
export interface BenchmarkMetrics {
    speed: number;
    usage: number;
    /** R/U：7-Zip 按处理器频率归一化后的每秒百万指令数。 */
    ru: number;
    /** Rating：7-Zip 的评分值。 */
    rating: number;
}

/** 一份基准输出里解析出来的事实。 */
export interface BenchmarkResult {
    version: string;
    /** 参与计时的 CPU 数（老版本输出里可能没有这一列 → null）。 */
    cpus: number | null;
    compress: BenchmarkMetrics;
    decompress: BenchmarkMetrics;
    /** 合并两半的四列：Speed 取和，Usage、R/U 与 Rating 取算术均值。 */
    machine: BenchmarkMetrics;
    /** 每 CPU 四列 = 整机 / 参与计时的 CPU 数。 */
    perCpu: BenchmarkMetrics;
}

/** 一次基准输出的整套耗时（`Tot:` 行），只做审计、不进统计。 */
/**
 * 7-Zip 的 `Tot:` 行（整套基准的总体读数，三列）。**只做审计**：折算只认单线程那一路的
 * `25:` 行，这里不参与任何计算——它的价值是「事后能拿一行核对整份输出没被换过」。
 */
export interface BenchmarkTotals {
    usage: number;
    ru: number;
    rating: number;
}

/** 均值 / 样本标准差 / 变异系数（百分比）。 */
export interface Stats {
    count: number;
    mean: number;
    /** 样本标准差（n−1）；n=1 时为 0。 */
    sampleStddev: number;
    cvPercent: number;
}

/** 每轮的原始读数与原始日志文件名。 */
export interface CalibrationRun {
    index: number;
    log: string;
    compress: BenchmarkMetrics;
    decompress: BenchmarkMetrics;
    /** `Tot:` 行（没有就 null）。 */
    totals: BenchmarkTotals | null;
}

/** 一路读数（单线程 / 整机）：每轮的两半 + 按列统计 + 合并均值。 */
export interface BenchmarkSeries {
    label: string;
    threads: number;
    runs: CalibrationRun[];
    stats: {
        /**
         * 逐列统计，**压缩与解压分开**（`{ compress: {...}, decompress: {...} }`）：
         * 两半测的是同一台机器的两件事，混成一个池子算出来的 CV 既不是压缩的、也不是解压的。
         */
        columns: {
            compress: Record<keyof BenchmarkMetrics, Stats>;
            decompress: Record<keyof BenchmarkMetrics, Stats>;
        };
        /** 折算真正用到的那一列：Rating（每轮 = 压缩与解压的**算术平均**）。 */
        rating: Stats;
        /** 折算真正用到的那一列：R/U（每轮 = 压缩与解压的**算术平均**）。 */
        ru: Stats;
    };
    /** 逐列均值：Speed 取两路之和（吞吐可加），Usage / R/U / Rating 取两路算术平均。 */
    mean: BenchmarkMetrics;
    perCpuMean: BenchmarkMetrics;
}

export interface CalibrationBinary {
    /** 实际 spawn 的路径（可能是符号链接）。 */
    path: string;
    /** 解析符号链接后的真实路径。 */
    realPath: string;
    sizeBytes: number;
    mtimeMs: number;
    sha256: string;
}

/** 校准 JSON 里的 host 快照：字段与 run.json 的 `host` 对齐，好互相比对。 */
export interface CalibrationHost {
    hostname: string;
    platform: string;
    arch: string;
    cpuModel: string;
    cpus: number;
    totalMemBytes: number;
    osRelease: string;
    loadAvg: [number, number, number];
    bunVersion: string;
}

export interface CalibrationWarning {
    code: string;
    message: string;
}

export interface Calibration {
    schemaVersion: number;
    /** 口径名：读取端据此判「两批读数同不同口径」。 */
    method: string;
    measuredAt: string;
    host: CalibrationHost;
    tool: {
        name: "7zip";
        version: string;
        binary: CalibrationBinary;
        args: {
            mode: "b";
            iterations: number;
            /** 单线程那一路的线程数（恒为 1）。 */
            threads: number;
            dictSize: number;
            /** 原样记一遍命令行参数，读取端不必自己拼。 */
            argv: string[];
        };
        /** 一行的口令：binary hash + 版本 + 参数 + baseline + 重复数 + 线程数。变了就不是同一把尺子。 */
        configSignature: string;
        measuredAt: string;
    };
    scale: {
        /**
         * 项目标准 CPU 单位的定义：1 标准单位·秒 = `baselineMips` 个 7-Zip normalized benchmark
         * MIPS。**本项目自定，不是某台真实参考机器的实测值**。
         */
        baselineMips: number;
        /** `cpuScale = cpuScaleValue / baselineMips`（**乘**进 core·秒）。 */
        cpuScale: number;
        /** 参与折算的原始值：repeats 轮单线程 `R/U` 的算术平均。 */
        cpuScaleValue: number;
        baseline: string;
        unit: string;
        /** 每轮单线程的两个 R/U 与派生的 Rating（留原始数，方便复核）。 */
        oneCoreSecond: {
            rawRu: number[];
            rawRatings: number[];
        };
    };
    /** 单线程一路（`-mmt1`）：折算只认它的 `R/U`。 */
    singleThread: BenchmarkSeries;
    /** 整机一路（`-mmt<threads>`）：整机吞吐标准单位，**观察值**。 */
    machine: BenchmarkSeries & {
        cpusUsed: number | null;
        /** `rating.mean / baselineMips`（不是「单线程 × 核数」）。 */
        standardUnits: { throughput: number; note: string };
    };
    /** warmup 不在统计里，只留原始日志与读数。 */
    warmup: { log: string; compress: BenchmarkMetrics; decompress: BenchmarkMetrics } | null;
    /** 原始日志：（角色、文件名、字节数、sha256）。 */
    logs: { role: string; file: string; bytes: number; sha256: string }[];
    statistic: {
        metric: "ru-arith-mean";
        repeats: number;
        warmupRuns: number;
        formula: string;
    };
    warnings: CalibrationWarning[];
    /** 原始日志的绝对目录（JSON 可拷贝，日志路径写死便于回查）。 */
    logDir: string;
    loadAvgAtStart: [number, number, number];
    loadAvgAtEnd: [number, number, number];
    /** 恒定 false：校准只给折算系数，从不改 CU 的 1:1 系数。 */
    appliedToCu: false;
}

// ---------------------------------------------------------------------------
// 纯解析：可单测，不需要真的跑 7-Zip
// ---------------------------------------------------------------------------

/**
 * 从输出里取版本号并核对：`7-Zip (z) 26.01 (arm64) : Copyright …` → `26.01`。
 * 不是 7-Zip、或版本不是固定的那一版，直接抛——**换版本等于换尺子**，别静默接受。
 */
export function parseSevenZipVersion(text: string): string {
    const banner = /7-Zip\s*\([a-z]\)\s*(\d+(?:\.\d+)+)/i.exec(text);
    if (banner === null) {
        throw new Error("输出里找不到 7-Zip 版本 banner：这不是 7-Zip，或输出被截断");
    }
    const version = banner[1] as string;
    if (version !== SEVEN_ZIP_VERSION) {
        throw new Error(
            `7-Zip 版本是 ${version}，本校准固定 ${SEVEN_ZIP_VERSION}：换版本等于换尺子，` +
                "要换得连 method / tool.version 一起改并重跑整批",
        );
    }
    return version;
}

/** 一列数值：必须是有限正数——0、负数、NaN、Infinity 一律拒绝（拒绝比静默按 0 处理好）。 */
function positiveNumber(value: string | undefined, label: string): number {
    if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) {
        throw new Error(`${label} 不是非负小数: ${JSON.stringify(value)}`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} 必须是有限正数，收到 ${JSON.stringify(value)}（0 或缺失都不接受）`);
    }
    return parsed;
}

/** 可选的正整数列（「参与计时的 CPU 数」；老版本输出里可能没有）。 */
function optionalCount(value: string | undefined): number | null {
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 去掉尺寸前缀（与可能的 CPU 数列）后，剩下的 4 个数恰好就是四列。 */
const SIZE_PREFIX = /^(?:(?:25:|Dict\s+Size\s+25:)\s+)?(\d+\s+)?(\d+(?:\.\d+)?\s+\d+\s+\d+\s+\d+)$/;

/** 把一侧解析成「四列数值 + 可选的 CPU 数」。 */
function parseHalf(
    text: string,
    side: "compress" | "decompress",
): { numbers: string[]; cpuCount: number | null } {
    const trimmed = text.trim();
    const match = SIZE_PREFIX.exec(trimmed);
    if (match === null) {
        throw new Error(
            `${side} 侧不是「（尺寸前缀 +）可选 CPU 数 + 4 列」，拒绝猜: ${JSON.stringify(trimmed.slice(0, 120))}`,
        );
    }
    const [, cpu, numbers] = match;
    return { numbers: (numbers as string).trim().split(/\s+/), cpuCount: optionalCount(cpu?.trim()) };
}

/**
 * 切一行：去掉 `25:` / `Dict Size 25:` 前缀与可选的 CPU 数列，**在 `|` 处分成左右两半**
 * （左 = 压缩，右 = 解压），各留四列数值。
 *
 * 真实格式（7-Zip 26.01，`-md25`）：
 *   `25:       6726    99   7729   7680  |     115803   100  10290  10307`
 * 多线程时左侧多一列「参与计时的 CPU 数」：
 *   `Dict Size 25:  18  67358  825 9328 76907 |  818572  896 8127 72830`
 */
function splitSizeLine(line: string): {
    compress: string[];
    decompress: string[];
    cpuCount: number | null;
} {
    const parts = line.trim().split("|");
    if (parts.length !== 2) {
        throw new Error(`32MiB 行不是「压缩 | 解压」两半: ${JSON.stringify(line.slice(0, 120))}`);
    }
    const compressCells = parseHalf(parts[0] as string, "compress");
    const decompressCells = parseHalf(parts[1] as string, "decompress");
    return {
        compress: compressCells.numbers,
        decompress: decompressCells.numbers,
        cpuCount: compressCells.cpuCount ?? decompressCells.cpuCount,
    };
}

/** 把一侧的四列数值切出来。 */
function metricsPair(numbers: readonly string[], half: "compress" | "decompress"): BenchmarkMetrics {
    return {
        speed: positiveNumber(numbers[0], `${half}.speed`),
        usage: positiveNumber(numbers[1], `${half}.usage`),
        ru: positiveNumber(numbers[2], `${half}.ru`),
        rating: positiveNumber(numbers[3], `${half}.rating`),
    };
}

/**
 * 压缩 / 解压两半 → 一条读数。
 *
 * **口径（用户指定，不要改）**：`R/U` 与 `Rating` 取两半的**算术平均**
 * （`mean(压缩, 解压)`），不是求和——求和会把整机吞吐虚高一倍。
 * `Usage` 同取算术平均；只有 `Speed`（KiB/s）是两路之和：吞吐是可加量，
 * 而 `R/U` / `Rating` 是「每 CPU 的速度」，两个半程各测一次，平均才是它对这台机器的代表值。
 */
export function combineHalves(compress: BenchmarkMetrics, decompress: BenchmarkMetrics): BenchmarkMetrics {
    const mean = (left: number, right: number) => (left + right) / 2;
    return {
        speed: compress.speed + decompress.speed,
        usage: mean(compress.usage, decompress.usage),
        ru: mean(compress.ru, decompress.ru),
        rating: mean(compress.rating, decompress.rating),
    };
}

/** 四列一起除以 n（`R/U` 与 `Rating` 才有「每 CPU」的含义；Speed 与 Usage 跟着走只为显示）。 */
export function perCpuMetrics(metrics: BenchmarkMetrics, divisor: number): BenchmarkMetrics {
    if (!Number.isFinite(divisor) || divisor <= 0) throw new Error("每 CPU 折算的除数必须是有限正数");
    return {
        speed: metrics.speed / divisor,
        usage: metrics.usage / divisor,
        ru: metrics.ru / divisor,
        rating: metrics.rating / divisor,
    };
}

/**
 * 解析 `7zz b 1 -mmt… -md25` 的输出：**只认 `25:`（32MiB）那一行**，它用 `|` 分成压缩 / 解压两半、
 * 各四列。缺行、列数不够、非有限数、0 值都抛（拒绝比静默按 0 处理好）。
 *
 * 一个容易踩的点：输出里 **`Avr:` 是四个尺寸的均值**（1MiB/4MiB/8MiB/32MiB），读错行会得到
 * 一个「看起来很正常」的错数——所以这里按 `25:` 前缀精确定位，不用「第二行」这类位次。
 */
export function parseBenchmarkOutput(text: string): BenchmarkResult {
    const version = parseSevenZipVersion(text);
    const lines = text
        .split(/\r?\n/)
        .filter((line) => /^\s*(25:|Dict\s+Size\s+25:)/.test(line));
    if (lines.length === 0) {
        throw new Error(
            '输出里没有 "25:"（32MiB 字典）那一行：参数要带 -md25，且输出不能被截断',
        );
    }
    if (lines.length > 1) {
        throw new Error(`"25:" 那一行出现 ${lines.length} 次，输出形状不对，拒绝猜哪一行是真的`);
    }
    const cells = splitSizeLine(lines[0] as string);
    const compress = metricsPair(cells.compress, "compress");
    const decompress = metricsPair(cells.decompress, "decompress");
    const divisor = cells.cpuCount ?? 1;
    const machine = combineHalves(compress, decompress);
    return {
        version,
        cpus: cells.cpuCount,
        compress,
        decompress,
        machine,
        perCpu: perCpuMetrics(machine, divisor),
    };
}

/**
 * 取 `Tot:` 行（**不进统计，只做审计**）：整份基准的总体 Usage / R/U / Rating。
 *
 * 真实格式（7-Zip 26.01，单线程与 `-mmt18` 都是这个形状）**只有三列**：
 *   `Tot:             100  10047  10017`
 *   `Tot:            1543   9808 151315`
 * 所以这里**按行**匹配、只认三个整数：`\s` 在正则里能吃掉换行，跨行匹配会把别的行接上来；
 * 列数写得比真实多（早先写死五列）则永远匹配不上、静默返回 null。
 */
export function parseTotalsLine(text: string): BenchmarkTotals | null {
    const line = text.split(/\r?\n/).find((candidate) => /^\s*Tot:/.test(candidate));
    if (line === undefined) return null;
    const match = /^\s*Tot:\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) {
        throw new Error(`Tot: 行的形状不认识（期望「Tot: <usage> <R/U> <rating>」）: ${JSON.stringify(line.trim())}`);
    }
    const [, usage, ru, rating] = match as unknown as [string, string, string, string];
    const totals: BenchmarkTotals = {
        usage: Number(usage),
        ru: Number(ru),
        rating: Number(rating),
    };
    if (![totals.usage, totals.ru, totals.rating].every((value) => Number.isFinite(value) && value > 0)) {
        throw new Error(`Tot: 行的数值必须是有限正数: ${JSON.stringify(line.trim())}`);
    }
    return totals;
}

/** 样本统计量：均值 / 样本标准差 / 变异系数。空数组或非有限输入一律抛（不许静默出 0）。 */
export function statsOf(values: readonly number[]): Stats {
    if (values.length === 0) throw new Error("统计需要至少一个样本");
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error("统计样本必须都是有限正数");
    }
    const count = values.length;
    const mean = values.reduce((sum, value) => sum + value, 0) / count;
    const sampleStddev =
        count === 1
            ? 0
            : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1));
    const stats: Stats = { count, mean, sampleStddev, cvPercent: (sampleStddev / mean) * 100 };
    if (![stats.mean, stats.sampleStddev, stats.cvPercent].every(Number.isFinite)) {
        throw new Error("统计量超出可表示的数值范围");
    }
    return stats;
}

/** `cpuScale = meanRu / baselineMips`（**乘**进 core·秒）。 */
export function cpuScaleOf(meanRu: number, baselineMips: number = BASELINE_MIPS_PER_CPU_SECOND): number {
    if (!Number.isFinite(meanRu) || meanRu <= 0) throw new Error("meanRu 必须是有限正数");
    if (!Number.isFinite(baselineMips) || baselineMips <= 0) {
        throw new Error("baselineMips 必须是有限正数");
    }
    return meanRu / baselineMips;
}

// ---------------------------------------------------------------------------
// 跑基准
// ---------------------------------------------------------------------------

/** 二进制身份：路径 + size/mtime + sha256（换二进制就是换尺子，得看得出来）。 */
export function inspectBinary(command: string): CalibrationBinary {
    const path = resolve(command);
    if (!existsSync(path)) throw new Error(`找不到 7-Zip 二进制: ${path}`);
    if (!statSync(path).isFile()) throw new Error(`${path} 不是文件`);
    const realPath = realpathSync(path);
    const info = statSync(realPath);
    const sha256 = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    return { path, realPath, sizeBytes: info.size, mtimeMs: info.mtimeMs, sha256 };
}

/**
 * 基准二进制：显式路径优先，否则 PATH 里的 `7zz`，再否则 Homebrew 的固定路径。
 * 三条路都**当场确认文件存在**（显式指错路径不该等到 spawn 才炸，也不该让调用方先建目录）。
 */
export function resolveSevenZipBinary(explicit?: string): string {
    if (explicit !== undefined && explicit !== "") {
        const path = resolve(explicit);
        if (!existsSync(path)) throw new Error(`找不到 7-Zip 二进制: ${path}`);
        return path;
    }
    const onPath = Bun.which("7zz");
    if (onPath !== null) return onPath;
    if (existsSync(SEVEN_ZIP_FALLBACK_PATH)) return SEVEN_ZIP_FALLBACK_PATH;
    throw new Error(
        "PATH 里没有 7zz，也不在 " +
            `${SEVEN_ZIP_FALLBACK_PATH}：先装 7-Zip（brew install sevenzip），或用 --binary <path> 指定。` +
            "本工具不下载、不自动安装",
    );
}

/** 基准参数：`b 1 -mmt<n> -md25`。 */
export function benchmarkArgs(threads: number): string[] {
    if (!Number.isInteger(threads) || threads < 1) throw new Error("线程数必须是 >= 1 的整数");
    return ["b", "1", `-mmt${threads}`, `-md${BENCHMARK_DICT_SIZE}`];
}

/** 一次 spawn 的产物：退出码 + 三份输出（合并流用于解析，分开的留着便于排错）。 */
export interface BenchmarkExec {
    code: number;
    stdout: string;
    stderr: string;
    /** `stdout + "\n" + stderr`：banner 在 stdout、统计表在 stderr，解析要用合并后的。 */
    merged: string;
}

export interface BenchmarkExecOptions {
    timeoutS?: number;
    env?: Record<string, string>;
}

/**
 * spawn 一次 7-Zip 基准并等它结束。
 *
 * 三件事必须一起做对：**数组形式 spawn**（不经过 shell，参数里的 `-` 不会被解释）、
 * **stdout / stderr 边跑边读**（管道写满会把子进程堵死，所以读的人不能等 `exited`）、
 * **超时杀进程**（`Bun.spawn` 的 `kill()` 杀的是进程组；7-Zip 没有子进程，够用）。
 */
export async function runSevenZipBenchmark(
    binary: string,
    args: readonly string[],
    options: BenchmarkExecOptions = {},
): Promise<BenchmarkExec> {
    const timeoutMs = (options.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000;
    const proc = Bun.spawn([binary, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(options.env ?? {}) },
    });
    const stdoutText = new Response(proc.stdout).text();
    const stderrText = new Response(proc.stderr).text();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
            resolveTimeout("timeout");
        }, timeoutMs);
    });
    const outcome = await Promise.race([proc.exited, timeout]);
    const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
        throw new Error(`7-Zip 基准超过 ${timeoutMs}ms 未结束，已杀进程（--timeout-s 可调）`);
    }
    const code = outcome as number;
    if (code !== 0) {
        throw new Error(
            `7-Zip 基准退出码 ${code}（${binary} ${args.join(" ")}）: ` +
                `${stderr.trim().slice(0, 400) || "(无 stderr)"}`,
        );
    }
    return { code, stdout, stderr, merged: `${stdout}\n${stderr}` };
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export interface CalibrateOptions {
    binary?: string;
    repeats?: number;
    threads?: number;
    timeoutS?: number;
    log?: (line: string) => void;
    /**
     * 原始日志目录；不给就落到系统临时目录（**库不留痕**）。CLI 一律显式给
     * `--out-dir`（默认 `data/calibration/<timestamp>`），产物归仓库里的 data/。
     */
    logDir?: string;
    measuredAt?: Date;
    /** host 快照的取得方式（测试注入假宿主）。 */
    host?: () => CalibrationHost;
}

/** 当前宿主的校准快照（字段与 run.json 的 `host` 对齐）。 */
export function calibrationHost(): CalibrationHost {
    const snapshot = hostSnapshot();
    return {
        hostname: snapshot.hostname,
        platform: snapshot.platform,
        arch: snapshot.arch,
        cpuModel: snapshot.cpuModel,
        cpus: snapshot.cpus,
        totalMemBytes: snapshot.totalMemBytes,
        osRelease: snapshot.osRelease,
        loadAvg: snapshot.loadAvgStart,
        bunVersion: snapshot.bunVersion,
    };
}

/** 默认输出目录：`data/calibration/<YYYYMMDD-HHMMSS>`（时间戳目录，一次校准一套产物）。 */
export function defaultCalibrationDir(now: Date = new Date()): string {
    return resolve(REPO_ROOT, "data/calibration", formatRunId(now));
}

/**
 * 按列统计，**压缩与解压各自一份**。
 *
 * 两半是同一台机器上的两次不同测量（压缩吃 CPU 的哈希、解压吃内存带宽），把两半倒进同一个
 * 池子算出来的「均值 / CV」既不是压缩的也不是解压的——那是两条分布拼成的第三条分布。
 * 所以这里分开算，合并只在 `combineHalves` 一处发生（`rating` / `ru` 那两个统计量是**每轮先
 * 合并、再对轮次取统计**，口径写在 `stats.rating` / `stats.ru` 的注释里）。
 */
function columnStats(runs: readonly CalibrationRun[]): BenchmarkSeries["stats"]["columns"] {
    const perHalf = (pick: (run: CalibrationRun) => BenchmarkMetrics): Record<keyof BenchmarkMetrics, Stats> => {
        const out = {} as Record<keyof BenchmarkMetrics, Stats>;
        // 列的名单只在 `BENCHMARK_COLUMNS` 一处（与 7-Zip 表头同序）。
        for (const column of BENCHMARK_COLUMNS) {
            out[column] = statsOf(runs.map((run) => pick(run)[column]));
        }
        return out;
    };
    return {
        compress: perHalf((run) => run.compress),
        decompress: perHalf((run) => run.decompress),
    };
}

/** 逐列均值：**先按轮次把两半合并**（`combineHalves`，同一口径），再对轮次取均值。 */
function meanMetrics(runs: readonly CalibrationRun[]): BenchmarkMetrics {
    const combined = runs.map((run) => combineHalves(run.compress, run.decompress));
    const mean = (pick: (entry: BenchmarkMetrics) => number): number =>
        statsOf(combined.map(pick)).mean;
    return {
        speed: mean((entry) => entry.speed),
        usage: mean((entry) => entry.usage),
        ru: mean((entry) => entry.ru),
        rating: mean((entry) => entry.rating),
    };
}

/**
 * 一路读数（每轮两半 + 统计 + 合并均值）。
 *
 * `divisor` 是折算「每 CPU」时的除数：单线程那一路恒为 1；整机那一路用 **7-Zip 报告的实际
 * 参与计时 CPU 数**（拿不到才退回请求的线程数）——不能拿「请求了几个线程」假装实测。
 *
 * **导出是刻意的**：它是 `calibrate()` 里「解析后的读数 → 统计」的那一半，不含任何 spawn。
 * 所以**已经跑过的原始日志可以事后重新汇总**（例如口径修好了、要拿同一批日志重出一份
 * report），不必再跑一遍基准：
 *
 * ```ts
 * // 逐份读 logs/<角色>.log → parseBenchmarkOutput → buildSeries(...) → 组装 report
 * const runs = logs.map((file, index) => {
 *     const parsed = parseBenchmarkOutput(readFileSync(file, "utf8"));
 *     return { index: index + 1, log: file, compress: parsed.compress,
 *              decompress: parsed.decompress, totals: parseTotalsLine(text) };
 * });
 * const singleThread = buildSeries("single-thread (`-mmt1`)", 1, singleRuns);
 * const machine = buildSeries("whole machine", threads, machineRuns, cpusUsed ?? threads);
 * ```
 * 折算用的那两个数就在 `singleThread.stats.ru.mean`（→ `cpuScaleOf(...)` 得 `cpuScale`）与
 * `machine.stats.rating.mean`（→ 整机吞吐 = 它 / baseline）里，别自己另算一套。
 */
export function buildSeries(
    label: string,
    threads: number,
    runs: CalibrationRun[],
    divisor: number = threads,
): BenchmarkSeries {
    const columns = columnStats(runs);
    // 「每轮先合并两半、再对轮次统计」是刻意的：先算出每轮对这台机器的代表值（算术平均），
    // 轮次之间的离散度才是「这把尺子稳不稳」。求和会把 Rating 虚高一倍（压缩 + 解压）。
    const perRun = runs.map((run) => combineHalves(run.compress, run.decompress));
    const rating = statsOf(perRun.map((entry) => entry.rating));
    const ru = statsOf(perRun.map((entry) => entry.ru));
    const mean = meanMetrics(runs);
    return {
        label,
        threads,
        runs,
        stats: { columns, rating, ru },
        mean,
        perCpuMean: perCpuMetrics(mean, divisor),
    };
}

/**
 * 跑一次完整校准：1 轮 warmup（不计入）→ `repeats` 轮单线程 → `repeats` 轮整机。
 *
 * 每一步都真的 spawn 一遍 7-Zip（没有「跳过 warmup 省时间」的开关：它的存在就是不让第一条
 * 冷读数进均值）。任何一轮失败（超时 / 非 0 退出 / 解析失败）都整体抛错——半份校准比没有更危险。
 */
export async function calibrate(options: CalibrateOptions = {}): Promise<Calibration> {
    const log = options.log ?? (() => {});
    const repeats = options.repeats ?? DEFAULT_REPEATS;
    if (!Number.isInteger(repeats) || repeats < MIN_REPEATS) {
        throw new Error(
            `重复次数至少 ${MIN_REPEATS}（默认 ${DEFAULT_REPEATS}），收到 ${JSON.stringify(options.repeats)}`,
        );
    }
    const threads = options.threads ?? availableParallelism();
    benchmarkArgs(threads);
    const binaryPath = resolveSevenZipBinary(options.binary);
    const binary = inspectBinary(binaryPath);
    const host = (options.host ?? calibrationHost)();
    const measuredAt = options.measuredAt ?? new Date();
    const logDir = options.logDir ?? defaultCalibrationDir(measuredAt);
    mkdirSync(logDir, { recursive: true });
    log(`[calibrate] 二进制 ${binary.realPath} · sha256 ${binary.sha256.slice(0, 16)}…`);
    log(
        `[calibrate] host ${host.hostname} · ${host.platform}/${host.arch} · ${host.cpuModel} · ` +
            `${host.cpus} cpus · ${(host.totalMemBytes / 2 ** 30).toFixed(1)}GiB`,
    );

    const logs: Calibration["logs"] = [];
    const warnings: CalibrationWarning[] = [];

    /** 跑一轮：spawn → 解析 → 原始日志落盘并记 sha256。 */
    const pass = async (
        role: string,
        label: string,
        args: readonly string[],
    ): Promise<{ parsed: BenchmarkResult; log: string; totals: BenchmarkTotals | null }> => {
        log(`[calibrate] ${label}`);
        const exec = await runSevenZipBenchmark(binary.path, args, { timeoutS: options.timeoutS });
        let parsed: BenchmarkResult;
        try {
            parsed = parseBenchmarkOutput(exec.merged);
        } catch (error) {
            const first = exec.merged.split(/\r?\n/).find((line) => line.trim() !== "") ?? "(空输出)";
            throw new Error(
                `${label} 的输出解析失败：${(error as Error).message}；首行: ${first.slice(0, 200)}`,
            );
        }
        const file = `${role}.log`;
        writeFileSync(resolve(logDir, file), exec.merged);
        const content = readFileSync(resolve(logDir, file));
        logs.push({
            role,
            file,
            bytes: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
        });
        return { parsed, log: file, totals: parseTotalsLine(exec.merged) };
    };

    // 1. warmup：单线程一轮，读数**不进统计**（只留原始日志，方便事后看第一轮有多冷）。
    const warmupPass = await pass("warmup", "warmup（单线程，不计入统计）", benchmarkArgs(1));
    const warmup: Calibration["warmup"] = {
        log: warmupPass.log,
        compress: warmupPass.parsed.compress,
        decompress: warmupPass.parsed.decompress,
    };

    // 2. 单线程测量（≥3 轮）——折算只认这一路的 R/U。
    const singleRuns: CalibrationRun[] = [];
    for (let index = 1; index <= repeats; index += 1) {
        const result = await pass(
            `single-${index}`,
            `单线程 ${index}/${repeats}（-mmt1）`,
            benchmarkArgs(1),
        );
        singleRuns.push({
            index,
            log: result.log,
            compress: result.parsed.compress,
            decompress: result.parsed.decompress,
            totals: result.totals,
        });
    }
    const singleThread = buildSeries("single-thread (`-mmt1`)", 1, singleRuns);

    // 3. 整机测量（≥3 轮，线程数默认 = availableParallelism）。
    const machineRuns: CalibrationRun[] = [];
    let cpusUsed: number | null = null;
    for (let index = 1; index <= repeats; index += 1) {
        const result = await pass(
            `machine-${index}`,
            `整机 ${index}/${repeats}（-mmt${threads}）`,
            benchmarkArgs(threads),
        );
        cpusUsed ??= result.parsed.cpus;
        machineRuns.push({
            index,
            log: result.log,
            compress: result.parsed.compress,
            decompress: result.parsed.decompress,
            totals: result.totals,
        });
    }
    const machineSeries = buildSeries(
        `whole machine (\`-mmt${threads}\`)`,
        threads,
        machineRuns,
        cpusUsed ?? threads,
    );
    const machineStandardUnits = {
        throughput: machineSeries.stats.rating.mean / BASELINE_MIPS_PER_CPU_SECOND,
        note:
            `= 整机原始 Rating 均值 / ${BASELINE_MIPS_PER_CPU_SECOND}；` +
            "本次观察吞吐（不是「单线程读数 × 逻辑核数」，那是假装的实测）",
    };

    // 4. 折算 + 门槛检查：任何一项不成立就抛，不许出半份校准。
    const cpuScale = cpuScaleOf(singleThread.stats.ru.mean);
    const singleCv = singleThread.stats.rating.cvPercent;
    const machineCv = machineSeries.stats.rating.cvPercent;
    if (singleThread.stats.ru.cvPercent > CV_WARN_PERCENT) {
        warnings.push({
            code: "single-thread-cv-high",
            message:
                `单线程 R/U（折算用的那一列）的 CV 是 ${singleThread.stats.ru.cvPercent.toFixed(2)}%` +
                `（阈值 ${CV_WARN_PERCENT}%）：本机当时有其他负载，这一份 cpuScale 只是「这一刻的机器」`,
        });
    }
    if (machineCv > WHOLE_MACHINE_CV_WARN_PERCENT) {
        warnings.push({
            code: "whole-machine-cv-high",
            message:
                `整机 ${threads} 线程 Rating 的 CV 是 ${machineCv.toFixed(2)}%` +
                `（阈值 ${WHOLE_MACHINE_CV_WARN_PERCENT}%）：整机吞吐只是**本次观察值**，不代表稳定口径`,
        });
    }
    if (threads === 1) {
        warnings.push({
            code: "threads-equals-one",
            message: "整机那一路只用了 1 个线程，读数与单线程同源，不代表整机能力",
        });
    }
    if (cpusUsed !== null && cpusUsed !== threads) {
        warnings.push({
            code: "cpus-used-mismatch",
            message: `7-Zip 报告参与计时的 CPU 数是 ${cpusUsed}，与请求的 ${threads} 不一致`,
        });
    }
    const configSignature = [
        binary.sha256,
        SEVEN_ZIP_VERSION,
        `${BENCHMARK_ARGS.join(" ")}`,
        `dict=${BENCHMARK_DICT_SIZE}`,
        `baseline=${BASELINE_MIPS_PER_CPU_SECOND}`,
        `repeats=${repeats}`,
        `threads=${threads}`,
    ].join("|");

    return {
        schemaVersion: CALIBRATION_SCHEMA_VERSION,
        method: CALIBRATION_METHOD,
        measuredAt: measuredAt.toISOString(),
        host,
        tool: {
            name: "7zip",
            version: SEVEN_ZIP_VERSION,
            binary,
            args: {
                mode: "b",
                iterations: 1,
                threads: 1,
                dictSize: BENCHMARK_DICT_SIZE,
                argv: [...BENCHMARK_ARGS],
            },
            configSignature,
            measuredAt: measuredAt.toISOString(),
        },
        scale: {
            baselineMips: BASELINE_MIPS_PER_CPU_SECOND,
            cpuScale,
            cpuScaleValue: singleThread.stats.ru.mean,
            baseline:
                `${BASELINE_MIPS_PER_CPU_SECOND} benchmark MIPS per CPU-second` +
                "（7-Zip 历史 normalized rating 的项目单位；不是真实机器指令数，也不是 SPEC / 云商 vCPU）",
            unit: "本机核·秒 × cpuScale = 项目标准 CPU 单位·秒（项目自定单位，无真实参考机器）",
            oneCoreSecond: {
                rawRu: singleRuns.map((run) => (run.compress.ru + run.decompress.ru) / 2),
                rawRatings: singleRuns.map((run) => run.compress.rating + run.decompress.rating),
            },
        },
        singleThread,
        machine: {
            ...machineSeries,
            cpusUsed,
            standardUnits: machineStandardUnits,
        },
        warmup,
        logs,
        statistic: {
            metric: "ru-arith-mean",
            repeats,
            warmupRuns: 1,
            formula:
                "cpuScale = meanRU / baselineMips；meanRU = repeats 轮单线程 R/U 的算术平均，" +
                "每轮的 R/U =（压缩 R/U + 解压 R/U）/ 2",
        },
        warnings,
        logDir,
        loadAvgAtStart: host.loadAvg,
        loadAvgAtEnd: hostSnapshot().loadAvgStart,
        appliedToCu: false,
    };
}

/** 解析（并粗校验）一份校准 JSON：字段缺失或口径不符就抛，别让下游拿到半截对象。 */
export function parseCalibration(text: string, source: string): Calibration {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`${source} 不是合法 JSON：${(error as Error).message}`);
    }
    const value = parsed as Partial<Calibration>;
    const missing: string[] = [];
    if (value === null || typeof value !== "object") {
        throw new Error(`${source} 不是一个对象`);
    }
    if (value.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
        throw new Error(
            `${source} 的 schemaVersion=${String(value.schemaVersion)}，本工具只认 ${CALIBRATION_SCHEMA_VERSION}`,
        );
    }
    if (value.method !== CALIBRATION_METHOD) {
        throw new Error(`${source} 的 method=${String(value.method)}，本工具只认 ${CALIBRATION_METHOD}`);
    }
    if (typeof value.scale?.cpuScale !== "number" || !Number.isFinite(value.scale.cpuScale) ||
        value.scale.cpuScale <= 0) {
        throw new Error(`${source} 缺少可用的 scale.cpuScale（必须是有限正数）`);
    }
    if (value.scale?.baselineMips !== BASELINE_MIPS_PER_CPU_SECOND) {
        throw new Error(
            `${source} 的 scale.baselineMips=${String(value.scale?.baselineMips)}，` +
                `本工具只认 ${BASELINE_MIPS_PER_CPU_SECOND}`,
        );
    }
    if (value.host === undefined || value.host === null) missing.push("host");
    if (value.tool?.version !== SEVEN_ZIP_VERSION) {
        throw new Error(
            `${source} 的 tool.version=${String(value.tool?.version)}，本工具只认 ${SEVEN_ZIP_VERSION}` +
                "（换版本等于换尺子）",
        );
    }
    if (typeof value.tool?.binary?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.tool.binary.sha256)) {
        missing.push("tool.binary.sha256");
    }
    if (typeof value.measuredAt !== "string") missing.push("measuredAt");
    if (typeof value.logDir !== "string") missing.push("logDir");
    if (missing.length > 0) throw new Error(`${source} 缺少字段: ${missing.join(", ")}`);
    return value as Calibration;
}

/** 校准 JSON 的摘要（写进 run.json / 图表 payload 的那一块，别把整份 JSON 塞进去）。 */
export interface CalibrationRef {
    method: string;
    /** **校准 JSON 文件本身**：`<logDir>/calibration.json`（可直接打开的那一份，不是目录）。 */
    file: string;
    measuredAt: string;
    /** 乘进 core·秒。 */
    cpuScale: number;
    baselineMips: number;
    /** 折算用的原始值（单线程 R/U 均值）。 */
    cpuScaleValue: number;
    statistic: { metric: string; repeats: number };
    binary: { path: string; realPath: string; sha256: string };
    toolVersion: string;
    /** 口径口令：变了就不是同一把尺子。 */
    configSignature: string;
    warningCount: number;
    /** 单线程 Rating 的 CV（%）：这把尺子量得稳不稳。 */
    singleThreadCvPercent: number;
    /** 整机那一路的**实测**吞吐（观察值，不是「单线程 × 核数」）。 */
    machine: { threads: number; standardUnitsThroughput: number };
    host: CalibrationHost;
}

/** 完整校准 → 摘要（读取端只认摘要里的这几个数，不重解析整份 JSON）。 */
export function calibrationRef(calibration: Calibration): CalibrationRef {
    return {
        method: calibration.method,
        // 指向**文件**（不是目录）：读取端拿这一行要能直接打开回查逐轮读数与日志 sha256。
        file: join(calibration.logDir, "calibration.json"),
        measuredAt: calibration.measuredAt,
        cpuScale: calibration.scale.cpuScale,
        baselineMips: calibration.scale.baselineMips,
        cpuScaleValue: calibration.scale.cpuScaleValue,
        statistic: {
            metric: calibration.statistic.metric,
            repeats: calibration.statistic.repeats,
        },
        binary: calibration.tool.binary,
        toolVersion: calibration.tool.version,
        configSignature: calibration.tool.configSignature,
        warningCount: calibration.warnings.length,
        singleThreadCvPercent: calibration.singleThread.stats.rating.cvPercent,
        machine: {
            threads: calibration.machine.threads,
            standardUnitsThroughput: calibration.machine.standardUnits.throughput,
        },
        host: calibration.host,
    };
}

/** 读取并解析一份校准 JSON。 */
export function loadCalibration(path: string): Calibration {
    if (!existsSync(path)) throw new Error(`找不到校准文件: ${path}（先跑 --cpu:calibrate 生成）`);
    return parseCalibration(readFileSync(path, "utf8"), path);
}

// ---------------------------------------------------------------------------
// 宿主核对：校准值只在量它的那台机器上成立
// ---------------------------------------------------------------------------

/**
 * 与「这次运行/这份产物记下的宿主」逐项比对的字段。
 *
 * 只比**硬件与机器身份**，不比 `loadAvg` / `bunVersion`：那是「量的时候忙不忙」，不是机器身份。
 * `osRelease` 也不比——同一台机器升个小版本不该让校准作废（真要严到这个程度，得连编译器
 * 版本一起比，那属于另一层）。cpuModel / cpus / totalMemBytes 相比是刻意的：内存标称值不同
 * 的机器不可能是同一台。
 */
export const HOST_MATCH_FIELDS = [
    "hostname",
    "platform",
    "arch",
    "cpuModel",
    "cpus",
    "totalMemBytes",
] as const;

export type HostMatchField = (typeof HOST_MATCH_FIELDS)[number];

/** 能参与核对的宿主快照：校准侧与 run.json 侧都是这个形状的超集。 */
export type ComparableHost = Partial<Record<HostMatchField, unknown>> | Record<string, unknown>;

/** 逐项比对，返回不一致的说明（空数组 = 匹配）。缺项也算不一致：**不许静默放过**。 */
export function hostMismatches(
    expected: ComparableHost | null,
    actual: ComparableHost | null,
): string[] {
    if (expected === null || actual === null) {
        return ["宿主快照缺失：校准值无法与这台机器核对（老产物或未记录 host）"];
    }
    const mismatches: string[] = [];
    for (const field of HOST_MATCH_FIELDS) {
        const left = expected[field];
        const right = actual[field];
        if (left === undefined || right === undefined) {
            mismatches.push(`${field} 缺失（${left === undefined ? "校准侧" : "产物侧"}）`);
            continue;
        }
        if (left !== right) mismatches.push(`${field} ${String(left)}≠${String(right)}`);
    }
    return mismatches;
}
