/**
 * CPU 校准的单元测试：解析（只认 `25:` 那一行）、折算方向、宿主核对。
 *
 * 样例输出是按 7-Zip 26.01 **真实格式**手写的（真机对拍在 calibrate.real.test.ts，默认跳过，
 * 需要 `CALIBRATE_REAL=1` 才开）：本文件的用例**一个字节都不 spawn**，跑得飞快。
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BASELINE_MIPS_PER_CPU_SECOND,
    CALIBRATION_METHOD,
    CALIBRATION_SCHEMA_VERSION,
    SEVEN_ZIP_VERSION,
    combineHalves,
    cpuScaleOf,
    hostMismatches,
    parseBenchmarkOutput,
    parseSevenZipVersion,
    parseTotalsLine,
    statsOf,
    type Calibration,
} from "./calibrate";
import { resourceCost, segmentCosts } from "./score";

/** 临时目录（用例用完删）。 */
const tempDirs: string[] = [];
afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 一份 7-Zip 26.01 的真实形状输出（数值取自本机实测，`25:` 那一行即 32MiB）。
 * 注意两个真实细节：**压缩与解压在同一行的 `|` 两侧**，而且 **`Avr:` 是四个尺寸的均值**
 * ——所以这里故意把 Avr 写成与 `25:` 明显不同的数，「只取 25:」被改坏时立刻失败。
 */
function benchmarkOutput(compress25 = [6086, 98, 7100, 6949], decompress25 = [88186, 93, 8397, 7849]): string {
    return [
        "7-Zip (z) 26.01 (arm64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-04-27",
        " 64-bit arm_v:8.5-A locale=C.UTF-8 Threads:18 OPEN_MAX:1048575, ASM",
        "",
        " mt1 d25",
        "Compiler:  CLANG 21.0.0",
        "Darwin : 25.5.0 : arm64",
        "Apple M5 Pro 18C18T",
        "",
        "RAM size:   49152 MB,  # CPU hardware threads:  18",
        "RAM usage:    437 MB,  # Benchmark threads:      1",
        "",
        "                       Compressing  |                  Decompressing",
        "Dict     Speed Usage    R/U Rating  |      Speed Usage    R/U Rating",
        "         KiB/s     %   MIPS   MIPS  |      KiB/s     %   MIPS   MIPS",
        "",
        "22:       9985    99   9791   9714  |     126157   100  10790  10771",
        "23:       8189    99   8412   8344  |     120137    99  10458  10399",
        "24:       7335    99   7930   7887  |     121744   100  10732  10688",
        `25:       ${compress25[0]}    ${compress25[1]}   ${compress25[2]}   ${compress25[3]}  |     ` +
            `${decompress25[0]}   ${decompress25[1]}  ${decompress25[2]}  ${decompress25[3]}`,
        "----------------------------------  | ------------------------------",
        "Avr:      9999    99   1111   2222  |     111111   100  3333  4444",
        "Tot:             100  10047  10017",
        "",
    ].join("\n");
}

describe("parseSevenZipVersion", () => {
    it("从 banner 里取版本号", () => {
        expect(parseSevenZipVersion("7-Zip (z) 26.01 (arm64) : Copyright")).toBe(SEVEN_ZIP_VERSION);
    });

    it("不是 7-Zip / 没有 banner 就抛", () => {
        expect(() => parseSevenZipVersion("total 8\ndrwxr-xr-x 2 me")).toThrow(/banner/);
    });

    it("版本不对就抛：换版本等于换尺子", () => {
        expect(() => parseSevenZipVersion("7-Zip (z) 25.01 (arm64) : Copyright")).toThrow(/26\.01/);
    });
});

describe("parseBenchmarkOutput：只取 25: 那一行", () => {
    it("取 25: 行的压缩 / 解压八列，不碰 Avr / Tot / 别的尺寸", () => {
        const parsed = parseBenchmarkOutput(benchmarkOutput());
        expect(parsed.version).toBe(SEVEN_ZIP_VERSION);
        expect(parsed.compress).toEqual({ speed: 6086, usage: 98, ru: 7100, rating: 6949 });
        expect(parsed.decompress).toEqual({ speed: 88186, usage: 93, ru: 8397, rating: 7849 });
        // Avr 那行是 1111/2222（压缩）与 3333/4444（解压）：任何一项漏进来都说明取错行
        expect(parsed.compress.ru).not.toBe(1111);
        expect(parsed.decompress.ru).not.toBe(3333);
        // 别把 22/23/24 行也算进来（只认 25:）
        expect(parsed.compress.speed).not.toBe(9985);
    });

    it("合并两半：R/U 与 Rating 取算术平均（**不是求和**），Speed 取两路之和", () => {
        const parsed = parseBenchmarkOutput(benchmarkOutput());
        // 求和会把「这台机器有多快」虚高一倍——这条用例就是钉住这个方向
        expect(parsed.machine.rating).toBe((6949 + 7849) / 2);
        expect(parsed.machine.ru).toBe((7100 + 8397) / 2);
        expect(parsed.machine.usage).toBe((98 + 93) / 2);
        expect(parsed.machine.speed).toBe(6086 + 88186);
        expect(combineHalves(parsed.compress, parsed.decompress)).toEqual(parsed.machine);
    });

    it("带 CPU 数那列（多线程的 `Dict Size 25:` 变体）也认得，并按它折算每 CPU 读数", () => {
        const text = benchmarkOutput().replace(
            /25:\s+6086[^\n]*/,
            "Dict Size 25:  18  67358  825 9328 76907 |  818572  896 8127 72830",
        );
        const parsed = parseBenchmarkOutput(text);
        expect(parsed.cpus).toBe(18);
        expect(parsed.compress.rating).toBe(76907);
        expect(parsed.compress.ru).toBe(9328);
        expect(parsed.decompress.rating).toBe(72830);
        // 每 CPU 只是显示用；折算仍然只认单线程那一路
        expect(parsed.perCpu.rating).toBeCloseTo((76907 + 72830) / 2 / 18, 9);
    });

    it("缺 25: 行就抛（参数没带 -md25 / 输出被截断）", () => {
        const text = benchmarkOutput()
            .split("\n")
            .filter((line) => !line.startsWith("25:"))
            .join("\n");
        expect(() => parseBenchmarkOutput(text)).toThrow(/25:/);
    });

    it("同一行出现两次也抛（形状不对时不猜哪一行是真的）", () => {
        const text = benchmarkOutput().replace(
            "Tot:",
            "25:       6086    98   7100   6949  |      88186    93   8397   7849\nTot:",
        );
        expect(() => parseBenchmarkOutput(text)).toThrow(/出现 2 次/);
    });

    it("列数不够就抛", () => {
        const text = benchmarkOutput().replace(
            /25:\s+6086[^\n]*/,
            "25:       6086    98   7100  |      88186    93   8397",
        );
        expect(() => parseBenchmarkOutput(text)).toThrow(/列/);
    });

    it("没有 `|` 分隔也抛", () => {
        const text = benchmarkOutput().replace(
            /25:\s+6086[^\n]*/,
            "25:       6086    98   7100   6949",
        );
        expect(() => parseBenchmarkOutput(text)).toThrow(/两半/);
    });

    it("0 / 负数 / 非数字一律拒绝，不静默按 0 处理", () => {
        // 0 被「有限正数」挡下（列数形状是对的，值不行）
        const zero = benchmarkOutput([0, 98, 7100, 6949]);
        expect(() => parseBenchmarkOutput(zero)).toThrow(/compress\.speed/);
        // 负数连形状都不对 → 直接拒绝解析，不猜
        const negative = benchmarkOutput([6086, 98, 7100, 6949]).replace(/\b7100\b/, "-7100");
        expect(() => parseBenchmarkOutput(negative)).toThrow(/拒绝猜/);
        // NaN 形状过了、值不过
        const nan = benchmarkOutput([6086, 98, 7100, 6949]).replace(/\b6949\b/, "NaN");
        expect(() => parseBenchmarkOutput(nan)).toThrow(/拒绝猜|有限正数|非负小数/);
    });

    it("Tot 行是真实的三列（usage / R/U / rating），可缺省", () => {
        expect(parseTotalsLine(benchmarkOutput())).toEqual({ usage: 100, ru: 10047, rating: 10017 });
        expect(parseTotalsLine("7-Zip (z) 26.01 (arm64)")).toBeNull();
        // 形状不对就抛，不静默返回 null（那会让人以为「这份输出没有 Tot 行」）
        expect(() => parseTotalsLine("Tot: 1 2 3 4 5")).toThrow(/形状/);
        expect(() => parseTotalsLine("Tot: 0 10047 10017")).toThrow(/有限正数/);
        // **不能跨行**：`\s` 会吃掉换行，早先的写法会把下面几行的数接上来凑够五列
        expect(() => parseTotalsLine("Tot:\n100\n10047\n10017")).toThrow(/形状/);
    });
});

describe("cpuScaleOf：方向是乘", () => {
    it("快机器算出更大的 scale（本机核·秒 → 更多标准秒）", () => {
        // 单线程 R/U = 7000 → 7000 / 1000 = 7 个标准核·秒每本机核·秒
        expect(cpuScaleOf(7000)).toBeCloseTo(7, 12);
        const fast = cpuScaleOf(9000);
        const slow = cpuScaleOf(3000);
        expect(fast).toBeGreaterThan(slow);
        expect(fast / slow).toBeCloseTo(3, 12);
    });

    it("非有限 / 非正一律抛", () => {
        expect(() => cpuScaleOf(0)).toThrow(/有限正数/);
        expect(() => cpuScaleOf(Number.NaN)).toThrow(/有限正数/);
        expect(() => cpuScaleOf(1000, 0)).toThrow(/baseline/);
    });

    it("baseline 是项目单位 1000，不是 1", () => {
        expect(BASELINE_MIPS_PER_CPU_SECOND).toBe(1000);
        expect(cpuScaleOf(1000)).toBe(1);
    });
});

describe("statsOf", () => {
    it("均值 / 样本标准差 / CV", () => {
        const stats = statsOf([10, 12, 14]);
        expect(stats.count).toBe(3);
        expect(stats.mean).toBe(12);
        expect(stats.sampleStddev).toBeCloseTo(2, 12);
        expect(stats.cvPercent).toBeCloseTo((2 / 12) * 100, 12);
    });

    it("单样本：样本标准差为 0（不是 NaN）", () => {
        expect(statsOf([5])).toEqual({ count: 1, mean: 5, sampleStddev: 0, cvPercent: 0 });
    });

    it("空样本或非正样本一律抛", () => {
        expect(() => statsOf([])).toThrow(/至少一个样本/);
        expect(() => statsOf([1, 0])).toThrow(/有限正数/);
        expect(() => statsOf([1, Number.POSITIVE_INFINITY])).toThrow(/有限正数/);
    });
});

describe("hostMismatches：宿主核对", () => {
    const host = {
        hostname: "mac",
        platform: "darwin",
        arch: "arm64",
        cpuModel: "Apple M5 Pro",
        cpus: 18,
        totalMemBytes: 51_539_607_552,
    };

    it("六项全等就算匹配（别的不参与）", () => {
        expect(hostMismatches(host, { ...host })).toEqual([]);
        // 负载、OS 小版本、bun 版本都不是机器身份，不参与核对
        expect(hostMismatches(host, { ...host, osRelease: "25.5.0", bunVersion: "1.4.0" })).toEqual([]);
    });

    it("任一硬件项不符就点名（不许静默用错 host）", () => {
        const other = { ...host, hostname: "other-mac" };
        expect(hostMismatches(host, other)).toEqual(["hostname mac≠other-mac"]);
        expect(hostMismatches(host, { ...host, cpus: 8 })).toEqual(["cpus 18≠8"]);
        expect(hostMismatches(host, { ...host, cpuModel: "Apple M1" })).toEqual([
            "cpuModel Apple M5 Pro≠Apple M1",
        ]);
    });

    it("缺快照或缺字段也当不匹配（老产物没有 host）", () => {
        expect(hostMismatches(null, host)[0]).toContain("宿主快照缺失");
        expect(hostMismatches(host, { hostname: "mac" })).toContain("platform 缺失（产物侧）");
    });
});

describe("折算只乘 CPU 项（scale 方向与作用范围）", () => {
    /** 2 拍：CPU 100%（0.1s → 0.1 核·秒）、RSS 1024MB（1GB × 0.1s = 0.1 GB·秒）。 */
    const samples = [0, 100].map((elapsedMs) => ({
        ts: 1_700_000_000_000 + elapsedMs,
        elapsedMs,
        cpuPercent: 100,
        rssBytes: 1024 * 1024 * 1024,
        treeCpuPercent: 100,
        treeRssBytes: 1024 * 1024 * 1024,
        procs: 1,
        childCpuPercent: 0,
    }));

    it("scale=1（未校准）时折算字段退化成原值", () => {
        const cost = resourceCost(samples, { scope: "root" });
        expect(cost.cpuScale).toBe(1);
        expect(cost.standardCpuSeconds).toBeCloseTo(cost.cpuSeconds, 12);
        expect(cost.rawCu).toBeCloseTo(cost.cu, 12);
        expect(cost.cu).toBeCloseTo(0.2, 12);
    });

    it("scale=7：核·秒 ×7、内存不变、rawCu 记原值", () => {
        const base = resourceCost(samples, { scope: "root" });
        const scaled = resourceCost(samples, { scope: "root", cpuScale: 7 });
        // CPU 项乘了，内存项原样
        expect(scaled.cpuSeconds).toBeCloseTo(base.cpuSeconds, 12);
        expect(scaled.standardCpuSeconds).toBeCloseTo(base.cpuSeconds * 7, 12);
        expect(scaled.cpuCu).toBeCloseTo(base.cpuCu * 7, 12);
        expect(scaled.memoryCu).toBeCloseTo(base.memoryCu, 12);
        expect(scaled.gbSeconds).toBeCloseTo(base.gbSeconds, 12);
        expect(scaled.rawCu).toBeCloseTo(base.cu, 12);
        expect(scaled.cu).toBeCloseTo(base.cu + base.cpuCu * 6, 12);
        // 后代那条路也照原样乘、峰值不受影响（峰值根本没进这个函数）
        expect(scaled.rootCpuSeconds).toBeCloseTo(base.rootCpuSeconds, 12);
    });

    it("方向：scale 越大 CU 越大（不是越小）", () => {
        expect(resourceCost(samples, { scope: "root", cpuScale: 7 }).cu).toBeGreaterThan(
            resourceCost(samples, { scope: "root", cpuScale: 1 }).cu,
        );
        expect(resourceCost(samples, { scope: "root", cpuScale: 0.5 }).cu).toBeLessThan(
            resourceCost(samples, { scope: "root", cpuScale: 1 }).cu,
        );
    });

    it("只改 CPU 项会改变排名：内存重的 harness 在快机器上被顶下去", () => {
        // A：CPU 重、内存轻；B：CPU 轻、内存重。scale=1 时 B 更省。
        const cpuHeavy = [
            { ts: 0, elapsedMs: 0, cpuPercent: 0, rssBytes: 0, treeCpuPercent: 0, treeRssBytes: 0, procs: 1, childCpuPercent: 0 },
            { ts: 1000, elapsedMs: 1000, cpuPercent: 100, rssBytes: 100 * 1024 ** 2, treeCpuPercent: 100, treeRssBytes: 100 * 1024 ** 2, procs: 1, childCpuPercent: 0 },
        ];
        const memoryHeavy = [
            { ts: 0, elapsedMs: 0, cpuPercent: 0, rssBytes: 0, treeCpuPercent: 0, treeRssBytes: 0, procs: 1, childCpuPercent: 0 },
            { ts: 1000, elapsedMs: 1000, cpuPercent: 10, rssBytes: 1024 * 1024 ** 2, treeCpuPercent: 10, treeRssBytes: 1024 * 1024 ** 2, procs: 1, childCpuPercent: 0 },
        ];
        const rawA = resourceCost(cpuHeavy, { scope: "root" }).cu;
        const rawB = resourceCost(memoryHeavy, { scope: "root" }).cu;
        expect(rawA).toBeLessThan(rawB);
        // CPU 项 ×7 之后 A 反超：排名变了——所以绝不能沿用「排序不变」的旧结论
        const scaledA = resourceCost(cpuHeavy, { scope: "root", cpuScale: 7 }).cu;
        const scaledB = resourceCost(memoryHeavy, { scope: "root", cpuScale: 7 }).cu;
        expect(scaledA).toBeGreaterThan(scaledB);
    });

    it("分段成本也带着同一个系数（三段之和仍等于整段）", () => {
        const marks = { first: 50, last: 150 };
        const parts = segmentCosts(samples, marks, { scope: "root", cpuScale: 7 });
        const whole = resourceCost(samples, { scope: "root", cpuScale: 7 });
        expect(parts.startup.cpuScale).toBe(7);
        expect(parts.span.cpuScale).toBe(7);
        expect(parts.startup.cu + parts.span.cu + parts.tail.cu).toBeCloseTo(whole.cu, 12);
    });

    it("非法 cpuScale 直接抛，不静默按 1 处理", () => {
        expect(() => resourceCost(samples, { cpuScale: 0 })).toThrow(/有限正数/);
        expect(() => resourceCost(samples, { cpuScale: Number.NaN })).toThrow(/有限正数/);
    });
});

/** 手搓一份校准 JSON（形状与 calibrate() 的产物一致），只用于核对读取端。 */
export function fakeCalibration(overrides: Partial<Calibration> = {}): Calibration {
    const binary = {
        path: "/opt/homebrew/bin/7zz",
        realPath: "/opt/homebrew/Cellar/sevenzip/26.01/bin/7zz",
        sizeBytes: 1,
        mtimeMs: 1,
        sha256: "a".repeat(64),
    };
    const run = (index: number, rating: number) => ({
        index,
        log: `single-${index}.log`,
        compress: { speed: 6000, usage: 98, ru: 7000, rating },
        decompress: { speed: 88000, usage: 93, ru: 7200, rating },
        totals: null,
    });
    const runs = [run(1, 6800), run(2, 6900), run(3, 6949)];
    return {
        schemaVersion: CALIBRATION_SCHEMA_VERSION,
        method: CALIBRATION_METHOD,
        measuredAt: "2026-09-22T05:00:00.000Z",
        host: {
            hostname: "mac",
            platform: "darwin",
            arch: "arm64",
            cpuModel: "Apple M5 Pro",
            cpus: 18,
            totalMemBytes: 51_539_607_552,
            osRelease: "25.5.0",
            loadAvg: [3, 3, 3],
            bunVersion: "1.4.0",
        },
        tool: {
            name: "7zip",
            version: SEVEN_ZIP_VERSION,
            binary,
            args: { mode: "b", iterations: 1, threads: 1, dictSize: 25, argv: ["b", "1", "-mmt1", "-md25"] },
            configSignature: "sig",
            measuredAt: "2026-09-22T05:00:00.000Z",
        },
        scale: {
            baselineMips: BASELINE_MIPS_PER_CPU_SECOND,
            cpuScale: 6.949,
            cpuScaleValue: 6949,
            baseline: "1000 benchmark MIPS per CPU-second",
            unit: "本机核·秒 × cpuScale = 标准机核·秒",
            oneCoreSecond: { rawRu: [6900, 7000, 6947], rawRatings: [6800, 6900, 6949] },
        },
        singleThread: {
            label: "single-thread (`-mmt1`)",
            threads: 1,
            runs,
            stats: {
                // 两半各自一份（压缩 / 解压不混池），口径见 columnStats 的注释
                columns: {
                    compress: {
                        speed: statsOf([6000, 6000, 6000]),
                        usage: statsOf([98, 98, 98]),
                        ru: statsOf([7000, 7000, 7000]),
                        rating: statsOf([6800, 6900, 6949]),
                    },
                    decompress: {
                        speed: statsOf([88000, 88000, 88000]),
                        usage: statsOf([93, 93, 93]),
                        ru: statsOf([6900, 7000, 6947]),
                        rating: statsOf([7900, 7800, 7849]),
                    },
                },
                // 每轮**先合并两半**再对轮次取统计（不是把两半倒进一个池子）
                rating: statsOf([7350, 7350, 7399]),
                ru: statsOf([6950, 7000, 6973.5]),
            },
            mean: { speed: 94000, usage: 95.5, ru: 7100, rating: 6949 },
            perCpuMean: { speed: 94000, usage: 95.5, ru: 7100, rating: 6949 },
        },
        machine: {
            label: "whole machine (`-mmt18`)",
            threads: 18,
            runs,
            stats: {
                columns: {
                    compress: {
                        speed: statsOf([138506, 138506, 138506]),
                        usage: statsOf([1538, 1538, 1538]),
                        ru: statsOf([10280, 10280, 10280]),
                        rating: statsOf([158141, 158141, 158141]),
                    },
                    decompress: {
                        speed: statsOf([1554306, 1554306, 1554306]),
                        usage: statsOf([1528, 1528, 1528]),
                        ru: statsOf([9050, 9050, 9050]),
                        rating: statsOf([138289, 138289, 138289]),
                    },
                },
                // 整机那一路也是「每轮压缩 / 解压的算术平均」
                rating: statsOf([148215, 148215, 148215]),
                ru: statsOf([9665, 9665, 9665]),
            },
            mean: { speed: 90000, usage: 95, ru: 15000, rating: 150000 },
            perCpuMean: { speed: 5000, usage: 5.28, ru: 833, rating: 8333 },
            cpusUsed: 18,
            standardUnits: { throughput: 150, note: "本次观察吞吐" },
        },
        warmup: null,
        logs: [],
        statistic: { metric: "ru-arith-mean", repeats: 3, warmupRuns: 1, formula: "…" },
        warnings: [],
        logDir: "/repo/data/calibration/20260922-130000",
        loadAvgAtStart: [3, 3, 3],
        loadAvgAtEnd: [3, 3, 3],
        appliedToCu: false,
        ...overrides,
    };
}

describe("calibrationRef：摘要指向可打开的那份文件", () => {
    it("file 是 <logDir>/calibration.json（不是目录）", async () => {
        const { calibrationRef } = await import("./calibrate");
        const ref = calibrationRef(fakeCalibration({ logDir: "/repo/data/calibration/20260922-130000" }));
        expect(ref.file).toBe("/repo/data/calibration/20260922-130000/calibration.json");
    });

    it("摘要带单线程 CV 与整机实测吞吐（页面要显示的两个数）", async () => {
        const { calibrationRef } = await import("./calibrate");
        const ref = calibrationRef(fakeCalibration());
        expect(ref.singleThreadCvPercent).toBeGreaterThanOrEqual(0);
        expect(ref.machine.threads).toBe(18);
        expect(ref.machine.standardUnitsThroughput).toBeCloseTo(150, 6);
    });
});

describe("CLI 的输出目录选择：绝不覆盖已有校准", () => {
    /** 每个用例一个临时目录（用完删）。 */
    const tempDir = (): string => {
        const dir = mkdtempSync(join(tmpdir(), "llm-mock-calibrate-test-"));
        tempDirs.push(dir);
        return dir;
    };

    it("显式 --out-dir 非空就拒绝", async () => {
        const { pickOutDir } = await import("./calibrate-cli");
        const dir = tempDir();
        writeFileSync(join(dir, "calibration.json"), "{}");
        expect(() => pickOutDir(dir, true)).toThrow(/非空/);
    });

    it("目录不存在或为空：建出来直接用；非空时默认目录往后挪一位", async () => {
        const { pickOutDir } = await import("./calibrate-cli");
        const dir = tempDir();
        // 不存在 → 建出来直接用
        expect(pickOutDir(join(dir, "fresh"), true)).toBe(join(dir, "fresh"));
        // 空的（刚建出来）也直接用：空的目录不算「已有校准」
        expect(pickOutDir(join(dir, "fresh"), false)).toBe(join(dir, "fresh"));
        // 非空 + 默认目录（时间戳语义）→ 挪到 -2，绝不覆盖
        writeFileSync(join(dir, "fresh", "calibration.json"), "{}");
        expect(pickOutDir(join(dir, "fresh"), false)).toBe(join(dir, "fresh-2"));
    });
});

describe("resolveSevenZipBinary：指错路径当场报错", () => {
    it("显式路径不存在 → 抛（不等到 spawn）", async () => {
        const { resolveSevenZipBinary } = await import("./calibrate");
        expect(() => resolveSevenZipBinary("/definitely/not/here/7zz")).toThrow(/找不到 7-Zip 二进制/);
    });

    it("本机装了 7zz 就解析得到（没装则跳过）", async () => {
        const { resolveSevenZipBinary, SEVEN_ZIP_FALLBACK_PATH } = await import("./calibrate");
        const onPath = Bun.which("7zz");
        if (onPath === null && !existsSync(SEVEN_ZIP_FALLBACK_PATH)) return;
        expect(existsSync(resolveSevenZipBinary())).toBe(true);
    });
});

/**
 * 真机输出的**逐字节**回归：下面两段是 2026-09-22 本机 7-Zip 26.01 的真实输出片段
 * （单线程与 `-mmt18` 各一段，取自 data/calibration/20260922-122031/*.log，只删了无关行业）。
 * 解析器的每一条假设都在这里被钉住：`25:` 一行、`|` 两侧各四列、`Tot:` 只有三列。
 */
describe("真机输出片段（回归）", () => {
    const singleThreadReal = [
        "7-Zip (z) 26.01 (arm64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-04-27",
        " 64-bit arm_v:8.5-A locale=C.UTF-8 Threads:18 OPEN_MAX:1048576, ASM",
        "",
        " mt1 d25",
        "Apple M5 Pro 18C18T",
        "",
        "1T CPU Freq (MHz):  4257  4285  4457  4478  4438  4502  4281",
        "",
        "RAM size:   49152 MB,  # CPU hardware threads:  18",
        "RAM usage:    437 MB,  # Benchmark threads:      1",
        "",
        "                       Compressing  |                  Decompressing",
        "Dict     Speed Usage    R/U Rating  |      Speed Usage    R/U Rating",
        "         KiB/s     %   MIPS   MIPS  |      KiB/s     %   MIPS   MIPS",
        "",
        "24:       7133   100   8167   8145  |     118953    99  10665  10588",
        "25:       7133   100   8167   8145  |     118953    99  10665  10588",
        "----------------------------------  | ------------------------------",
        "Avr:      8849   100   9244   9214  |     124165   100  10850  10821",
        "Tot:             100  10047  10017",
        "",
    ].join("\n");

    const wholeMachineReal = [
        "7-Zip (z) 26.01 (arm64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-04-27",
        "",
        " mt18 d25",
        "",
        "RAM size:   49152 MB,  # CPU hardware threads:  18",
        "RAM usage:   4004 MB,  # Benchmark threads:     18",
        "",
        "                       Compressing  |                  Decompressing",
        "Dict     Speed Usage    R/U Rating  |      Speed Usage    R/U Rating",
        "         KiB/s     %   MIPS   MIPS  |      KiB/s     %   MIPS   MIPS",
        "",
        "25:     138506  1538  10280 158141  |    1554306  1528   9050 138289",
        "----------------------------------  | ------------------------------",
        "Avr:    147147  1518  10179 154435  |    1702643  1569   9437 148194",
        "Tot:            1543   9808 151315",
        "",
    ].join("\n");

    it("单线程：25: 行 + 三列 Tot 行都认得", () => {
        const parsed = parseBenchmarkOutput(singleThreadReal);
        expect(parsed.version).toBe(SEVEN_ZIP_VERSION);
        expect(parsed.compress).toEqual({ speed: 7133, usage: 100, ru: 8167, rating: 8145 });
        expect(parsed.decompress).toEqual({ speed: 118953, usage: 99, ru: 10665, rating: 10588 });
        expect(parseTotalsLine(singleThreadReal)).toEqual({ usage: 100, ru: 10047, rating: 10017 });
    });

    it("整机 -mmt18：usage 超过 100% 是正常的，Rating 仍是两半的算术平均", () => {
        const parsed = parseBenchmarkOutput(wholeMachineReal);
        expect(parsed.compress).toEqual({ speed: 138506, usage: 1538, ru: 10280, rating: 158141 });
        expect(parsed.decompress).toEqual({
            speed: 1554306,
            usage: 1528,
            ru: 9050,
            rating: 138289,
        });
        // 平均 ≈ 148215（求和会得到 296430，整机吞吐直接虚高一倍）
        expect(parsed.machine.rating).toBeCloseTo((158141 + 138289) / 2, 9);
        expect(parseTotalsLine(wholeMachineReal)).toEqual({
            usage: 1543,
            ru: 9808,
            rating: 151315,
        });
    });

    it("把真机片段喂给统计：Rating 的均值也是「两半平均」，不是两列相加", () => {
        const parsed = parseBenchmarkOutput(wholeMachineReal);
        const combined = combineHalves(parsed.compress, parsed.decompress);
        const stats = statsOf([combined.rating]);
        // 折算用的原始值（scale 分子）走的是同一口径：单线程 R/U 的算术平均
        expect(cpuScaleOf(statsOf([parsed.machine.ru]).mean)).toBeCloseTo(
            (10280 + 9050) / 2 / BASELINE_MIPS_PER_CPU_SECOND,
            12,
        );
    });
});
