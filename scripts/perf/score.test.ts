import { describe, expect, it } from "bun:test";
import type { ProcessSample } from "./sampler";
import {
    CU_COEFFICIENTS,
    relativeScores,
    resourceCost,
    segmentCosts,
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
        procs: 1,
        childCpuPercent: fields.child ?? 0,
    };
}

describe("resourceCost：解析解对拍", () => {
    it("单核满转 2 秒 = 2 核·秒 + 内存项（系数 1.0 / 0.15）", () => {
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
        expect(cost.cu).toBeCloseTo(1.8 + 0.15 * 1.8, 6);
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
        expect(cost.memoryCu).toBeCloseTo(0.15 * ((512 * 10) / 1024), 6);
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

    it("调用次数项单列，不计入总分", () => {
        const cost = resourceCost([at(0, { cpu: 100 }), at(1000, { cpu: 100 })], {
            scope: "root",
            requests: 101,
        });
        expect(cost.callCu).toBeCloseTo(101 * CU_COEFFICIENTS.callPerRequest, 6);
        expect(cost.cu).toBeCloseTo(cost.cpuCu + cost.memoryCu, 6);
        expect(cost.cu).toBeLessThan(cost.cu + cost.callCu);
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

describe("relativeScores：百分制", () => {
    it("最优 100 分，其余按 CU 倒数缩放", () => {
        const scores = relativeScores([
            { id: "a", cu: 1 },
            { id: "b", cu: 2 },
            { id: "c", cu: 4 },
        ]);
        expect(scores.get("a")).toBeCloseTo(100, 6);
        expect(scores.get("b")).toBeCloseTo(50, 6);
        expect(scores.get("c")).toBeCloseTo(25, 6);
    });

    it("CU 为 0（没采到样）记 0 分，不拿满分", () => {
        const scores = relativeScores([
            { id: "broken", cu: 0 },
            { id: "ok", cu: 2 },
        ]);
        expect(scores.get("broken")).toBe(0);
        expect(scores.get("ok")).toBe(100);
    });

    it("全部为 0 时全是 0 分，不产生 NaN", () => {
        const scores = relativeScores([{ id: "a", cu: 0 }]);
        expect(scores.get("a")).toBe(0);
    });
});
