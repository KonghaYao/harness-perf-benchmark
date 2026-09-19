/**
 * 统一计分：把 CPU 与内存混成一个标量，且**系数不是我们拍的**。
 *
 * ## 状态：Beta（2026-09-19 起试行）
 *
 * 实现是稳的（逐拍积分、后代 CPU 取大、尾部补齐都有验证），但**这套口径本身还没定稿**：
 * 「后代 CPU 算不算 harness 的开销」「时长按端到端还是按可控执行时长」都还在讨论。
 * 所以它是个**候选口径**，用来把「整段资源成本」摊开对比，不是对 harness 的裁决。
 * 改口径 = 换指标，先在下游文档里写明、重跑一个完整批次。
 *
 * ## 口径来源：阿里云函数计算的 CU（Compute Unit）
 *
 * FC 把所有资源使用量按转换系数折成同一个单位再加总：
 *
 *     CU使用量 = ∑(资源使用量 × CU转换系数)
 *
 * 弹性实例（活跃）的 CPU 业务系数（2026-09-19 核对，
 * https://help.aliyun.com/zh/functioncompute/billing-overview-of-fc）：
 *
 *     vCPU 使用量     1.0  CU/(vCPU·秒)
 *     内存使用量      0.15 CU/(GB·秒)
 *     函数调用次数    75   CU/万次（= 0.0075 CU/次）
 *     磁盘使用量      0.05 CU/(GB·秒)
 *
 * 它的计费口径是「规格 × 时长」，恰好对应我们关心的问题：同一份剧本跑完，谁的资源成本高。
 *
 * ## 映射到本项目的采样数据
 *
 *     核·秒 = ∫(cpu_pct/100) dt     —— FC 的 vCPU·秒；采样本来就是「单核 100%」口径，天然同义
 *     GB·秒 = ∫(rss_kb/2^20) dt     —— FC 的内存使用量
 *     CU    = 1.0 × 核·秒 + 0.15 × GB·秒
 *
 * 这里的 `∫` 是**逐拍累加**：每拍按实测间隔差分（`Σ(资源率 × 该拍间隔)`），不是「均值 × 时长」——
 * 间隔不齐（调度抖动、最后半拍）时前者才是真值。
 *
 * ## 与 FC 的四处刻意偏差（都在 docs/perf-compare.md 里写明）
 *
 * 1. **内存用实测 RSS**，不是 FC 的「申报规格 × 时长」——我们只有实测值，实测也更公平；
 * 2. **不含磁盘项**（无数据）与 **GPU 项**（本项目不采 GPU）；
 * 3. **调用次数项单列**（`callCu`），不计入总分——请求数由剧本决定，不是 harness 的开销；
 * 4. 时长是**自然结束的端到端时长**，不是 FC 的可控执行时长。
 *
 * ## 后代 CPU 取哪一路（重要）
 *
 * harness 每轮工具调用拉起的 shell 只活几十毫秒，靠「每隔 2s 刷一次进程表」基本抓不到；
 * 而这些 shell 都是被 harness **回收**的，其 CPU 会进父进程 rusage 的 ri_child_* 计数器。
 * 两条路都是真值的下界，且可能重叠（被看见过的子进程之后被回收，同一段 CPU 会在计数器里
 * 再出现一次），所以**取两者较大者，不求和**。
 */

import type { ProcessSample } from "./sampler";

/**
 * 阿里云 FC 弹性实例（活跃）的 CU 转换系数。**改这三个数等于换了一套计分口径**，
 * 不要为了「让排名好看」微调它们。
 */
export const CU_COEFFICIENTS = {
    /** CU/(vCPU·秒)：核·秒与 CU 是 1:1。 */
    vCpuSecond: 1.0,
    /** CU/(GB·秒)：1 GB 常驻 1 秒 = 0.15 CU，即 FC 眼里 1 核 ≈ 6.67 GB。 */
    gbSecond: 0.15,
    /** CU/次：只用于单列 `callCu`，不进总分。 */
    callPerRequest: 0.0075,
} as const;

/** 尾部补齐的默认上限：采样循环停在进程消失前最后一拍，正常空档 ≈ 一个采样间隔。 */
export const DEFAULT_MAX_TAIL_MS = 500;

export interface CostOptions {
    /** 统计范围：`tree`（根进程 + 后代，默认）还是 `root`（只看主进程）。 */
    scope?: "tree" | "root";
    /** 末次采样到进程退出之间的空档（毫秒），按末尾若干拍的速率补齐。 */
    tailMs?: number;
    /** 补齐速率取末尾几拍的均值（默认 3）。 */
    tailWindow?: number;
    /** 空档上限：超过就截断，免得被强杀/异常退出时把外推放大（默认 500ms）。 */
    maxTailMs?: number;
    /** 请求数：只用来算单列的 `callCu`。 */
    requests?: number | null;
    /**
     * 首拍之前那一拍的 elapsedMs —— 它决定首拍的 dt。
     * 整段计价时是 0；按段计价时传上一段末拍的时刻，否则首拍的 dt 会被算成「从 0 到它」。
     */
    originMs?: number;
}

export interface ResourceCost {
    /** 核·秒（scope=tree 时含后代）。 */
    cpuSeconds: number;
    /** GB·秒（常驻内存 × 时长）。 */
    gbSeconds: number;
    /** 总分：`cpuCu + memoryCu`。 */
    cu: number;
    cpuCu: number;
    memoryCu: number;
    /** 调用次数折算的 CU——**不计入 `cu`**，只作参考。 */
    callCu: number;
    /** 主进程自身的核·秒。 */
    rootCpuSeconds: number;
    /** 后代核·秒（= max(采样到的, 已回收计数器)）。 */
    childCpuSeconds: number;
    /** 采样窗口内可见后代的核·秒（进程表抓到的）。 */
    childSampledSeconds: number;
    /** 已回收子进程计数器的核·秒（需要采样数据带 child_cpu_pct 列，老产物恒为 0）。 */
    childCounterSeconds: number;
    /** 后代 CPU 最终取自哪一路——`counter` 说明短命子进程是主要来源。 */
    childCpuFrom: "counter" | "sampled";
    /** 采样窗口时长（毫秒，末次采样时刻）。 */
    samplingMs: number;
    /** 实际用于补齐的尾部时长（毫秒，已按 maxTailMs 截断）。 */
    tailAppliedMs: number;
    /** 采样点数量。 */
    sampleCount: number;
}

/** 相邻采样点的实测间隔（秒）；首拍的 dt 从 `originMs` 算到它的 elapsed。 */
function intervalsSeconds(samples: readonly ProcessSample[], originMs: number): number[] {
    const out: number[] = [];
    let previous = originMs;
    for (const sample of samples) {
        out.push(Math.max(0, (sample.elapsedMs - previous) / 1000));
        previous = sample.elapsedMs;
    }
    return out;
}

/**
 * 采样序列 → 资源成本（核心公式）。
 *
 * 空样本集返回全 0（调用方负责判断「这次运行没采到样」，不要在这里抛）。
 */
export function resourceCost(
    samples: readonly ProcessSample[],
    options: CostOptions = {},
): ResourceCost {
    const scope = options.scope ?? "tree";
    const tailWindow = Math.max(1, options.tailWindow ?? 3);
    const maxTailMs = Math.max(0, options.maxTailMs ?? DEFAULT_MAX_TAIL_MS);
    const tailMs = Math.min(Math.max(0, options.tailMs ?? 0), maxTailMs);

    const empty: ResourceCost = {
        cpuSeconds: 0,
        gbSeconds: 0,
        cu: 0,
        cpuCu: 0,
        memoryCu: 0,
        callCu: (options.requests ?? 0) * CU_COEFFICIENTS.callPerRequest,
        rootCpuSeconds: 0,
        childCpuSeconds: 0,
        childSampledSeconds: 0,
        childCounterSeconds: 0,
        childCpuFrom: "sampled",
        samplingMs: 0,
        tailAppliedMs: 0,
        sampleCount: 0,
    };
    if (samples.length === 0) return empty;

    const deltas = intervalsSeconds(samples, options.originMs ?? 0);
    let rootCpuSeconds = 0;
    let childSampledSeconds = 0;
    let childCounterSeconds = 0;
    let gbSeconds = 0;

    samples.forEach((sample, index) => {
        const dt = deltas[index] as number;
        rootCpuSeconds += (sample.cpuPercent / 100) * dt;
        if (scope === "tree") {
            // tree 列含根进程，所以要减掉根进程自身才是「后代」。
            childSampledSeconds += Math.max(0, sample.treeCpuPercent - sample.cpuPercent) / 100 * dt;
            childCounterSeconds += (sample.childCpuPercent / 100) * dt;
            gbSeconds += (sample.treeRssBytes / 2 ** 30) * dt;
        } else {
            gbSeconds += (sample.rssBytes / 2 ** 30) * dt;
        }
    });

    // 尾部补齐：采样循环在进程消失的那一刻停，最后一拍与退出之间还有约一个采样间隔的账没记。
    // 实测（2026-09-19）这段空档固定 ≈100ms，对 pi 这种 1.5s 的快 harness 相当于漏计 ~7% CPU。
    let tailAppliedMs = 0;
    if (tailMs > 0) {
        const tail = samples.slice(-tailWindow);
        const rate = (pick: (sample: ProcessSample) => number) =>
            tail.reduce((total, sample) => total + pick(sample), 0) / tail.length;
        const [rootRate, sampledRate, counterRate, rssRate] = [
            rate((sample) => sample.cpuPercent),
            rate((sample) => Math.max(0, sample.treeCpuPercent - sample.cpuPercent)),
            rate((sample) => sample.childCpuPercent),
            rate((sample) => (scope === "tree" ? sample.treeRssBytes : sample.rssBytes)),
        ];
        const seconds = tailMs / 1000;
        rootCpuSeconds += (rootRate / 100) * seconds;
        if (scope === "tree") {
            childSampledSeconds += (sampledRate / 100) * seconds;
            childCounterSeconds += (counterRate / 100) * seconds;
        }
        gbSeconds += (rssRate / 2 ** 30) * seconds;
        tailAppliedMs = tailMs;
    }

    // 两个后代口径都是下界、且可能重叠 → 取大者，不求和。
    const childCpuSeconds =
        scope === "tree" ? Math.max(childSampledSeconds, childCounterSeconds) : 0;
    const cpuSeconds = rootCpuSeconds + childCpuSeconds;
    const cpuCu = CU_COEFFICIENTS.vCpuSecond * cpuSeconds;
    const memoryCu = CU_COEFFICIENTS.gbSecond * gbSeconds;

    return {
        ...empty,
        cpuSeconds,
        gbSeconds,
        cu: cpuCu + memoryCu,
        cpuCu,
        memoryCu,
        rootCpuSeconds,
        childCpuSeconds,
        childSampledSeconds,
        childCounterSeconds,
        childCpuFrom: childCounterSeconds > childSampledSeconds ? "counter" : "sampled",
        samplingMs: (samples[samples.length - 1] as ProcessSample).elapsedMs,
        tailAppliedMs,
        sampleCount: samples.length,
    };
}

/** 三段成本：启动 → 首个请求、首个请求 → 末次请求、末次请求 → 结束。 */
export interface SegmentCosts {
    startup: ResourceCost;
    span: ResourceCost;
    tail: ResourceCost;
}

/**
 * 按「首个 / 末次请求」把采样切成三段各自计价。
 *
 * 为什么值钱：peri / Codex 的所谓启动开销几乎全是**收尾等待**（peri 固定等 ~5s、Codex 等
 * dns 超时 ~10s），那段时间 CPU 接近于零但内存照样按 GB·秒 计费，拆开才看得见。
 *
 * 「三段之和 ≠ `resourceCost` 的总分」是**故意的**，差额只有一笔：尾部外推只在总成本那一份里
 * 算（六家实测「三段之和 + 尾部补齐 = 总分」逐笔成立）。后代 CPU 的「取较大者」同样只在整段上
 * 取一次——逐段各取一次看着更紧，却会把被采样看到的子进程 CPU 在它被回收的那一段里再算一遍。
 */
export function segmentCosts(
    samples: readonly ProcessSample[],
    marks: { first: number; last: number },
    options: CostOptions = {},
): SegmentCosts {
    const inRange = (from: number, to: number) =>
        samples.filter((sample) => sample.elapsedMs > from && sample.elapsedMs <= to);
    const startupSamples = inRange(Number.NEGATIVE_INFINITY, marks.first);
    const spanSamples = inRange(marks.first, marks.last);
    const tailSamples = inRange(marks.last, Number.POSITIVE_INFINITY);
    const sampleAt = (list: readonly ProcessSample[], fallback: number) =>
        list.length > 0 ? (list[list.length - 1] as ProcessSample).elapsedMs : fallback;

    // 每段的首拍 dt 要接在上一段末拍之后，否则首拍会被算成「从 0 到它」。
    const startupEnd = sampleAt(startupSamples, 0);
    const spanEnd = sampleAt(spanSamples, startupEnd);
    // 分段核算不做尾部外推：它是整个窗口的性质，塞进某一段会重复计（总成本那一份里才有）。
    const base = { ...options, tailMs: 0 };
    return {
        startup: resourceCost(startupSamples, { ...base, originMs: options.originMs ?? 0 }),
        span: resourceCost(spanSamples, { ...base, originMs: startupEnd }),
        tail: resourceCost(tailSamples, { ...base, originMs: spanEnd }),
    };
}

/** 一条待计分的记录：只要 id 与 CU。 */
export interface ScoredInput {
    id: string;
    cu: number;
}

/**
 * 相对分：`100 × 本批次最小 CU / 本次 CU`——最优 100 分，越贵越低。
 *
 * 只在**同一批次内**可比：系数是绝对的，但机器状态、后台负载、剧本都跟着批次走。
 * cu ≤ 0 的记录记 0 分（没采到样，不该因此得满分）。
 */
export function relativeScores(entries: readonly ScoredInput[]): Map<string, number> {
    const scores = new Map<string, number>();
    const positive = entries.filter((entry) => entry.cu > 0);
    if (positive.length === 0) {
        for (const entry of entries) scores.set(entry.id, 0);
        return scores;
    }
    const best = Math.min(...positive.map((entry) => entry.cu));
    for (const entry of entries) {
        scores.set(entry.id, entry.cu > 0 ? (100 * best) / entry.cu : 0);
    }
    return scores;
}
