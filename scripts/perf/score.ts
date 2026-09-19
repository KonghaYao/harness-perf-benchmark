/**
 * 统一计分：把 CPU 与内存混成一个标量，回答「跑完同一部剧本，谁的整段资源成本更小」。
 *
 * ## 状态：Beta（2026-09-19 起试行）
 *
 * 实现是稳的（逐拍积分、后代 CPU 取大、尾部补齐都有验证），但**这套口径本身还没定稿**：
 * 「后代 CPU 算不算 harness 的开销」「时长按端到端还是按可控执行时长」都还在讨论。
 * 所以它是个**候选口径**，用来把「整段资源成本」摊开对比，不是对 harness 的裁决。
 * 改口径 = 换指标，先在下游文档里写明、重跑一个完整批次。
 *
 * ## 口径：CPU 与内存 1:1
 *
 *     CU    = 1.0 × 核·秒 + 1.0 × GB·秒
 *     核·秒 = ∫(cpu_pct/100) dt      GB·秒 = ∫(rss_kb/2^20) dt     ← 时间积分，含时长
 *     分数  = 100 × 本批次最小 CU / 本次 CU    （最优 100 分；只在同一批次内可比）
 *
 * 公式结构借自阿里云函数计算（FC）的「CU使用量 = ∑(资源使用量 × CU转换系数)」——它把 CPU、
 * 内存折成同一个单位再加总，正好对应我们要问的问题。FC 弹性实例（活跃）的系数表（2026-09-19
 * 核对官方计费页）是：vCPU 1.0 CU/(vCPU·秒)、内存 0.15 CU/(GB·秒)、调用次数 75 CU/万次、
 * 磁盘 0.05 CU/(GB·秒)。
 *
 * **系数是本项目自己定的：CPU 与内存逐秒同价（1 核·秒 = 1 GB·秒），不是 FC 的 0.15。**
 * FC 的 0.15 等于说「1 个核 ≈ 6.67 GB 内存」，那是云厂商的出价；照它算，内存项在总账里只占
 * 1%~8%，「谁更省内存」几乎不参与计分（实测把内存权重压到 0，名次几乎不动）。本项目问的是
 * **资源负担**，所以明说一次：单位时间内核与内存各算一份，谁也不比谁便宜。（行业参考：AWS
 * Lambda 新版 vCPU 价折算 ≈7.6、Cloud Run ≈9，都在 FC 那条线上——想按某家的价重算，改
 * `CU_COEFFICIENTS.gbSecond` 一个数即可，别在别处另写一套。）
 *
 * ## 压力口径（峰值）不折算
 *
 * 面积答「总共烧多少」，峰值答「最坏一刻要占多少」——机器的内存水位与规格是照峰值配的，
 * 两个问题都真实。峰值（`resourcePeaks`：MB、%）是**绝对量**，本来就能横比，再套一层批内
 * 相对分只会多一个「我们拍的」数字，所以它不计分，只与 CU 并列显示。
 *
 * ## 与 FC 的四处刻意偏差
 *
 * 1. **系数不是 FC 的 0.15**：本项目按「资源负担」读，CPU 与内存逐秒同价（理由见上）；
 * 2. **内存用实测 RSS**，不是 FC 的「申报规格 × 时长」——我们只有实测值，实测也更公平；
 * 3. **不含磁盘项**（无数据）与 **GPU 项**（本项目不采 GPU）；时长取**自然结束的端到端时长**，
 *    不是 FC 那种「可控执行时长」；
 * 4. **调用次数项一律不折算**：请求数由剧本决定，不是 harness 的开销。
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
 * CU 转换系数——**改这两个数等于换了一套计分口径**，不要为了「让排名好看」微调它们。
 *
 * 结构借自阿里云 FC，取值是本项目定的 **CPU 与内存 1:1**（理由见文件头）；FC 原表的内存项是
 * 0.15 CU/(GB·秒)。要按别的价重算就改这里一处，并在 docs/perf-compare.md 里写明。
 */
export const CU_COEFFICIENTS = {
    /** CU/(vCPU·秒)：核·秒与 CU 1:1。 */
    vCpuSecond: 1.0,
    /** CU/(GB·秒)：与 CPU 同价（1 核·秒 = 1 GB·秒）；FC 原表这里是 0.15。 */
    gbSecond: 1.0,
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

/**
 * 压力口径：整个窗口里的峰值（「最坏一刻」），与成本口径的面积互补。
 *
 * 为什么单独给一份而不是让读取端各自 `Math.max`：峰值也是**口径**——取进程树还是主进程、
 * 峰值那一拍要不要连进程数一起记下来（判「峰值是不是工具子进程顶出来的」），这些说法得和
 * 积分一样只有一处。它**不折算成分数**：MB 与 % 本来是绝对量、可直接横比。
 */
export interface ResourcePeaks {
    /** 进程树 RSS 峰值（字节）。 */
    treeRssBytes: number;
    /** 进程树 CPU 峰值（%，单核 100% 口径）。 */
    treeCpuPercent: number;
    /** 主进程 RSS 峰值（字节）。 */
    rootRssBytes: number;
    /** 主进程 CPU 峰值（%，单核 100% 口径）。 */
    rootCpuPercent: number;
    /** 进程树 RSS 峰值出现在第几毫秒（看它是运转中堆起来的还是收尾时定格的）。 */
    treeRssAtMs: number;
    /** 峰值那一拍的进程数（>1 说明当时有工具子进程在，峰值含它）。 */
    treeRssProcs: number;
    sampleCount: number;
}

/** 峰值口径的选项：只挑范围，别的都不参与（峰值与时长、尾部补齐都无关）。 */
export interface PeakOptions {
    /** 统计范围：`tree`（默认）还是 `root`。 */
    scope?: "tree" | "root";
}

/** 采样序列 → 峰值（空样本集返回全 0）。 */
export function resourcePeaks(
    samples: readonly ProcessSample[],
    options: PeakOptions = {},
): ResourcePeaks {
    const scope = options.scope ?? "tree";
    const peaks: ResourcePeaks = {
        treeRssBytes: 0,
        treeCpuPercent: 0,
        rootRssBytes: 0,
        rootCpuPercent: 0,
        treeRssAtMs: 0,
        treeRssProcs: 0,
        sampleCount: samples.length,
    };
    for (const sample of samples) {
        peaks.rootRssBytes = Math.max(peaks.rootRssBytes, sample.rssBytes);
        peaks.rootCpuPercent = Math.max(peaks.rootCpuPercent, sample.cpuPercent);
        if (scope !== "tree") continue;
        if (sample.treeRssBytes > peaks.treeRssBytes) {
            peaks.treeRssBytes = sample.treeRssBytes;
            peaks.treeRssAtMs = sample.elapsedMs;
            peaks.treeRssProcs = sample.procs;
        }
        peaks.treeCpuPercent = Math.max(peaks.treeCpuPercent, sample.treeCpuPercent);
    }
    return peaks;
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
