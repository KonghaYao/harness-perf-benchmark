/**
 * CU 2.0 Beta：固定预算下的**绝对**资源负担分（定义只在 CU2_FORMULA 一处，所有出口共用）。
 *
 *     T = 端到端秒   C = 进程树核·秒   A = 实测 GiB·秒   P = 进程树 RSS 峰值 GiB
 *     L = max(T/10, C/10, A/10, P/1)        Score = 100 / (1 + L)
 *
 * 分数 0~100、越高越好，50 分 = 恰好压在预算上；没有批内相对分，也没有直接增长倍率乘子。
 * 单档约 100 工具轮，99 等同 100、不补算。
 *
 * resourceCost 保留历史面积字段（cu 及其明细）供旧记录读取，**不参与 CU 2.0 排名**；
 * gbSeconds 的实际单位是 GiB·秒（除以 2^30），字段名沿用历史。后代 CPU 沿用
 * max(采样可见后代, 已回收计数器) 不求和，尾部补齐沿用原实现。
 *
 * 计分对证据的要求（不可得时 score = null，绝不当 100 或 0 糊过去）：status=ok、
 * 端到端时长与退出时刻为正、进程树采样开启、CSV 带 child 列、rusage 后端、样本非空且
 * 有序、末拍 → 退出的空档不超过 DEFAULT_MAX_TAIL_MS（超了说明这一份被强杀或数据残缺，
 * 截断后仍给分等于把外推当真相）。
 */

import type { ProcessSample } from "./sampler";

/** 历史面积的兼容系数；CU 2.0 不使用这两个数。 */
export const CU_COEFFICIENTS = {
    /** CU/(vCPU·秒)：核·秒与 CU 1:1。 */
    vCpuSecond: 1.0,
    /** CU/(GB·秒)：与 CPU 同价（1 核·秒 = 1 GB·秒）；FC 原表这里是 0.15。 */
    gbSecond: 1.0,
} as const;

/** 尾部补齐的默认上限：采样循环停在进程消失前最后一拍，正常空档 ≈ 一个采样间隔。 */
export const DEFAULT_MAX_TAIL_MS = 500;

/**
 * CU 2.0 Beta 的完整定义：固定演示预算、公式、方向与口径说明。
 *
 * 这是**唯一**的公式来源——run.ts 的日志行、run.json 的 cu2、图表 payload 的 scoreFormula
 * 全部引用它，谁都不许另抄一份常数。
 */
export const CU2_FORMULA = {
    scoreVersion: "cu2-beta",
    label: "CU 2.0 Beta",
    /** 固定演示预算：各项都按满预算 = 负担 1.0 计，50 分即恰好压线。 */
    budgets: { timeSeconds: 10, cpuSeconds: 10, memoryGiBSeconds: 10, peakGiB: 1 },
    expression: "L = max(T / 10, C / 10, A / 10, P / 1)",
    score: "Score = 100 / (1 + L)",
    /** 分数区间与方向：绝对分，越高越好。 */
    range: [0, 100],
    budgetScore: 50,
    sortDirection: "descending",
    scope: "process-tree",
    singleTierTurns: { target: 100, note: "99 等同 100，不补算" },
    source: "本项目 CU 2.0 Beta 固定演示预算；绝对分，不含批内相对分与增长倍率乘子",
    description:
        "T = 端到端秒；C = 进程树核·秒（后代取采样与已回收计数器两路较大者）；" +
        "A = 实测 GiB·秒；P = 进程树 RSS 峰值 GiB。四项各除以固定预算后取最大值为 L。",
    limitations: [
        "请求数来自 mock，含辅助请求，**不是工具轮数**：只作保守下限检查，不能据此声称跑满 100 轮",
        "旧 cu 面积字段（CPU 与内存 1:1 积分）仅为历史兼容，不参与 CU 2.0 排名",
        "末拍 → 退出空档超过 500ms 的运行不可评分（截断外推不算有效读数）",
    ],
} as const;

/** CU 2.0 计分结果；`score` 为 null 表示这一份**不可评分**（不是 0 分，也不是满分）。 */
export interface Cu2Score {
    scoreVersion: typeof CU2_FORMULA.scoreVersion;
    score: number | null;
    valid: boolean;
    /** 不可评分的原因码（机器可读，人读日志直接拼出来）。 */
    invalidReasons: string[];
    /** 末拍 → harness 退出的实测空档（毫秒）；缺退出时刻或没样本时为 null。 */
    tailGapMs: number | null;
    metrics: { timeSeconds: number; cpuSeconds: number; memoryGiBSeconds: number; peakGiB: number } | null;
    /** 各项占固定预算的倍数；`burden` 是它们的最大值（= L）。 */
    burdens: { time: number; cpu: number; memory: number; peak: number } | null;
    burden: number | null;
}

export interface Cu2Input {
    status: string | null;
    endToEndMs: number | null;
    harnessExitedAtMs: number | null;
    withTree: boolean | null;
    childColumnPresent: boolean;
    /** ps 拿不到已回收后代计数器，即使 CSV 有 child 列也不足以计分。 */
    samplingBackend: string | null;
    samples: readonly ProcessSample[];
    /**
     * mock 请求数：只作**保守下限**检查（明显没跑够的直接不评），
     * 它含辅助请求、不是工具轮数，不能用来证明「跑满 100 轮」。
     */
    requests: number | null;
    /** 读取端发现的坏 CSV 等原因；不得让解析器的默认 0 混成有效读数。 */
    invalidReasons?: readonly string[];
}

/**
 * CU 2.0 计分：**先验证据再算分**——缺关键证据一律 `score: null`（不是 0、也不是 100）。
 *
 * 尾部空档超过 `DEFAULT_MAX_TAIL_MS` 也判无效：`resourceCost` 会把外推截断到上限，那一份
 * 成本是**下界**，拿它出一个看起来正常的分数等于把截断当真相，所以这里直接不评。
 * 请求数只做保守下限检查（见 `Cu2Input.requests`），它证明不了工具轮数。
 */
export function cu2Score(input: Cu2Input): Cu2Score {
    const reasons = [...(input.invalidReasons ?? [])];
    const positive = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0;

    if (input.status !== "ok") reasons.push("run-not-ok");
    // 请求数含辅助请求，不是工具轮数：这里只排除明显没跑够的（下限），不作为 100 轮的验收证据。
    if (!Number.isInteger(input.requests) || (input.requests ?? 0) < 99) {
        reasons.push("insufficient-request-evidence");
    }
    if (!positive(input.endToEndMs)) reasons.push("missing-or-invalid-duration");
    if (!positive(input.harnessExitedAtMs)) reasons.push("missing-or-invalid-exit-time");
    if (input.withTree !== true) reasons.push("missing-process-tree");
    if (!input.childColumnPresent) reasons.push("missing-child-column");
    if (input.samplingBackend !== "rusage") reasons.push("missing-child-counter");
    if (input.samples.length === 0) reasons.push("empty-samples");

    let previousElapsed = -1;
    let previousTs = -1;
    for (const sample of input.samples) {
        const finite = [sample.elapsedMs, sample.cpuPercent, sample.treeCpuPercent, sample.childCpuPercent];
        if (
            finite.some((value) => !Number.isFinite(value) || value < 0) ||
            !positive(sample.ts) ||
            !positive(sample.rssBytes) ||
            !positive(sample.treeRssBytes) ||
            !Number.isInteger(sample.procs) ||
            sample.procs < 1 ||
            sample.treeRssBytes < sample.rssBytes ||
            sample.treeCpuPercent < sample.cpuPercent ||
            sample.elapsedMs <= previousElapsed ||
            sample.ts <= previousTs ||
            sample.elapsedMs > (input.endToEndMs ?? 0) ||
            sample.ts > (input.harnessExitedAtMs ?? 0)
        ) {
            reasons.push("invalid-samples");
            break;
        }
        previousElapsed = sample.elapsedMs;
        previousTs = sample.ts;
    }
    if (input.samples.length > 0 && previousElapsed <= 0) reasons.push("empty-sampling-window");

    const last = input.samples[input.samples.length - 1];
    const tailGapMs =
        last !== undefined && positive(input.harnessExitedAtMs) ? input.harnessExitedAtMs - last.ts : null;
    // 超上限时不评：截断后的外推是下界，出分等于把失真的读数当真。
    if (tailGapMs !== null && tailGapMs > DEFAULT_MAX_TAIL_MS) reasons.push("tail-gap-exceeds-limit");

    const invalid = (): Cu2Score => ({
        scoreVersion: CU2_FORMULA.scoreVersion,
        score: null,
        valid: false,
        invalidReasons: [...new Set(reasons)],
        tailGapMs,
        metrics: null,
        burdens: null,
        burden: null,
    });
    if (reasons.length > 0) return invalid();

    const cost = resourceCost(input.samples, { tailMs: tailGapMs ?? 0 });
    const peaks = resourcePeaks(input.samples);
    const metrics = {
        timeSeconds: input.endToEndMs! / 1000,
        cpuSeconds: cost.cpuSeconds,
        memoryGiBSeconds: cost.gbSeconds,
        peakGiB: peaks.treeRssBytes / 2 ** 30,
    };
    if (Object.values(metrics).some((value) => !Number.isFinite(value) || value < 0)) {
        reasons.push("invalid-resource-cost");
        return invalid();
    }
    const budgets = CU2_FORMULA.budgets;
    const burdens = {
        time: metrics.timeSeconds / budgets.timeSeconds,
        cpu: metrics.cpuSeconds / budgets.cpuSeconds,
        memory: metrics.memoryGiBSeconds / budgets.memoryGiBSeconds,
        peak: metrics.peakGiB / budgets.peakGiB,
    };
    const burden = Math.max(...Object.values(burdens));
    return {
        scoreVersion: CU2_FORMULA.scoreVersion,
        score: 100 / (1 + burden),
        valid: true,
        invalidReasons: [],
        tailGapMs,
        metrics,
        burdens,
        burden,
    };
}

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
    /** GiB·秒（常驻内存 × 时长；单位是 2^30，字段名沿用历史）。 */
    gbSeconds: number;
    /** 历史面积：`cpuCu + memoryCu`，不是 CU 2.0 分数。 */
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
 * 积分一样只有一处。RSS 峰值参与 CU 2.0 的 P 项（原样取最大值，不做时长短截），CPU 峰值仅展示。
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
 * 「三段之和 ≠ `resourceCost` 的整段 cu」是**故意的**，差额只有一笔：尾部外推只在整段那一份里
 * 算（六家实测「三段之和 + 尾部补齐 = 整段」逐笔成立）。后代 CPU 的「取较大者」同样只在整段上
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
