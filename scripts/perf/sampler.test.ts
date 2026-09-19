import { describe, expect, it } from "bun:test";
import {
    CSV_HEADER,
    ProcessSampler,
    collectTree,
    cpuPercent,
    csvHasColumn,
    formatCsvRow,
    parsePsTimeToMs,
    parseSamplesCsv,
    summarize,
    ticksToNs,
    type CumulativeReading,
    type ProcessSample,
    type SamplerBackend,
} from "./sampler";

/** 本机实测时基：1 tick ≈ 41.67ns。 */
const TIMEBASE = { numer: 125, denom: 3 };

/** 可编排的假后端：每次 read 弹出下一个读数，便于确定性地验证差分逻辑。 */
function fakeBackend(
    script: Map<number, CumulativeReading[]>,
): SamplerBackend & { reads: number } {
    const backend = {
        kind: "rusage" as const,
        reads: 0,
        describe: () => "假后端",
        read(pid: number): CumulativeReading | null {
            backend.reads += 1;
            const queue = script.get(pid);
            if (queue === undefined || queue.length === 0) return null;
            return queue.shift() as CumulativeReading;
        },
    };
    return backend;
}

const MB = 1024 * 1024;

describe("差分换算", () => {
    it("Mach tick 按 timebase 换算成纳秒", () => {
        // 本机 24MHz 时基：1 秒对应 24e6 tick
        expect(ticksToNs(24_000_000, TIMEBASE)).toBeCloseTo(1e9, 0);
        // Intel 机器时基 1/1 时退化为恒等
        expect(ticksToNs(1e9, { numer: 1, denom: 1 })).toBe(1e9);
    });

    it("累计 CPU 时间差 → 瞬时 CPU%（单核 100%）", () => {
        // 100ms 窗口内跑了 100ms CPU = 满转一个核
        expect(cpuPercent(100e6, 100)).toBeCloseTo(100, 6);
        // 4 线程满转可以超过 100%
        expect(cpuPercent(400e6, 100)).toBeCloseTo(400, 6);
        // 空闲
        expect(cpuPercent(0, 100)).toBe(0);
        // 异常输入不产生 NaN / 负数
        expect(cpuPercent(50e6, 0)).toBe(0);
        expect(cpuPercent(-1, 100)).toBe(0);
    });

    it("解析 ps -o time= 的 [[HH:]MM:]SS[.cc]", () => {
        expect(parsePsTimeToMs("0:00.00")).toBe(0);
        expect(parsePsTimeToMs("0:12.34")).toBeCloseTo(12_340, 6);
        expect(parsePsTimeToMs("1:02.50")).toBeCloseTo(62_500, 6);
        expect(parsePsTimeToMs("2:03:04")).toBeCloseTo(7_384_000, 6);
        expect(parsePsTimeToMs("  ")).toBeNull();
        expect(parsePsTimeToMs("-")).toBeNull();
        expect(parsePsTimeToMs("abc")).toBeNull();
        expect(parsePsTimeToMs("1:2:3:4")).toBeNull();
    });

    it("按 pid/ppid 收集进程树", () => {
        const processes = [
            { pid: 1, ppid: 0 },
            { pid: 10, ppid: 1 },
            { pid: 11, ppid: 1 },
            { pid: 100, ppid: 10 },
            { pid: 101, ppid: 100 },
            { pid: 999, ppid: 10 },
        ];
        expect(collectTree(1, processes).sort((a, b) => a - b)).toEqual([1, 10, 11, 100, 101, 999]);
        expect(collectTree(10, processes).sort((a, b) => a - b)).toEqual([10, 100, 101, 999]);
        expect(collectTree(999, processes)).toEqual([999]);
        // 环状 ppid 不应死循环
        expect(collectTree(2, [{ pid: 2, ppid: 3 }, { pid: 3, ppid: 2 }]).sort()).toEqual([2, 3]);
    });
});

describe("ProcessSampler", () => {
    it("按实测间隔差分出 CPU%，并给出 RSS", () => {
        const backend = fakeBackend(
            new Map([
                [
                    42,
                    [
                        { cpuNs: 1_000e6, childCpuNs: 0, rssBytes: 10 * MB }, // 基线
                        { cpuNs: 1_050e6, childCpuNs: 0, rssBytes: 12 * MB }, // +50ms/100ms = 50%
                        { cpuNs: 1_150e6, childCpuNs: 0, rssBytes: 20 * MB }, // +100ms/100ms = 100%
                    ],
                ],
            ]),
        );
        const sampler = new ProcessSampler({ pid: 42, backend });
        expect(sampler.prime()).toBe(true);

        const first = sampler.sample({ elapsedMs: 100, deltaMs: 100 });
        expect(first).toMatchObject({
            elapsedMs: 100,
            cpuPercent: 50,
            rssBytes: 12 * MB,
            procs: 1,
        });
        const second = sampler.sample({ elapsedMs: 200, deltaMs: 100 });
        expect(second?.cpuPercent).toBeCloseTo(100, 6);
        expect(second?.rssBytes).toBe(20 * MB);
    });

    it("窗口外的间隔会按实测 deltaMs 归一化，而不是名义间隔", () => {
        const backend = fakeBackend(
            new Map([[
                42,
                [
                    { cpuNs: 0, childCpuNs: 0, rssBytes: MB },
                    { cpuNs: 50e6, childCpuNs: 0, rssBytes: MB },
                ],
            ]]),
        );
        const sampler = new ProcessSampler({ pid: 42, backend });
        sampler.prime();
        // 定时器被拖慢到 250ms，但只跑了 50ms CPU → 20%
        expect(sampler.sample({ elapsedMs: 250, deltaMs: 250 })?.cpuPercent).toBeCloseTo(20, 6);
    });

    it("进程树：合计后代 CPU/RSS，中途新出现的进程不产生虚高峰值", () => {
        const backend = fakeBackend(
            new Map([
                [
                    42,
                    [
                        { cpuNs: 0, childCpuNs: 0, rssBytes: 10 * MB },
                        { cpuNs: 100e6, childCpuNs: 0, rssBytes: 11 * MB },
                        { cpuNs: 200e6, childCpuNs: 0, rssBytes: 12 * MB },
                    ],
                ],
                // 子进程第二拍才出现：首次读到 900ms 的累计值，不应算成本拍增量
                [
                    43,
                    [
                        { cpuNs: 900e6, childCpuNs: 0, rssBytes: 30 * MB },
                        { cpuNs: 910e6, childCpuNs: 0, rssBytes: 31 * MB },
                    ],
                ],
            ]),
        );
        const sampler = new ProcessSampler({
            pid: 42,
            backend,
            withTree: true,
            // 固定进程表：43 是 42 的子进程
            listProcesses: () => [
                { pid: 42, ppid: 1 },
                { pid: 43, ppid: 42 },
            ],
        });
        sampler.prime();

        const first = sampler.sample({ elapsedMs: 100, deltaMs: 100 });
        expect(first?.procs).toBe(2);
        expect(first?.cpuPercent).toBeCloseTo(100, 6);
        expect(first?.treeCpuPercent).toBeCloseTo(100, 6); // 子进程首拍按 0 计
        expect(first?.rssBytes).toBe(11 * MB);
        expect(first?.treeRssBytes).toBe(41 * MB); // 11（根）+ 30（子）

        const second = sampler.sample({ elapsedMs: 200, deltaMs: 100 });
        expect(second?.treeCpuPercent).toBeCloseTo(110, 6); // 100 + 10ms
    });

    it("已回收子进程计数器：差分出 child_cpu_pct，且不掺进 tree_cpu_pct", () => {
        // 根进程自己一直在睡，CPU 全靠短命子进程 —— 正是进程表抓不到的那类。
        const backend = fakeBackend(
            new Map([
                [
                    42,
                    [
                        { cpuNs: 0, childCpuNs: 5e6, rssBytes: MB }, // prime 基线
                        { cpuNs: 0, childCpuNs: 25e6, rssBytes: MB }, // 子进程 +20ms → 20%
                        { cpuNs: 0, childCpuNs: 55e6, rssBytes: MB }, // 子进程 +30ms → 30%
                        { cpuNs: 0, childCpuNs: 55e6, rssBytes: MB }, // 没新增 → 0%
                    ],
                ],
            ]),
        );
        const sampler = new ProcessSampler({ pid: 42, backend, withTree: true });
        sampler.prime();
        expect(sampler.sample({ elapsedMs: 100, deltaMs: 100 })?.childCpuPercent).toBeCloseTo(20, 6);
        expect(sampler.sample({ elapsedMs: 200, deltaMs: 100 })?.childCpuPercent).toBeCloseTo(30, 6);
        const third = sampler.sample({ elapsedMs: 300, deltaMs: 100 });
        expect(third?.childCpuPercent).toBe(0);
        // 计数器是独立列：tree_cpu_pct 仍然只算「看得见的进程」，两者不能相加
        // （被看见过的子进程之后被回收，同一段 CPU 会在计数器里再出现一次）。
        expect(third?.treeCpuPercent).toBe(0);
    });

    it("--no-tree（withTree=false）时 child_cpu_pct 归零", () => {
        const backend = fakeBackend(
            new Map([
                [
                    42,
                    [
                        { cpuNs: 0, childCpuNs: 0, rssBytes: MB },
                        { cpuNs: 10e6, childCpuNs: 50e6, rssBytes: MB },
                    ],
                ],
            ]),
        );
        const sampler = new ProcessSampler({ pid: 42, backend });
        sampler.prime();
        const one = sampler.sample({ elapsedMs: 100, deltaMs: 100 });
        expect(one?.cpuPercent).toBeCloseTo(10, 6);
        expect(one?.childCpuPercent).toBe(0);
        expect(one?.treeCpuPercent).toBeCloseTo(10, 6);
    });

    it("根进程消失后返回 null（采样对象提前退出）", () => {
        const backend = fakeBackend(
            new Map([[
                42,
                [
                    { cpuNs: 0, childCpuNs: 0, rssBytes: MB },
                    { cpuNs: 10e6, childCpuNs: 0, rssBytes: MB },
                ],
            ]]),
        );
        const sampler = new ProcessSampler({ pid: 42, backend });
        sampler.prime();
        expect(sampler.sample({ elapsedMs: 100, deltaMs: 100 })).not.toBeNull();
        expect(sampler.sample({ elapsedMs: 200, deltaMs: 100 })).toBeNull();
    });

    it("基线建立失败（进程已不在）时 prime 返回 false", () => {
        const sampler = new ProcessSampler({ pid: 404, backend: fakeBackend(new Map()) });
        expect(sampler.prime()).toBe(false);
    });
});

describe("CSV 与摘要", () => {
    const sample = (elapsedMs: number, cpu: number, rss: number): ProcessSample => ({
        ts: 1_700_000_000_000 + elapsedMs,
        elapsedMs,
        cpuPercent: cpu,
        rssBytes: rss,
        treeCpuPercent: cpu + 1,
        treeRssBytes: rss + MB,
        procs: 2,
        childCpuPercent: 0,
    });

    it("CSV 表头与数据行列数一致、数值单位正确", () => {
        const row = formatCsvRow({
            ts: 0,
            elapsedMs: 100,
            cpuPercent: 42.126,
            rssBytes: 100 * MB,
            treeCpuPercent: 43.5,
            treeRssBytes: 150 * MB,
            procs: 2,
            childCpuPercent: 7.25,
        });
        const fields = row.split(",");
        expect(fields.length).toBe(CSV_HEADER.split(",").length);
        expect(fields[0]).toBe("1970-01-01T00:00:00.000Z");
        expect(fields.slice(1)).toEqual([
            "100",
            "42.13",
            "102400",
            "43.50",
            "153600",
            "2",
            "7.25",
        ]);
    });

    it("老产物缺 child_cpu_pct 列时按 0 读，不报错", () => {
        const legacy = [
            "ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs",
            "2026-09-19T06:28:50.542Z,100,24.77,42752,24.77,42752,1",
        ].join("\n");
        expect(csvHasColumn(legacy, "child_cpu_pct")).toBe(false);
        const [only] = parseSamplesCsv(legacy);
        expect(only?.childCpuPercent).toBe(0);
        expect(only?.cpuPercent).toBeCloseTo(24.77, 6);

        const current = `${legacy.split("\n")[0]},child_cpu_pct\n2026-09-19T06:28:50.542Z,100,24.77,42752,24.77,42752,1,3.5`;
        expect(csvHasColumn(current, "child_cpu_pct")).toBe(true);
        expect(parseSamplesCsv(current)[0]?.childCpuPercent).toBeCloseTo(3.5, 6);
    });

    it("缺必需列必须报错（宁可炸也不画出错的图）", () => {
        const broken = "ts,elapsed_ms,cpu_pct,rss_kb\nts,1,2,3";
        expect(() => parseSamplesCsv(broken)).toThrow(/缺必需列/);
    });

    it("摘要给出样本数、时长与均值/峰值", () => {
        const summary = summarize([sample(100, 10, 100 * MB), sample(200, 30, 300 * MB)]);
        expect(summary.count).toBe(2);
        expect(summary.durationMs).toBe(200);
        expect(summary.cpuMean).toBeCloseTo(20, 6);
        expect(summary.cpuMax).toBeCloseTo(30, 6);
        expect(summary.rssMeanBytes).toBe(200 * MB);
        expect(summary.rssMaxBytes).toBe(300 * MB);
        expect(summary.rssLastBytes).toBe(300 * MB);
        expect(summary.treeCpuMax).toBeCloseTo(31, 6);
    });

    it("空样本集不产生 NaN", () => {
        const summary = summarize([]);
        expect(summary.count).toBe(0);
        expect(summary.cpuMean).toBe(0);
        expect(summary.rssMaxBytes).toBe(0);
    });
});
