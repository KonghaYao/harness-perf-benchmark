import { describe, expect, it } from "bun:test";
import type { ProcessSample } from "./sampler";
import {
    CU2_FORMULA,
    CU_COEFFICIENTS,
    cu2Score,
    resourceCost,
    resourcePeaks,
    segmentCosts,
    type Cu2Input,
} from "./score";

/**
 * 造一个采样点：elapsed 递增，cpu/tree/child 都是百分数，rss 用 MB。
 * 默认 tree = cpu（没有可见后代）、child = 0（没有已回收子进程）。
 */
function at(
    elapsedMs: number,
    fields: {
        cpu?: number;
        tree?: number;
        child?: number;
        rssMb?: number;
        treeRssMb?: number;
        procs?: number;
    } = {},
): ProcessSample {
    const cpu = fields.cpu ?? 0;
    return {
        ts: 1_700_000_000_000 + elapsedMs,
        elapsedMs,
        cpuPercent: cpu,
        rssBytes: (fields.rssMb ?? 100) * 1024 * 1024,
        treeCpuPercent: fields.tree ?? cpu,
        treeRssBytes: (fields.treeRssMb ?? fields.rssMb ?? 100) * 1024 * 1024,
        procs: fields.procs ?? 1,
        childCpuPercent: fields.child ?? 0,
    };
}

describe("resourceCost：解析解对拍", () => {
    it("单核满转 2 秒 = 2 核·秒 + 内存项（系数 1.0 / 1.0，CPU 与内存 1:1）", () => {
        // 10 拍 × 200ms，每拍 100%（= 满转一个核）
        const samples = [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800].map((ms) =>
            at(ms, { cpu: 100, rssMb: 1024 }),
        );
        const cost = resourceCost(samples, { scope: "root" });
        // 首拍 dt = 0（originMs=0 → 0 秒），其余 9 拍 × 0.2s = 1.8s
        expect(cost.samplingMs).toBe(1800);
        expect(cost.cpuSeconds).toBeCloseTo(1.8, 6);
        // 内存：1GB × 1.8s = 1.8 GB·秒
        expect(cost.gbSeconds).toBeCloseTo(1.8, 6);
        expect(cost.cu).toBeCloseTo(1.8 + 1.8, 6);
    });

    it("多线程超 100% 照加（400% = 4 个核在转）", () => {
        const cost = resourceCost([at(0, { cpu: 400 }), at(1000, { cpu: 400 })], {
            scope: "root",
        });
        expect(cost.cpuSeconds).toBeCloseTo(4, 6);
    });

    it("内存按 GB·秒 累积：500MB 常驻 10 秒", () => {
        const samples = [0, 5000, 10000].map((ms) => at(ms, { rssMb: 512 }));
        const cost = resourceCost(samples, { scope: "root" });
        // 首拍 dt=0，后两拍各 5s → 512MB × 10s = 5 GB·秒（512*10/1024）
        expect(cost.gbSeconds).toBeCloseTo((512 * 10) / 1024, 6);
        expect(cost.memoryCu).toBeCloseTo((512 * 10) / 1024, 6);
        expect(cost.cpuCu).toBe(0);
    });

    it("后代 CPU 取「采样到的」与「已回收计数器」的较大者，不求和", () => {
        // 采样看到 50% 的后代，计数器报了 80% —— 重叠，取 80%
        const samples = [
            at(0, { cpu: 10, tree: 60, child: 0 }),
            at(1000, { cpu: 10, tree: 60, child: 800 }),
        ];
        const cost = resourceCost(samples);
        expect(cost.childSampledSeconds).toBeCloseTo(0.5, 6);
        expect(cost.childCounterSeconds).toBeCloseTo(8, 6);
        expect(cost.childCpuSeconds).toBeCloseTo(8, 6);
        expect(cost.childCpuFrom).toBe("counter");
        expect(cost.cpuSeconds).toBeCloseTo(0.1 + 8, 6);
    });

    it("采样到的后代更多时就用采样那一路", () => {
        const samples = [at(0, { cpu: 0, tree: 0, child: 0 }), at(1000, { cpu: 0, tree: 500, child: 10 })];
        const cost = resourceCost(samples);
        expect(cost.childCpuFrom).toBe("sampled");
        expect(cost.childCpuSeconds).toBeCloseTo(5, 6);
    });

    it("scope=root 时后代一概不计", () => {
        const samples = [at(0, { cpu: 100, tree: 900, child: 900 }), at(1000, { cpu: 100, tree: 900, child: 900 })];
        const cost = resourceCost(samples, { scope: "root" });
        expect(cost.cpuSeconds).toBeCloseTo(1, 6);
        expect(cost.childCpuSeconds).toBe(0);
    });

    it("尾部补齐：末拍之后按末尾几拍的速率补上（pi 那类快 harness 的漏计）", () => {
        const samples = [
            at(0, { cpu: 100 }),
            at(100, { cpu: 100 }),
            at(200, { cpu: 100 }),
            at(300, { cpu: 100 }),
        ];
        // 不做补齐
        expect(resourceCost(samples, { scope: "root" }).cpuSeconds).toBeCloseTo(0.3, 6);
        // 补 100ms（末尾 3 拍速率 = 100%）→ +0.1 核·秒
        const patched = resourceCost(samples, { scope: "root", tailMs: 100 });
        expect(patched.cpuSeconds).toBeCloseTo(0.4, 6);
        expect(patched.tailAppliedMs).toBe(100);
    });

    it("尾部空档超过上限时截断（被强杀/异常退出不该被外推放大）", () => {
        const cost = resourceCost([at(0, { cpu: 100 }), at(100, { cpu: 100 })], {
            scope: "root",
            tailMs: 60_000,
        });
        expect(cost.tailAppliedMs).toBe(500);
    });

    it("空样本集返回全 0，不产生 NaN", () => {
        const cost = resourceCost([]);
        expect(cost.cu).toBe(0);
        expect(Number.isNaN(cost.cu)).toBe(false);
        expect(cost.sampleCount).toBe(0);
    });

    it("口径是 CPU 与内存 1:1：1 核·秒 与 1 GB·秒 同价", () => {
        expect(CU_COEFFICIENTS.vCpuSecond).toBe(1);
        expect(CU_COEFFICIENTS.gbSecond).toBe(1);
        // 1s 满核 + 1s 1GB 常驻 = 2 CU（若按 FC 的 0.15 只有 1.15）
        const samples = [at(0, { cpu: 100, rssMb: 1024 }), at(1000, { cpu: 100, rssMb: 1024 })];
        const cost = resourceCost(samples, { scope: "root" });
        expect(cost.cpuSeconds).toBeCloseTo(1, 6);
        expect(cost.gbSeconds).toBeCloseTo(1, 6);
        expect(cost.cu).toBeCloseTo(2, 6);
    });

    it("空档里的 CPU 为 0 时只补内存（peri 的收尾等待正是这样）", () => {
        const samples = [at(0, { cpu: 0, rssMb: 1024 }), at(1000, { cpu: 0, rssMb: 1024 })];
        const cost = resourceCost(samples, { scope: "root", tailMs: 500 });
        expect(cost.cpuSeconds).toBe(0);
        expect(cost.gbSeconds).toBeCloseTo(1.5, 6); // 1GB × 1.5s
    });
});

describe("segmentCosts：启动 / 运转 / 收尾", () => {
    const samples = [
        at(0, { cpu: 100, rssMb: 1024 }),
        at(1000, { cpu: 100, rssMb: 1024 }), // 启动段结束
        at(2000, { cpu: 100, rssMb: 1024 }),
        at(3000, { cpu: 100, rssMb: 1024 }), // 运转段结束（末次请求）
        at(4000, { cpu: 0, rssMb: 1024 }),
        at(5000, { cpu: 0, rssMb: 1024 }),
    ];

    it("三段之和等于整段（不做尾部外推）", () => {
        const marks = { first: 1000, last: 3000 };
        const parts = segmentCosts(samples, marks, { scope: "root" });
        const whole = resourceCost(samples, { scope: "root" });
        const sum = parts.startup.cu + parts.span.cu + parts.tail.cu;
        expect(sum).toBeCloseTo(whole.cu, 6);
    });

    it("收尾段零请求也能烧内存：peri / Codex 的固定成本", () => {
        const parts = segmentCosts(samples, { first: 1000, last: 3000 }, { scope: "root" });
        expect(parts.tail.cpuSeconds).toBe(0);
        expect(parts.tail.gbSeconds).toBeCloseTo(2, 6); // 1GB × 2s
        expect(parts.startup.cpuSeconds).toBeCloseTo(1, 6);
        expect(parts.span.cpuSeconds).toBeCloseTo(2, 6);
    });

    it("段内首拍不会把 dt 算成「从 0 开始」", () => {
        const parts = segmentCosts(samples, { first: 1000, last: 3000 }, { scope: "root" });
        // 运转段两拍各 1s；若首拍按绝对 elapsed 算会变成 2s（+100%）
        expect(parts.span.cpuSeconds).toBeCloseTo(2, 6);
    });
});

describe("resourcePeaks：峰值（压力口径）", () => {
    it("取整个窗口的最大值，并记下峰值在哪一拍、当时几个进程", () => {
        const samples = [
            at(0, { cpu: 10, rssMb: 100, procs: 1 }),
            at(1000, { cpu: 90, rssMb: 300, procs: 3 }),
            at(2000, { cpu: 20, rssMb: 200, procs: 1 }),
        ];
        const peaks = resourcePeaks(samples);
        expect(peaks.treeRssBytes).toBe(300 * 1024 * 1024);
        expect(peaks.treeRssAtMs).toBe(1000);
        expect(peaks.treeRssProcs).toBe(3);
        expect(peaks.treeCpuPercent).toBe(90);
        expect(peaks.sampleCount).toBe(3);
    });

    it("峰值不是面积：末拍才涨上去也一样取到", () => {
        const samples = [at(0, { rssMb: 50 }), at(1000, { rssMb: 50 }), at(2000, { rssMb: 500, cpu: 130 })];
        const peaks = resourcePeaks(samples);
        expect(peaks.treeRssBytes).toBe(500 * 1024 * 1024);
        expect(peaks.treeRssAtMs).toBe(2000);
        // CPU peak 可以 >100%（多线程）
        expect(peaks.treeCpuPercent).toBe(130);
    });

    it("空样本集返回全 0", () => {
        expect(resourcePeaks([])).toMatchObject({ treeRssBytes: 0, treeCpuPercent: 0, sampleCount: 0 });
    });
});

describe("cu2Score：固定预算下的绝对分", () => {
    /** 一份「刚好压线」的输入：10s、满核、1GiB 常驻、峰值 1GiB → 四项负担都是 1.0。 */
    const input = (seconds = 10, cpu = 100, rssMb = 1024, treeRssMb?: number): Cu2Input => ({
        status: "ok",
        endToEndMs: seconds * 1000,
        harnessExitedAtMs: 1_700_000_000_000 + seconds * 1000,
        withTree: true,
        childColumnPresent: true,
        samplingBackend: "rusage",
        requests: 100,
        samples: [at(0, { cpu, rssMb, treeRssMb }), at(seconds * 1000, { cpu, rssMb, treeRssMb })],
    });

    it("固定预算边界：50 分 = 恰好压在预算上，四项各自都能单独决定分数", () => {
        expect(CU2_FORMULA.budgets).toEqual({
            timeSeconds: 10,
            cpuSeconds: 10,
            memoryGiBSeconds: 10,
            peakGiB: 1,
        });
        expect(CU2_FORMULA.budgetScore).toBe(50);
        expect(cu2Score(input())).toMatchObject({ score: 50, burden: 1, valid: true });

        // 单项压线、其余给足余量 → 仍是 50 分：
        expect(cu2Score(input(10, 0, 100)).score).toBe(50); // 时长恰好压线
        expect(cu2Score(input(1, 0, 1000, 1024)).score).toBe(50); // 峰值恰好压线
        expect(cu2Score(input(1, 1000, 100)).score).toBe(50); // CPU 恰好压线（1s × 10 核）

        // 低于预算就高于 50 分，超了就低于 50 分，且是连续单调的
        expect(cu2Score(input(5, 100, 512)).score).toBeCloseTo(100 / 1.5, 6);
        expect(cu2Score(input(20, 100, 512)).score).toBeCloseTo(100 / 3, 6);
        expect(cu2Score(input(10, 200, 512)).score).toBeCloseTo(100 / 3, 6); // CPU 20 核·秒 = 2 倍预算
    });

    it("倍率不是乘子：RSS 从 1MB 涨到 100MB 与全程 100MB 同分（只看面积与峰值）", () => {
        // 每个采样点按「本拍到下一次采样的值 × dt」累加（右端点法）：涨上去的那一段
        // 记的是它当时的真实字节数，不是「涨了多少倍」。
        const grown: Cu2Input = {
            ...input(1, 0, 1),
            samples: [at(0, { cpu: 0, rssMb: 1 }), at(1000, { cpu: 0, rssMb: 100 })],
        };
        const flat: Cu2Input = {
            ...input(1, 0, 100),
            samples: [at(0, { cpu: 0, rssMb: 100 }), at(1000, { cpu: 0, rssMb: 100 })],
        };
        const result = cu2Score(grown);
        expect(result.metrics!.memoryGiBSeconds).toBeCloseTo(100 / 1024, 6); // 100MB × 1s
        expect(result.metrics!.peakGiB).toBeCloseTo(100 / 1024, 6);
        // 面积与峰值相同 → 分数相同：没有任何「增长倍率」参与折算
        expect(cu2Score(flat).metrics!.memoryGiBSeconds).toBeCloseTo(result.metrics!.memoryGiBSeconds, 9);
        expect(cu2Score(flat).score).toBe(result.score);
        expect(result.burden).toBeCloseTo(0.1, 9); // 四项里最大的是时长（1s / 10s）
        expect(result.score).toBeCloseTo(100 / 1.1, 6);
    });

    it("单调性：时长、CPU、内存、峰值任一变大，分数不升；并行按真实 CPU 积分而非墙钟倍乘", () => {
        const base = cu2Score(input(5, 100, 256));
        expect(cu2Score(input(10, 100, 256)).score!).toBeLessThanOrEqual(base.score!);
        expect(cu2Score(input(5, 400, 256)).score!).toBeLessThanOrEqual(base.score!);
        expect(cu2Score(input(5, 100, 2048)).score!).toBeLessThanOrEqual(base.score!);
        expect(cu2Score(input(5, 100, 256, 1024)).score!).toBeLessThanOrEqual(base.score!);

        // 串行 10s×1 核 与 并行 5s×2 核：核·秒相同 → 分数相同（不带任何并行倍率）
        const serial = cu2Score(input(10, 100, 100));
        const parallel = cu2Score(input(5, 200, 100));
        expect(parallel.metrics!.cpuSeconds).toBe(serial.metrics!.cpuSeconds);
        expect(parallel.score).toBe(serial.score);
        // 但真多烧了 CPU 就要掉分
        expect(cu2Score(input(5, 400, 100)).score!).toBeLessThan(parallel.score!);
    });

    it("无效、失败、缺关键时间或 child 列、无 tree、空样本与坏样本一律 null", () => {
        const patches: Partial<Cu2Input>[] = [
            { status: "timeout" },
            { status: null },
            { endToEndMs: null },
            { endToEndMs: 0 },
            { endToEndMs: Number.NaN },
            { harnessExitedAtMs: null },
            { childColumnPresent: false },
            { withTree: false },
            { withTree: null },
            { childColumnPresent: false, invalidReasons: ["invalid-csv-columns"] },
            { samplingBackend: "ps" },
            { invalidReasons: ["missing-csv"] },
            { samples: [] },
            { samples: [at(0)] }, // 只有 0ms 一拍：采样窗口为空
            { samples: [at(10, { cpu: -1 })] },
            { samples: [at(10, { rssMb: 0 })] },
            { samples: [at(10, { cpu: Number.POSITIVE_INFINITY })] },
            { samples: [at(100), at(50)] }, // 时间倒流
            { requests: 1 },
            { requests: null },
        ];
        for (const patch of patches) {
            const result = cu2Score({ ...input(), ...patch });
            expect(result).toMatchObject({ score: null, valid: false, burden: null });
            expect(result.invalidReasons.length).toBeGreaterThan(0);
        }
    });

    it("末拍 → 退出的空档超过上限时不可评分，不拿截断出来的下界出分", () => {
        // 末拍 1.0s、退出 2.0s：空档 1000ms > 500ms 上限 → 不评（截断到 500ms 出分会把失真读数当真相）
        const beyond = cu2Score({ ...input(1), endToEndMs: 2_000, harnessExitedAtMs: 1_700_000_002_000 });
        expect(beyond).toMatchObject({ score: null, valid: false, tailGapMs: 1_000 });
        expect(beyond.invalidReasons).toContain("tail-gap-exceeds-limit");
        expect(beyond.metrics).toBeNull();

        // 上限之内照评：空档照样补进面积里（1s 满核 + 0.5s 满核 = 1.5 核·秒）
        const filled = cu2Score({ ...input(1), harnessExitedAtMs: 1_700_000_001_500 });
        expect(filled.valid).toBe(true);
        expect(filled.tailGapMs).toBe(500);
        expect(filled.metrics!.cpuSeconds).toBeCloseTo(1.5, 6);
    });

    it("后代 CPU 沿用「两路取大」，GiB·秒按 2^30 积分，P 不含尾部外推；99 与 100 等同", () => {
        const withChild: Cu2Input = {
            ...input(1),
            samples: [
                at(0, { cpu: 10, tree: 60, child: 80, rssMb: 512 }),
                at(1000, { cpu: 10, tree: 60, child: 80, rssMb: 512 }),
            ],
        };
        const result = cu2Score(withChild);
        // 后代取 max(采样 0.5, 计数器 0.8) = 0.8；主进程 0.1 → 0.9 核·秒
        expect(result.metrics!.cpuSeconds).toBeCloseTo(0.9, 9);
        expect(result.metrics!.memoryGiBSeconds).toBeCloseTo(0.5, 9);
        expect(result.metrics!.peakGiB).toBeCloseTo(0.5, 9);

        // 99 轮按 100 轮算：不补算、也不因此扣分（换的就是同一份请求数）
        expect(cu2Score({ ...input(), requests: 99 })).toEqual(cu2Score(input()));
    });

    it("请求数只是保守下限：它含辅助请求，不是工具轮数，不能证明跑满 100 轮", () => {
        expect(CU2_FORMULA.limitations.join("\n")).toContain("不是工具轮数");
        // 明显不足的挡掉
        expect(cu2Score({ ...input(), requests: 12 }).invalidReasons).toContain(
            "insufficient-request-evidence",
        );
        // 过线的只说明「不像没跑起来」，没有任何字段声称它就是 100 轮
        const many = cu2Score({ ...input(), requests: 100_000 });
        expect(many.valid).toBe(true);
        expect(Object.keys(many)).not.toContain("toolTurns");
        expect(JSON.stringify(CU2_FORMULA)).not.toContain("turnsVerified");
    });
});
