#!/usr/bin/env bun
/**
 * 汇总「长剧本」压测产物 → 图表数据 JSON（配 docs/perf-chart.html 画折线图）。
 *
 * 只挑长剧本那一组（`data/scenarios/long-run*.json`，100 轮 × 4KB、跑到自然结束）：每个
 * harness 一条曲线，x 为相对时间（采样起点算 0），y 为 CPU 或 RSS。
 *
 * 除了曲线，每个 harness 还给一个**统一计分**块：按阿里云 FC 的 CU 折算系数把「CPU × 时长」
 * 与「内存 × 时长」混成一个标量，再折算成百分制（口径与系数只在 score.ts 一处，见那里）。
 * 计分**在这里现算**而不是直接读 run.json 里的 `cost` 字段：老产物没有那个字段，而
 * samples.csv 一律都在——现算就能让新老产物同口径可比（代价是老产物补不了尾部空档）。
 *
 * 数据来源是**一次运行一个目录**的新布局：`<dir>/<harness>/<runId>/`，身份、时长、分段、
 * 摘要都从 `run.json` 读（不再拿正则扒中文日志）；曲线本体仍来自 `samples.csv`。
 * 顺带兼容老的平铺布局（`<runId>-perf.log` 那套，见 legacy-run.ts），迁完就该删掉那条分支。
 *
 * 取哪一次运行（一个 harness 只给一条线）：默认取该 harness **最近 3 次**里端到端时长居中的
 * 那一次（与 docs/perf-compare.md 的「3 次取中位数」同口径），可用 --pick <runId> 指定。
 *
 *   bun run scripts/perf/gen-chart-data.ts                 # → data/perf-chart.json
 *   bun run scripts/perf/gen-chart-data.ts --pick 20260919-140227
 *   bun run scripts/perf/gen-chart-data.ts --window 5      # 从最近 5 次里取中位数
 *
 * 看图的本地服务（CORS 关系不能直接 file:// 打开）：
 *   cd <仓库根> && python3 -m http.server 8080
 *   → http://localhost:8080/docs/perf-chart.html
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    SEVEN_ZIP_VERSION,
    hostMismatches,
    loadCalibration,
    type Calibration,
    type CalibrationHost,
} from "./calibrate";
import { REPO_ROOT } from "./config";
import { displayName } from "./harness-id";
import { parseLegacyPerfLog } from "./legacy-run";
import type { RunMetaCpuCalibration, RunMetaHost } from "./run-meta";
import { csvHasColumn, parseSamplesCsv, type ProcessSample } from "./sampler";
import {
    rawCu,
    relativeScores,
    resourceCost,
    resourcePeaks,
    scaleOf,
    scoreFormula,
    segmentCosts,
    standardCpuSeconds,
    type ResourceCost,
    type ScoreFormulaCalibration,
} from "./score";

const USAGE = `汇总长剧本压测产物 → 图表数据 JSON

用法:
  bun run scripts/perf/gen-chart-data.ts [选项]

选项:
  --dir <path>       产物目录，可重复（默认 data/runs，另自动带上仍在的老布局 data/claude-date）
  --out <path>       输出 JSON（默认 data/perf-chart.json；data/ 已 gitignore）
  --window <n>       每个 harness 从最近 n 次运行里取时长居中者（默认 3）
  --pick <runId>     指定用哪一次运行（可重复；给了就忽略 --window）
  --exclude <id>     按 harness id 排除，可重复（大小写不敏感）。某个 harness 退出常规批次后
                     用它把留在 data/runs 里的历史产物挡在图表外
  --cpu-calibration <path>
                     CPU 校准 JSON（cpu:calibrate 的产物；相对路径按仓库根解析）。给了就用它的
                     cpuScale 把核·秒折成项目标准 CPU 单位（本项目自定，无真实参考机器），
                     **逐个 run 核对宿主**，对不上直接报错。
                     不给则每个 run 用自己 run.json 里记的校准（没有就是未校准）
  --allow-mixed-calibration
                     本批混了「有校准 / 无校准」或口径不一致时，默认**拒绝出图**（百分制
                     分数只在同一单位里有意义）。加它就只输出数值，payload 标 blocked
  -h, --help         显示本帮助

产物 JSON 的 samples 行 = [elapsed_ms, cpu_pct, rss_kb, tree_cpu_pct, tree_rss_kb, procs]，
对应 samples.csv 的列序（去掉了 ts 列）；主进程与进程树两套口径都在里面，页面按钮切着看。

每个 harness 还带一个 score 块（口径与系数只在 scripts/perf/score.ts 一处）：
  - cu / score       把「进程树 CPU × 时长」与「内存 × 时长」按 **1:1**（1 核·秒 = 1 GB·秒）
                     混成一个标量，再折成「100 × 本批次最小 CU / 本次 CU」的百分制（最优 100 分）；
  - rawCu            同一笔账**不折算**的值（本机核·秒 + GB·秒）：cu = rawCu + cpuCu×（scale−1）；
  - standardCpuSeconds  折算后的核·秒，单位是项目标准 CPU 单位；cpuScale 是这次用的系数（1 = 未校准）；
  - peaks            进程树 RSS / CPU 的整个窗口最大值，不折算成分数（绝对量可直接横比）；
                     它答的是「最坏一刻要占多少」，与 cu 的「总共烧多少」互补，**也不受校准影响**。
分数**只在同一批次内可比**；跨机器要看折算后的 cu（payload 的 calibration 段写着用的哪把尺子）。

读到这些字段说明这一份要当心：
  tailAppliedMs=0 且 tailGapKnown=false   尾部空档补不了（老产物没记退出时刻）→ CU 是下界
  childColumnPresent=false                采样没有 child_cpu_pct 列 → 进程树口径偏低
  calibration.applied=false               这一份没有折算（CU 里的核·秒是本机秒）
  calibration.retrospective=true          系数是事后用 --cpu-calibration 套上的（本地预览）
  calibration.blocked=true                混了校准口径，不能按名次读
`;

/**
 * 只认长剧本那组：`long-run.json`（peri / opencode / Claude Code）与各家的
 * `long-run-<harness>.json`（codex / pi / dsh / minimax-code / antigravity / opencode2 / hermes，
 * 工具形状各家不同）。harness 名里可以带 `-`（`minimax-code`）**也可以带数字**
 * （`opencode2`），所以后缀是「小写字母 / 数字 / 连字符」——早先只写 `[a-z][a-z-]*` 时
 * `long-run-opencode2.json` 不匹配，那条曲线被**静默丢掉**（跑批正常、日志无警告，图上少一家）。
 */
const LONG_RUN_SCRIPT = /^long-run(-[a-z][a-z0-9-]*)?\.json$/;

/**
 * 显式挡掉的剧本名：`long-run-startup.json` 是「固定成本探针」（1 轮 / 0KB），
 * 轮数与长剧本完全不同，混进图里会把曲线读歪。
 */
const EXCLUDED_SCRIPTS = new Set(["long-run-startup.json"]);

/** 图表要用的采样行：[elapsed_ms, cpu_pct, rss_kb, tree_cpu_pct, tree_rss_kb, procs]。 */
export type SampleRow = [number, number, number, number, number, number];

export const SAMPLE_COLUMNS = [
    "elapsed_ms",
    "cpu_pct",
    "rss_kb",
    "tree_cpu_pct",
    "tree_rss_kb",
    "procs",
] as const;

/** 一次可用于画图的运行（新老两种布局最终都归一成这个形状）。 */
export interface RunRecord {
    runId: string;
    harnessId: string;
    name: string;
    /** 启动命令（人读；新布局来自 run.json，老布局来自日志）。 */
    commandLine: string | null;
    /** 剧本路径（相对仓库根优先）。 */
    script: string;
    endToEndMs: number;
    samplingWindowMs: number | null;
    requests: number | null;
    segments: { startupMs: number; spanMs: number; tailMs: number } | null;
    /** 「首个 / 末次请求」相对采样起点的毫秒数（画分界线用）。 */
    requestMarksMs: { first: number; last: number } | null;
    /** harness 退出的绝对时刻（末拍之后还剩多久没记进采样，计分时要补）；老布局为 null。 */
    harnessExitedAtMs: number | null;
    /** 原始采样点（全精度；出 payload 时才裁成图表行）。 */
    samples: ProcessSample[];
    /**
     * samples.csv 是否带 `child_cpu_pct` 列（2026-09-19 才加）。
     * 老产物没有它，进程树口径会偏低——这个事实要跟着数据走，不能悄悄按 0 处理。
     */
    childColumnPresent: boolean;
    /**
     * 跑批时带的 `--label`（没带就是 null）。它进 payload 只为一件事：让页面能看出
     * **这一张图上混了不同批次的运行**——百分制分数是「本批最小 CU」的相对值，跨批混画
     * 出来的分数没有意义，而页面上看数据是看不出来的。
     */
    label: string | null;
    /**
     * 跑这次运行时那台机器的快照（新布局有，老布局 null）。**用于核对校准值是不是本机的**
     * ——拿别的机器的尺子折算这台机器的读数，出来的是个更大的错数，且看不出来。
     */
    host?: RunMetaHost | null;
    /**
     * 跑这次运行时用的 CPU 校准摘要（`run.json.cpuCalibration`）。
     * null / 缺失 = 这次没校准（CU 里的核·秒就是本机秒）。
     */
    cpuCalibration?: RunMetaCpuCalibration | null;
}

/** 校准口径的身份：变了就不是同一把尺子，跨运行比较必须先过这一关。 */
export interface CalibrationIdentity {
    method: string;
    toolVersion: string;
    /** 单线程那一路的参数（`argv`），折算只认它。 */
    argv: string[];
    dictSize: number;
    baselineMips: number;
    repeats: number;
    threads: number;
    /** binary hash + 版本 + 参数 + baseline + 重复数 + 线程数（由 calibrate.ts 算出来）。 */
    configSignature: string;
}

/**
 * 从校准对象里抽出「口径身份」。
 *
 * `configSignature` 是从**完整校准 JSON** 重算出来的（不是读它自己那个字段）：字段被手改过、
 * 或者 JSON 是别人手搓的，签名就与内容对不上——这里以内容为准，签名只是个便于比对的字符串。
 */
export function calibrationIdentity(calibration: Calibration): CalibrationIdentity {
    const args = calibration.tool.args;
    const argv = args.argv ?? ["b", "1", `-mmt${args.threads}`, `-md${args.dictSize}`];
    const identity: CalibrationIdentity = {
        method: calibration.method,
        toolVersion: calibration.tool.version,
        argv: [...argv],
        dictSize: args.dictSize,
        baselineMips: calibration.scale.baselineMips,
        repeats: calibration.statistic.repeats,
        threads: calibration.machine?.threads ?? args.threads,
        configSignature: "",
    };
    identity.configSignature = [
        calibration.tool.binary.sha256,
        identity.toolVersion,
        identity.argv.join(" "),
        `dict=${identity.dictSize}`,
        `baseline=${identity.baselineMips}`,
        `repeats=${identity.repeats}`,
        `threads=${identity.threads}`,
    ].join("|");
    return identity;
}

/** 口径身份是否一致（逐项比，**不只看签名字符串**：会漏掉「签名没跟着改」的手改 JSON）。 */
export function sameCalibrationIdentity(
    left: CalibrationIdentity,
    right: CalibrationIdentity,
): string[] {
    const differences: string[] = [];
    if (left.method !== right.method) differences.push(`method ${left.method}≠${right.method}`);
    if (left.toolVersion !== right.toolVersion) {
        differences.push(`tool.version ${left.toolVersion}≠${right.toolVersion}`);
    }
    if (left.argv.join(" ") !== right.argv.join(" ")) {
        differences.push(`参数 ${left.argv.join(" ")}≠${right.argv.join(" ")}`);
    }
    if (left.dictSize !== right.dictSize) differences.push(`dictSize ${left.dictSize}≠${right.dictSize}`);
    if (left.baselineMips !== right.baselineMips) {
        differences.push(`baselineMips ${left.baselineMips}≠${right.baselineMips}`);
    }
    if (left.repeats !== right.repeats) differences.push(`repeats ${left.repeats}≠${right.repeats}`);
    // `threads` 只在整机吞吐那一路用，**不参与折算**（cpuScale 只认单线程 R/U），
    // 所以它不同不算换尺子——比它会把「同一台机器上换了个 -mmt 观察值」误判成口径变更。
    return differences;
}

/** 从 `run.json.cpuCalibration`（摘要）还原口径身份：老产物没有摘要就按「只比方法/版本」处理。 */
export function identityFromStored(stored: RunMetaCpuCalibration): CalibrationIdentity {
    const signatureParts = stored.configSignature?.split("|") ?? [];
    const fromSignature = (index: number): string | undefined => signatureParts[index];
    const threadsFromSignature = fromSignature(6)?.replace("threads=", "");
    const repeatsFromSignature = fromSignature(5)?.replace("repeats=", "");
    const baselineFromSignature = fromSignature(4)?.replace("baseline=", "");
    const dictFromSignature = fromSignature(3)?.replace("dict=", "");
    const argvFromSignature = signatureParts[2];
    return {
        method: stored.method,
        toolVersion: stored.toolVersion,
        argv: argvFromSignature === undefined ? [] : [argvFromSignature],
        dictSize: dictFromSignature === undefined ? 25 : Number(dictFromSignature),
        baselineMips:
            typeof stored.baselineMips === "number"
                ? stored.baselineMips
                : Number(baselineFromSignature ?? "0"),
        repeats:
            typeof stored.statistic?.repeats === "number"
                ? stored.statistic.repeats
                : Number(repeatsFromSignature ?? "0"),
        threads: Number(threadsFromSignature ?? "0"),
        configSignature: stored.configSignature ?? "",
    };
}

/** 脚本名是否属于长剧本那组。 */
export function isLongRunScript(path: string): boolean {
    const name = basename(path);
    return LONG_RUN_SCRIPT.test(name) && !EXCLUDED_SCRIPTS.has(name);
}

/** 采样点 → 图表行（KB 取整、百分数留一位小数，别把 JSON 撑大）。 */
function toRows(samples: readonly ProcessSample[]): SampleRow[] {
    return samples.map((sample) => [
        Math.round(sample.elapsedMs),
        Math.round(sample.cpuPercent * 10) / 10,
        Math.round(sample.rssBytes / 1024),
        Math.round(sample.treeCpuPercent * 10) / 10,
        Math.round(sample.treeRssBytes / 1024),
        Math.round(sample.procs),
    ]);
}

/** 「首个 / 末次请求」相对采样起点的位置；两种布局各有各的还原方式。 */
function marksFrom(
    timing: { harnessStartedAtMs: number | null; samplingStartedAtMs: number | null; firstRequestAtMs: number | null; lastRequestAtMs: number | null },
    segments: { startupMs: number; spanMs: number } | null,
): { first: number; last: number } | null {
    if (timing.firstRequestAtMs !== null && timing.lastRequestAtMs !== null && timing.samplingStartedAtMs !== null) {
        return {
            first: timing.firstRequestAtMs - timing.samplingStartedAtMs,
            last: timing.lastRequestAtMs - timing.samplingStartedAtMs,
        };
    }
    // 老产物：没有绝对时刻，只能借「启动 → 采样开始」的间隔把分界线挪到采样时间轴上。
    if (segments === null || timing.harnessStartedAtMs === null || timing.samplingStartedAtMs === null) {
        return null;
    }
    const first = timing.samplingStartedAtMs - timing.harnessStartedAtMs + segments.startupMs;
    return { first, last: first + segments.spanMs };
}

/** 读一次 samples.csv：原始采样点（全精度）与「表头带不带 child_cpu_pct」。 */
function readCsvSamples(csvPath: string): { samples: ProcessSample[]; childColumnPresent: boolean } {
    const text = readFileSync(csvPath, "utf8");
    return {
        samples: parseSamplesCsv(text),
        childColumnPresent: csvHasColumn(text, "child_cpu_pct"),
    };
}

/**
 * 末拍到 harness 退出之间的空档（毫秒）——计分要按末尾几拍的速率把它补上。
 *
 * 采样循环在读到「进程已不在」时就停，最后一拍到真正退出之间固定还有约一个采样间隔
 * （实测 ≈100ms）没记账；对 pi 这种 1.5s 就跑完的快 harness 相当于漏计 ~7%。
 * 老结局（老布局、或 run.json 早于 2026-09-19）没记 `harnessExitedAtMs`，这里只能返回 0，
 * **那一份 CU 是下界**——由 `tailAppliedMs: 0` + `tailGapKnown: false` 标出来。
 */
export function tailGapMs(run: RunRecord): number {
    if (run.harnessExitedAtMs === null || run.samples.length === 0) return 0;
    const last = run.samples[run.samples.length - 1] as ProcessSample;
    return Math.max(0, run.harnessExitedAtMs - last.ts);
}

/**
 * 一次运行的资源成本（进程树口径，含尾部补齐）。
 *
 * `cpuScale` 由校准给出（不校准 = 1）：它**只乘 CPU 项**。这里现算而不是读 `run.json.cost`，
 * 是因为老产物没有那个字段，而 samples.csv 一律都在——现算能让新老产物同口径可比。
 */
export function costOf(run: RunRecord, cpuScale = 1): ResourceCost {
    return resourceCost(run.samples, { tailMs: tailGapMs(run), cpuScale });
}

/** 保留 digits 位小数；-0 归一成 0，免得 JSON 里出现 `-0`。 */
function round(value: number, digits: number): number {
    const factor = 10 ** digits;
    const rounded = Math.round(value * factor) / factor;
    return rounded === 0 ? 0 : rounded;
}

/** 一段成本的紧凑形式（三段各一份，别把 payload 撑成三层对象嵌套）。 */
function segmentRow(cost: ResourceCost): SegmentScore {
    return {
        cu: round(cost.cu, 6),
        rawCu: round(rawCu(cost), 6),
        cpuSeconds: round(cost.cpuSeconds, 6),
        standardCpuSeconds: round(standardCpuSeconds(cost), 6),
        gbSeconds: round(cost.gbSeconds, 6),
        cpuScale: scaleOf(cost),
        sampleCount: cost.sampleCount,
    };
}

/**
 * 计分块（payload 里每个 harness 一份）：公式的每一项都摊开写，图表页只负责显示，
 * 不自己记公式也不自己算——口径只有 score.ts 一处。
 *
 * 除了 CU（面积，含时长），再给一份**峰值**（压力口径，不折算）：它答的是「最坏一刻要占
 * 多少」，与时长、比例都无关，直接从原始采样点取。**峰值也不受 CPU 校准影响**。
 */
export function serializeCost(
    run: RunRecord,
    cost: ResourceCost,
    score: number | null,
    calibration: RunScoreCalibration | null = null,
): RunScore {
    const marks = run.requestMarksMs;
    const peaks = resourcePeaks(run.samples);
    const cpuScale = scaleOf(cost);
    const segments =
        marks === null
            ? null
            : (() => {
                  // 分段不做尾部外推（那是整个窗口的性质，塞进某一段会重复计），所以 tailMs 不传；
                  // 折算系数逐段同一个（否则三段之和与总分对不上）。
                  const parts = segmentCosts(run.samples, marks, { cpuScale });
                  return {
                      startup: segmentRow(parts.startup),
                      span: segmentRow(parts.span),
                      tail: segmentRow(parts.tail),
                  };
              })();
    return {
        score: score === null ? null : round(score, 1),
        cu: round(cost.cu, 6),
        rawCu: round(rawCu(cost), 6),
        cpuCu: round(cost.cpuCu, 6),
        memoryCu: round(cost.memoryCu, 6),
        cpuSeconds: round(cost.cpuSeconds, 6),
        standardCpuSeconds: round(standardCpuSeconds(cost), 6),
        cpuScale: round(cpuScale, 9),
        gbSeconds: round(cost.gbSeconds, 6),
        mbSeconds: round(cost.gbSeconds * 1024, 3),
        rootCpuSeconds: round(cost.rootCpuSeconds, 6),
        childCpuSeconds: round(cost.childCpuSeconds, 6),
        childCpuFrom: cost.childCpuFrom,
        tailAppliedMs: round(cost.tailAppliedMs, 0),
        tailGapKnown: run.harnessExitedAtMs !== null,
        samplingMs: round(cost.samplingMs, 0),
        sampleCount: cost.sampleCount,
        childColumnPresent: run.childColumnPresent,
        calibration,
        peaks: {
            treeRssMb: round(peaks.treeRssBytes / 1024 / 1024, 1),
            treeCpuPercent: round(peaks.treeCpuPercent, 1),
            treeRssAtMs: round(peaks.treeRssAtMs, 0),
            procs: round(peaks.treeRssProcs, 0),
        },
        segments,
    };
}

/** 一段（启动 / 运转 / 收尾）的成本摘要。 */
export interface SegmentScore {
    cu: number;
    /** 未折算的 CU（本机核·秒 + GB·秒）。 */
    rawCu: number;
    cpuSeconds: number;
    /** 折算后的核·秒，单位是项目标准 CPU 单位（本项目自定，不是某台真实参考机器）。 */
    standardCpuSeconds: number;
    gbSeconds: number;
    /** 这一段用的折算系数。 */
    cpuScale: number;
    sampleCount: number;
}

/**
 * 计分块里的校准信息：**人读的那一份**，够页面写清「这个数是哪台机器上的、用的哪把尺子」。
 * 完整读数（逐轮原始值、日志 sha256、宿主全字段）留在校准 JSON 里，不灌进 payload。
 */
export interface RunScoreCalibration {
    method: string;
    cpuScale: number;
    baselineMips: number;
    cpuScaleValue: number;
    toolVersion: string;
    measuredAt: string;
    /** 折算只乘 CPU 项（这一句也进 payload，页面不必自己解释）。 */
    scope: "cpu-term-only";
    /** `stored` = 这次运行自己记的校准；`flag` = 用 `--cpu-calibration` 事后重算。 */
    source: "stored" | "flag";
    /** 校准文件的出处（目录或文件路径）。 */
    file: string;
}

/** 计分块：`100 × 本批次最小 CU / 本次 CU`，最优 100 分。 */
export interface RunScore {
    /**
     * 百分制分数。**折算口径混合（`calibration.blocked`）时为 null**：那时各家的 CU 不在同一个
     * 单位上，任何「谁更省」的名次都不成立——宁可不给分，也不给一个看起来很像分数的数。
     */
    score: number | null;
    /** 折算后的 CU（CPU 项为项目标准 CPU 单位、内存项仍是本机 GB·秒）；未校准时与 `rawCu` 相等。**主数值就是它。** */
    cu: number;
    /** **未折算**的 CU（本机核·秒 + GB·秒），校准前后都可横比的原始数。 */
    rawCu: number;
    cpuCu: number;
    memoryCu: number;
    /** 本机核·秒（未折算）。 */
    cpuSeconds: number;
    /** 项目标准 CPU 单位·秒 = `cpuSeconds × cpuScale`。 */
    standardCpuSeconds: number;
    /** 这次折算用的系数（1 = 未校准）。 */
    cpuScale: number;
    gbSeconds: number;
    /** = `gbSeconds × 1024`：报告与页面按 MB·秒 显示（数值比 GB·秒 直观），口径不变。 */
    mbSeconds: number;
    rootCpuSeconds: number;
    childCpuSeconds: number;
    childCpuFrom: "counter" | "sampled";
    /** 实际补进来的尾部时长；0 表示这一份是下界（老产物没记退出时刻）。 */
    tailAppliedMs: number;
    /** 是否知道「末拍 → 退出」的空档（老布局 / 旧 run.json 为 false）。 */
    tailGapKnown: boolean;
    samplingMs: number;
    sampleCount: number;
    /** samples.csv 是否带 child_cpu_pct 列；false 表示进程树口径偏低。 */
    childColumnPresent: boolean;
    /** 折算用的那把尺子（未校准 = null）。 */
    calibration: RunScoreCalibration | null;
    /**
     * **压力口径**（峰值）：整个窗口的最大值，不折算成分数（MB 与 % 本来就能横比）。
     * **峰值也不受 CPU 校准影响**（它是绝对量，不乘 scale）。
     */
    peaks: { treeRssMb: number; treeCpuPercent: number; treeRssAtMs: number; procs: number };
    segments: { startup: SegmentScore; span: SegmentScore; tail: SegmentScore } | null;
}

/** 新布局：`<dir>/<harness>/<runId>/run.json` + samples.csv。 */
export function collectFromRunsDir(dir: string): { runs: RunRecord[]; skipped: string[] } {
    const runs: RunRecord[] = [];
    const skipped: string[] = [];
    if (!existsSync(dir)) return { runs, skipped };

    for (const harnessDir of readdirSync(dir).sort()) {
        const harnessPath = join(dir, harnessDir);
        if (!statSync(harnessPath).isDirectory()) continue;
        for (const runId of readdirSync(harnessPath).sort()) {
            const runDir = join(harnessPath, runId);
            const metaPath = join(runDir, "run.json");
            if (!existsSync(metaPath)) continue;
            let meta: Record<string, unknown>;
            try {
                meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
            } catch (error) {
                skipped.push(`${runId}（run.json 不是合法 JSON：${(error as Error).message}）`);
                continue;
            }
            if (meta.schemaVersion !== 1) {
                skipped.push(`${runId}（run.json schemaVersion=${String(meta.schemaVersion)}，本工具只认 1）`);
                continue;
            }
            const harness = meta.harness as { id?: string; commandLine?: string } | undefined;
            const scenario = meta.scenario as { name?: string; relPath?: string; path?: string } | undefined;
            const scriptName = scenario?.name ?? "";
            if (!isLongRunScript(scriptName)) continue;
            if (meta.status !== "ok") {
                skipped.push(`${harnessDir}/${runId}（status=${String(meta.status)}，不是跑完的运行）`);
                continue;
            }
            const csvPath = join(runDir, "samples.csv");
            if (!existsSync(csvPath)) {
                skipped.push(`${harnessDir}/${runId}（缺 samples.csv）`);
                continue;
            }
            const duration = meta.duration as { endToEndMs?: number | null; samplingWindowMs?: number | null } | undefined;
            const mock = meta.mock as { requests?: number | null } | undefined;
            const timing = (meta.timing ?? {}) as {
                harnessStartedAtMs?: number | null;
                samplingStartedAtMs?: number | null;
                firstRequestAtMs?: number | null;
                lastRequestAtMs?: number | null;
                harnessExitedAtMs?: number | null;
            };
            const rawSegments = (meta.segments ?? null) as
                | { startupMs: number; spanMs: number; tailMs: number }
                | null;
            // 只带画图要用的三段；idleTail 之类的判定由读取端自己按阈值算，不灌进 payload。
            const segments =
                rawSegments === null
                    ? null
                    : {
                          startupMs: rawSegments.startupMs,
                          spanMs: rawSegments.spanMs,
                          tailMs: rawSegments.tailMs,
                      };
            const harnessId = typeof harness?.id === "string" ? harness.id : harnessDir;
            const csv = readCsvSamples(csvPath);
            runs.push({
                runId,
                harnessId,
                name: displayName(harnessId),
                commandLine: harness?.commandLine ?? null,
                script: scenario?.relPath ?? scenario?.path ?? scriptName,
                endToEndMs: duration?.endToEndMs ?? 0,
                samplingWindowMs: duration?.samplingWindowMs ?? null,
                requests: mock?.requests ?? null,
                segments,
                requestMarksMs: marksFrom(
                    {
                        harnessStartedAtMs: timing.harnessStartedAtMs ?? null,
                        samplingStartedAtMs: timing.samplingStartedAtMs ?? null,
                        firstRequestAtMs: timing.firstRequestAtMs ?? null,
                        lastRequestAtMs: timing.lastRequestAtMs ?? null,
                    },
                    segments,
                ),
                harnessExitedAtMs: timing.harnessExitedAtMs ?? null,
                samples: csv.samples,
                childColumnPresent: csv.childColumnPresent,
                label: typeof meta.label === "string" ? meta.label : null,
                host: (meta.host ?? null) as RunMetaHost | null,
                cpuCalibration: (meta.cpuCalibration ?? null) as RunMetaCpuCalibration | null,
            });
        }
    }
    return { runs, skipped };
}

/**
 * 老布局（平铺）兼容：`<dir>/<runId>-perf.log` + `<runId>-samples.csv`。
 * **过渡用**——迁移完成后连同 legacy-run.ts 一起删。
 */
export function collectFromFlatDir(dir: string): { runs: RunRecord[]; skipped: string[] } {
    const runs: RunRecord[] = [];
    const skipped: string[] = [];
    if (!existsSync(dir)) return { runs, skipped };

    for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith("-perf.log")) continue;
        const runId = name.slice(0, -"-perf.log".length);
        const parsed = parseLegacyPerfLog(runId, readFileSync(join(dir, name), "utf8"));
        if (parsed === null || !isLongRunScript(parsed.scriptPath)) continue;
        if (parsed.status !== "ok") {
            skipped.push(`${runId}（status=${parsed.status}，老布局）`);
            continue;
        }
        const csvPath = join(dir, `${runId}-samples.csv`);
        if (!existsSync(csvPath)) {
            skipped.push(`${runId}（缺 samples.csv，老布局）`);
            continue;
        }
        const csv = readCsvSamples(csvPath);
        runs.push({
            runId,
            harnessId: parsed.harnessId,
            name: displayName(parsed.harnessId),
            commandLine: parsed.commandLine,
            script: relative(REPO_ROOT, parsed.scriptPath).startsWith("..")
                ? parsed.scriptPath
                : relative(REPO_ROOT, parsed.scriptPath),
            endToEndMs: parsed.endToEndMs ?? 0,
            samplingWindowMs: parsed.samplingWindowMs,
            requests: parsed.requests,
            segments: parsed.segments,
            requestMarksMs: marksFrom(
                {
                    harnessStartedAtMs: parsed.harnessStartedAtMs,
                    samplingStartedAtMs: parsed.samplingStartedAtMs,
                    firstRequestAtMs: null,
                    lastRequestAtMs: null,
                },
                parsed.segments,
            ),
            // 老布局的 perf.log 没记 harness 退出时刻，尾部空档补不了（计分时按 0 处理，标成下界）。
            harnessExitedAtMs: null,
            samples: csv.samples,
            childColumnPresent: csv.childColumnPresent,
            label: null,
            // 老布局连宿主都没记：**没有 host 就不能核对校准**，所以带显式 --cpu-calibration
            // 时会直接拒绝它（见 resolveScales），不会静默按 1 或按别的机器的 scale 算。
            host: null,
            cpuCalibration: null,
        });
    }
    return { runs, skipped };
}

/** 一个 harness 只留一条线：取最近 `window` 次里端到端时长居中的那一次（runId 字典序即时间序）。 */
export function pickMedianOfLatest(runs: RunRecord[], window: number): RunRecord {
    const recent = [...runs].sort((a, b) => a.runId.localeCompare(b.runId)).slice(-window);
    const byDuration = [...recent].sort((a, b) => a.endToEndMs - b.endToEndMs);
    return byDuration[Math.floor((byDuration.length - 1) / 2)]!;
}

/** 一次运行最终用哪个系数折算、以及它是从哪儿来的。 */
export interface ScaleResolution {
    runId: string;
    cpuScale: number;
    /** `stored` = run.json 自己记的；`flag` = 命令行 `--cpu-calibration` 指定的；`none` = 未校准。 */
    source: "stored" | "flag" | "none";
    /** 折算用的那把尺子（未校准 = null）。 */
    identity: CalibrationIdentity | null;
    /** 这把尺子的原始值（折算用的 R/U 均值）——`flag` 时取自命令行给的那份校准。 */
    cpuScaleValue: number;
    /** 量这把尺子的时刻（ISO）；缺失时为空串。 */
    measuredAt: string;
    /** 这把尺子记在哪份校准文件/目录里（产物自带的是目录，`--cpu-calibration` 给的是那个文件）。 */
    file: string;
    /** 这次运行自己记的校准（不管最终用不用它）。 */
    stored: RunMetaCpuCalibration | null;
    /** 这次运行那台机器的快照（老布局 = null）。 */
    host: RunMetaHost | null;
    /** 单线程 Rating 的 CV（%）；拿不到就是 null。 */
    singleThreadCvPercent: number | null;
    /** 整机那一路的实测吞吐与线程数；拿不到就是 null。 */
    machine: { threads: number; standardUnitsThroughput: number } | null;
    /** 量这把尺子那台机器的身份（`measurementHost`，与运行所在机器是两回事）。 */
    measurementHost: CalibrationHost | null;
}

/** payload 里的折算说明：页面据此解释「这个 CU 是哪把尺子量的」。 */
export interface CalibrationPreview {
    /** `false` 表示这一批**一次都没校准**（CU 就是本机核·秒 + GB·秒）。 */
    applied: boolean;
    /**
     * `true` 表示折算系数是用 `--cpu-calibration` **事后套上去的**（产物本身没记那次运行的校准）：
     * 这是一份**本地预览**，不是「按新口径重跑」出来的读数——原始 run.json / samples.csv 未改。
     */
    retrospective: boolean;
    mode: "none" | "as-recorded" | "local-preview";
    /** 参与折算的尺度（多台机器时逐个列出）。 */
    scales: { runId: string; harness: string; cpuScale: number; source: string }[];
    /** 折算口径的身份（口径不同就不该同批比较，所以这里也要写出来）。 */
    identity: CalibrationIdentity | null;
    baselineMips: number | null;
    toolVersion: string | null;
    /** 量这把尺子的时刻（ISO；拿不到就是空串）。 */
    measuredAt: string | null;
    /** 量尺子那台机器（页面要写清「这个数出自哪台机器」）。 */
    host: { hostname: string; cpuModel: string; cpus: number; platform: string; arch: string } | null;
    /** 单线程 Rating 的 CV（%）：这把尺子量得稳不稳。 */
    singleThreadCvPercent: number | null;
    /** 整机那一路的**实测**吞吐与线程数（观察值，不是「单线程 × 核数」）。 */
    machine: { threads: number; standardUnitsThroughput: number } | null;
    /** 折算用的校准文件（去重）。 */
    files: string[];
    /** 页面上必须写出来的限制。 */
    disclaimers: string[];
    /**
     * `true` = 这一批**不能**给相对排名：混了「有校准/无校准」、或口径不一致。
     * CU 与折算后的字段仍然有效（各自的单位写着），但百分制分数与名次没有意义。
     */
    blocked: boolean;
    /** 被阻断的原因（人读，直接印）。 */
    blockedReasons: string[];
}

export interface ScalesResult {
    /** runId → 折算结果。 */
    byRun: Map<string, ScaleResolution>;
    preview: CalibrationPreview;
    /** 人读的日志行（调用方决定往哪儿打）。 */
    notes: string[];
}

/** `--cpu-calibration` 指定的系数要用到某次运行上时，必须先过这道核对。 */
function checkExplicitAgainst(
    run: RunRecord,
    explicit: { identity: CalibrationIdentity; scale: number; host: CalibrationHost },
): void {
    const label = `${run.name} ${run.runId}`;
    const mismatches = hostMismatches({ ...explicit.host }, run.host ?? null);
    if (mismatches.length > 0) {
        throw new Error(
            `--cpu-calibration 用不到 ${label} 上：宿主对不上（${mismatches.join("；")}）。` +
                "显式指定校准就是「我要用这把尺子量这一批」，尺子与机器不符必须拒绝——" +
                "老布局的产物没有 host，无法核对，请先迁移或改用 --pick 排除它",
        );
    }
    if (run.cpuCalibration != null) {
        const storedIdentity = identityFromStored(run.cpuCalibration);
        const conflicts = sameCalibrationIdentity(storedIdentity, explicit.identity);
        if (conflicts.length > 0) {
            throw new Error(
                `${label} 的产物里记着另一次校准（cpuScale ${run.cpuCalibration.cpuScale}），` +
                    `与 --cpu-calibration 给的口径不一致（${conflicts.join("；")}）：` +
                    "两个都想要就没法说是哪把尺子量的——去掉 --cpu-calibration 用产物自己记的，" +
                    "或重跑这一批带上新的校准",
            );
        }
        if (run.cpuCalibration.cpuScale !== explicit.scale) {
            throw new Error(
                `${label} 的产物里记着 cpuScale ${run.cpuCalibration.cpuScale}，` +
                    `与 --cpu-calibration 的 ${explicit.scale} 不同：同一台机器上的同一次运行不该有两个折算值，` +
                    "拒绝静默挑一个",
            );
        }
    }
}

/**
 * 定这一批每个 run 用哪个系数折算。
 *
 * 三条规则，都是为了**不让人看到一张算错的图**：
 *
 * 1. `--cpu-calibration` 给了：整批都用它，逐个 run 核对宿主（对不上直接抛）。这是
 *    「本地重算预览」——原始产物没改，载荷里会标 `retrospective`。
 * 2. 没给：每个 run 用**它自己 run.json 里记的**校准；一个都没有就是整批未校准。
 * 3. 有校准的那些，**口径必须一致**（method / 工具版本 / 参数 / baseline / 重复数）：
 *    不一致就没法说这些 CU 是同一把尺子量的，按 `blocked` 处理——标记出来、让调用方拒绝。
 *
 * 不同机器 → 不同的 `cpuScale` 是**允许**的（那正是折算的意义）：只要口径一致，
 * 每台机器各自折成同一套项目标准 CPU 单位，CU 才能放在一张表里比。
 */
export function resolveScales(
    runs: readonly RunRecord[],
    explicit: Calibration | null,
    options: { explicitFile?: string } = {},
): ScalesResult {
    const byRun = new Map<string, ScaleResolution>();
    const notes: string[] = [];
    const explicitIdentity = explicit === null ? null : calibrationIdentity(explicit);
    const explicitScale = explicit === null ? 1 : explicit.scale.cpuScale;
    const explicitTarget =
        explicit === null || explicitIdentity === null
            ? null
            : {
                  identity: explicitIdentity,
                  scale: explicitScale,
                  scaleValue: explicit.scale.cpuScaleValue,
                  measuredAt: explicit.measuredAt,
                  singleThreadCvPercent: explicit.singleThread.stats.rating.cvPercent,
                  machine: {
                      threads: explicit.machine.threads,
                      standardUnitsThroughput: explicit.machine.standardUnits.throughput,
                  },
                  host: explicit.host,
              };
    let retrospective = false;

    for (const run of runs) {
        if (explicitTarget !== null) {
            checkExplicitAgainst(run, explicitTarget);
            const storedIdentity =
                run.cpuCalibration == null ? null : identityFromStored(run.cpuCalibration);
            // 产物自己记着、且与显式的一致 → 不改变读数，按产物口径记（不算「事后重算」）。
            if (storedIdentity !== null && run.cpuCalibration?.cpuScale === explicitScale) {
                byRun.set(run.runId, {
                    runId: run.runId,
                    cpuScale: explicitScale,
                    source: "stored",
                    identity: storedIdentity,
                    cpuScaleValue: run.cpuCalibration.cpuScaleValue,
                    measuredAt: run.cpuCalibration.measuredAt,
                    file: run.cpuCalibration.file,
                    stored: run.cpuCalibration,
                    host: run.host ?? null,
                    singleThreadCvPercent: run.cpuCalibration.singleThreadCvPercent ?? null,
                    machine: run.cpuCalibration.machine ?? null,
                    measurementHost: run.cpuCalibration.calibrationHost,
                });
                continue;
            }
            retrospective = true;
            byRun.set(run.runId, {
                runId: run.runId,
                cpuScale: explicitScale,
                source: "flag",
                identity: explicitIdentity,
                cpuScaleValue: explicitTarget.scaleValue,
                measuredAt: explicitTarget.measuredAt,
                file: options.explicitFile ?? "",
                stored: run.cpuCalibration ?? null,
                host: run.host ?? null,
                singleThreadCvPercent: explicitTarget.singleThreadCvPercent,
                machine: explicitTarget.machine,
                measurementHost: explicitTarget.host,
            });
            continue;
        }
        if (run.cpuCalibration == null) {
            byRun.set(run.runId, {
                runId: run.runId,
                cpuScale: 1,
                source: "none",
                identity: null,
                cpuScaleValue: 1,
                measuredAt: "",
                file: "",
                stored: null,
                host: run.host ?? null,
                singleThreadCvPercent: null,
                machine: null,
                measurementHost: null,
            });
            continue;
        }
        const identity = identityFromStored(run.cpuCalibration);
        // 产物自己记的校准必须与它自己那台机器相符：产物可能被拷到别的机器上读，
        // 这时候按它的 scale 算出来的数是「那台机器的」，**不是**当前这台机器的——
        // 只要 run.json 里有 host，就当场核对；对不上就拒绝，不静默出一个错数。
        const mismatches = hostMismatches(
            { ...run.cpuCalibration.calibrationHost },
            run.host ?? null,
        );
        if (mismatches.length > 0) {
            throw new Error(
                `${run.name} ${run.runId} 的 run.json 自相矛盾：cpuCalibration.calibrationHost 与 ` +
                    `host 对不上（${mismatches.join("；")}）。产物被动过或在错机器上解释，拒绝折算`,
            );
        }
        byRun.set(run.runId, {
            runId: run.runId,
            cpuScale: run.cpuCalibration.cpuScale,
            source: "stored",
            identity,
            cpuScaleValue: run.cpuCalibration.cpuScaleValue,
            measuredAt: run.cpuCalibration.measuredAt,
            file: run.cpuCalibration.file,
            stored: run.cpuCalibration,
            host: run.host ?? null,
            singleThreadCvPercent: run.cpuCalibration.singleThreadCvPercent ?? null,
            machine: run.cpuCalibration.machine ?? null,
            measurementHost: run.cpuCalibration.calibrationHost,
        });
    }

    // 口径一致性：有校准的那些必须同一把尺子。不同机器 → 不同 scale 是正常的，不算不一致。
    const calibrated = [...byRun.values()].filter((entry) => entry.source !== "none");
    const uncalibrated = [...byRun.values()].filter((entry) => entry.source === "none");
    const identityDifferences: string[] = [];
    let reference: CalibrationIdentity | null = null;
    const referenceRun = calibrated[0];
    if (referenceRun !== undefined) {
        reference = referenceRun.identity;
        for (const entry of calibrated.slice(1)) {
            if (entry.identity === null || reference === null) continue;
            const differences = sameCalibrationIdentity(entry.identity, reference);
            if (differences.length > 0) {
                identityDifferences.push(
                    `${byRunLabel(runs, entry.runId)}: ${differences.join("；")}`,
                );
            }
        }
    }

    const files = [
        ...new Set(
            [
                ...(options.explicitFile === undefined ? [] : [options.explicitFile]),
                ...calibrated.map((entry) => entry.stored?.file ?? ""),
            ].filter((file) => file !== ""),
        ),
    ];
    const scales = calibrated.map((entry) => ({
        runId: entry.runId,
        harness: runs.find((run) => run.runId === entry.runId)?.name ?? entry.runId,
        // 显示用：4 位小数足够，浮点尾巴（9.386899999999999）不是信息。计算不受影响。
        cpuScale: round(entry.cpuScale, 4),
        source: entry.source,
    }));
    const applied = calibrated.length > 0 && uncalibrated.length === 0 && identityDifferences.length === 0;
    const disclaimers: string[] = [];
    if (applied) {
        disclaimers.push(
            "the CPU term is rescaled with the host's measured 7-Zip benchmark rating into this " +
                "project's standard CPU units (a project-defined unit — no real reference machine " +
                "was measured); the memory term is not rescaled, so the two terms are in different " +
                "units and the ranking can change",
            "7-Zip Rating is an estimate of relative CPU speed, not an instruction count; no " +
                "absolute cross-machine agreement is guaranteed",
            "the memory term is the locally measured GB·s and is never rescaled: only the CPU term " +
                "changes units, so a rescaled ranking may differ from the raw one (e.g. a CPU-heavy " +
                "run can overtake a memory-heavy one)",
        );
        if (retrospective) {
            disclaimers.push(
                "local preview: the scale was applied afterwards from a calibration file — the " +
                    "runs were not re-measured, and their original run.json / samples.csv are untouched",
            );
        }
    }
    // 阻断项与「写给人看的限制」分开攒：页面要能直接印 blockedReasons，不必猜哪句是阻断。
    const blockedReasons: string[] = [];
    if (calibrated.length > 0 && uncalibrated.length > 0) {
        const line =
            "this batch mixes calibrated and uncalibrated runs: their CU is in different units, " +
            "so relative ranking is blocked";
        disclaimers.push(line);
        blockedReasons.push(
            `${line}（未校准：${uncalibrated.map((entry) => byRunLabel(runs, entry.runId)).join("、")}）`,
        );
    }
    if (identityDifferences.length > 0) {
        disclaimers.push(
            "this batch mixes calibration methods: the runs cannot be ranked against each other " +
                "(marked blocked in this payload)",
        );
        blockedReasons.push(...identityDifferences.map((line) => `口径不一致: ${line}`));
    }
    // 量尺子那台机器 / CV / 整机等效吞吐：多台机器校准时取一台作代表（优先挑元信息齐全的，
    // 例如产物里那份摘要没记 CV 时，就用命令行给的那份来展示），并逐台列进 scales。
    const representative =
        calibrated.find((entry) => entry.singleThreadCvPercent !== null && entry.machine !== null) ??
        calibrated[0] ??
        null;
    const measurementHost = representative?.measurementHost ?? null;
    const preview: CalibrationPreview = {
        applied,
        retrospective,
        mode: calibrated.length === 0 ? "none" : retrospective ? "local-preview" : "as-recorded",
        scales,
        identity: reference,
        baselineMips: reference?.baselineMips ?? null,
        toolVersion: reference?.toolVersion ?? null,
        measuredAt: representative?.measuredAt ?? null,
        host:
            measurementHost === null
                ? null
                : {
                      hostname: measurementHost.hostname,
                      cpuModel: measurementHost.cpuModel,
                      cpus: measurementHost.cpus,
                      platform: measurementHost.platform,
                      arch: measurementHost.arch,
                  },
        singleThreadCvPercent: representative?.singleThreadCvPercent ?? null,
        machine: representative?.machine ?? null,
        files,
        disclaimers,
        blocked: blockedReasons.length > 0,
        blockedReasons,
    };
    for (const line of identityDifferences) notes.push(`口径不一致，拒绝相对排名：${line}`);
    if (calibrated.length > 0 && uncalibrated.length > 0) {
        notes.push(
            `本批混了「有校准」与「无校准」的运行（${uncalibrated
                .map((entry) => byRunLabel(runs, entry.runId))
                .join("、")}），拒绝相对排名`,
        );
    }
    if (retrospective) {
        notes.push(
            `折算系数由 --cpu-calibration 事后套上（${options.explicitFile ?? "?"}）：` +
                "这是本地预览，不是按新口径重跑",
        );
    }
    return { byRun, preview, notes };
}

/** 人读标签（日志里点名用）。 */
function byRunLabel(runs: readonly RunRecord[], runId: string): string {
    const run = runs.find((candidate) => candidate.runId === runId);
    return run === undefined ? runId : `${run.name} ${run.runId}`;
}

/**
 * 公式块要的那个「这一批用的系数」：
 * - 整批同一个 scale → 用它（页面只有一条公式）；
 * - 多个不同的 scale（多台机器）→ 返回 null：**不给单一表达式**，由 `lines` 里那条
 *   「每个 run 各自的 scale 见表」代替。硬凑一个数就会印出一条不对的公式。
 */
function uniformCalibration(scales: ScalesResult): ScoreFormulaCalibration | null {
    const { preview } = scales;
    if (!preview.applied || preview.identity === null) return null;
    const distinct = [...new Set(preview.scales.map((entry) => entry.cpuScale))];
    if (distinct.length !== 1) return null;
    const first = scales.byRun.values().next().value as ScaleResolution | undefined;
    const stored = first?.stored ?? null;
    return {
        cpuScale: distinct[0] as number,
        baselineMips: preview.baselineMips ?? 0,
        // 折算用的原始值：产物里记着就用它，没记（显式校准时 identity 兜底）就按
        // `cpuScale × baseline` 反推——数值等价，不会引入第二个来源。
        cpuScaleValue:
            first?.cpuScaleValue ?? (distinct[0] as number) * (preview.baselineMips ?? 0),
        toolVersion: preview.toolVersion ?? "",
        measuredAt: first?.measuredAt ?? stored?.measuredAt ?? "",
        appliedFromRunMeta: preview.mode === "as-recorded",
    };
}

/** 计分块里的折算信息（未校准 = null）。 */
function scoreCalibration(
    run: RunRecord,
    resolution: ScaleResolution | undefined,
): RunScoreCalibration | null {
    if (resolution === undefined || resolution.source === "none") return null;
    const stored = resolution.stored;
    const identity = resolution.identity;
    return {
        method: stored?.method ?? identity?.method ?? "",
        // 显示用（页面与报告都印这个）：4 位小数；`RunScore.cpuScale` 同源，只是位数更宽
        cpuScale: round(resolution.cpuScale, 4),
        baselineMips: stored?.baselineMips ?? identity?.baselineMips ?? 0,
        cpuScaleValue: resolution.cpuScaleValue,
        toolVersion: stored?.toolVersion ?? identity?.toolVersion ?? "",
        measuredAt: resolution.measuredAt,
        scope: "cpu-term-only",
        source: resolution.source === "stored" ? "stored" : "flag",
        file: resolution.file,
    } satisfies RunScoreCalibration;
}

function main(): void {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            dir: { type: "string", multiple: true },
            out: { type: "string" },
            window: { type: "string" },
            pick: { type: "string", multiple: true },
            exclude: { type: "string", multiple: true },
            "cpu-calibration": { type: "string" },
            "allow-mixed-calibration": { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
        strict: true,
    });
    if (values.help === true) {
        console.log(USAGE);
        process.exit(0);
    }

    const dirs = (values.dir ?? [join(REPO_ROOT, "data/runs"), join(REPO_ROOT, "data/claude-date")])
        .map((dir) => dir)
        .filter((dir, index, all) => all.indexOf(dir) === index);
    const outPath = values.out ?? join(REPO_ROOT, "data/perf-chart.json");
    const window = Number(values.window ?? "3");
    if (!Number.isInteger(window) || window < 1) {
        throw new Error(`--window 必须是 >= 1 的整数，收到 ${JSON.stringify(values.window)}`);
    }
    const picks = values.pick ?? [];

    const found: RunRecord[] = [];
    const skipped: string[] = [];
    const contributingDirs = new Set<string>();
    for (const dir of dirs) {
        // 同一次运行可能横跨两种布局（迁移中间态）：新布局优先，后面的同 runId 直接丢。
        const isRunsDir = basename(dir) === "runs";
        const { runs, skipped: dirSkipped } = isRunsDir
            ? collectFromRunsDir(dir)
            : collectFromFlatDir(dir);
        for (const run of runs) {
            contributingDirs.add(dir);
            if (found.some((existing) => existing.runId === run.runId)) {
                skipped.push(`${run.runId}（${dir} 里是重复的老布局副本）`);
                continue;
            }
            found.push(run);
        }
        for (const note of dirSkipped) skipped.push(`${relative(REPO_ROOT, dir)}/${note}`);
        if (!isRunsDir && runs.length > 0) {
            console.warn(
                `[gen-chart-data] 读到老布局产物（${relative(REPO_ROOT, dir)}，${runs.length} 次）；` +
                    "建议跑 bun run scripts/perf/migrate-layout.ts 迁到 data/runs/",
            );
        }
    }
    for (const note of skipped) console.warn(`[gen-chart-data] 跳过 ${note}`);

    // --exclude 按 harness id 排除（大小写不敏感）：某个 harness 退出常规批次后，它留在
    // data/runs 里的历史产物不该自己爬回图表（否则「不测它了」只在下一次手工 --pick 时成立）。
    const excluded = new Set((values.exclude ?? []).map((id) => id.toLowerCase()));
    const kept = excluded.size === 0 ? found : found.filter((run) => !excluded.has(run.harnessId.toLowerCase()));
    for (const id of excluded) {
        const hits = found.filter((run) => run.harnessId.toLowerCase() === id);
        if (hits.length > 0) {
            console.warn(
                `[gen-chart-data] --exclude ${id}：忽略 ${hits.length} 次运行（${hits.map((run) => run.runId).join(", ")}）`,
            );
        }
    }

    const selected = kept.filter((run) => picks.length === 0 || picks.includes(run.runId));
    if (picks.length > 0) {
        const missing = picks.filter((pick) => !kept.some((run) => run.runId === pick));
        if (missing.length > 0) {
            // 被 --exclude 挡掉的点名要点出来，否则「不存在」这句话会把人引偏。
            const why = missing.map((pick) =>
                found.some((run) => run.runId === pick) ? `${pick}（被 --exclude 排除）` : pick,
            );
            throw new Error(`--pick 指定的运行不存在或不是长剧本：${why.join(", ")}`);
        }
    }
    if (selected.length === 0) {
        throw new Error(
            `在 ${dirs.map((dir) => relative(REPO_ROOT, dir)).join(" / ")} 里没找到长剧本的完整产物；` +
                "先按 docs/perf-compare.md 的「长剧本端到端」跑一轮，或用 --dir 指到别的产物目录",
        );
    }

    const byHarness = new Map<string, RunRecord[]>();
    for (const run of selected) {
        const list = byHarness.get(run.harnessId);
        if (list === undefined) byHarness.set(run.harnessId, [run]);
        else list.push(run);
    }

    const chosen: RunRecord[] = [];
    for (const [harnessId, list] of [...byHarness].sort(([a], [b]) => a.localeCompare(b))) {
        const candidates = [...list].sort((a, b) => a.runId.localeCompare(b.runId));
        // 指定了 --pick 就照单全收（同一 harness 被点了多次时取最早那次，规则写死免得含糊）。
        chosen.push(picks.length > 0 ? candidates[0]! : pickMedianOfLatest(list, window));
    }

    // ---- CPU 折算：先定每个 run 用哪个系数，再算成本 ----
    // `--cpu-calibration` 显式给的（本地重算预览），或每个 run 用自己 run.json 里记的。
    const explicitPath = values["cpu-calibration"]?.trim();
    const explicit =
        explicitPath === undefined || explicitPath === ""
            ? null
            : loadCalibration(resolve(REPO_ROOT, explicitPath));
    const scales = resolveScales(chosen, explicit, {
        explicitFile: explicitPath === undefined || explicitPath === "" ? undefined : explicitPath,
    });
    for (const note of scales.notes) console.warn(`[gen-chart-data] ${note}`);
    // 混了「有校准 / 无校准」或口径不一致时，百分制分数只在同一单位里有意义 → 拒绝出图，
    // 除非调用方明确说「我就是要看这一份历史预览」（那时 payload 里挂着 blocked 标记）。
    if (!scales.preview.applied && scales.preview.mode !== "none" && values["allow-mixed-calibration"] !== true) {
        throw new Error(
            "本批的校准口径不齐，拒绝给相对排名（百分制分数只在同一单位里有意义）：\n  " +
                scales.preview.blockedReasons.join("\n  ") +
                "\n要么让这一批用同一个口径（重跑），要么用 --allow-mixed-calibration 只看各个数值" +
                "（payload 里会把 calibration.blocked 标成 true，页面据此不再给名次）",
        );
    }

    // 计分按 runId 索引（一个 harness 只留一条线，但 --pick 理论上能点同一家多次）。
    const costs = new Map<string, ResourceCost>();
    for (const run of chosen) {
        const resolution = scales.byRun.get(run.runId);
        costs.set(run.runId, costOf(run, resolution?.cpuScale ?? 1));
    }
    // 相对分用**折算后**的 CU：同批内所有 run 的口径一致（不齐的批次上面已经拒绝了），
    // 于是数值可以放在一起读。**但名次会变**：只有 CPU 项被折算、内存项不变，两项量纲不同，
    // 折算前后的排序可能不同——所以别把「折算」当成「换了个单位」来讲。
    //
    // **口径混合的批次不给分**（`calibration.blocked`，需要 --allow-mixed-calibration 才走到这里）：
    // 那时各家 CU 的单位不同，`100 × 最小 / 本次` 会给出一个看着像分数的数，而它没有意义。
    // 分数记 null，页面据此不排名次。
    const scores = scales.preview.blocked
        ? new Map<string, number>()
        : relativeScores(chosen.map((run) => ({ id: run.runId, cu: costs.get(run.runId)?.cu ?? 0 })));
    if (scales.preview.blocked) {
        console.warn("[gen-chart-data] 折算口径混合：不给百分制分数（score=null），也不排序名次");
    }

    for (const run of chosen) {
        const cost = costs.get(run.runId) as ResourceCost;
        const resolution = scales.byRun.get(run.runId);
        const candidates = byHarness.get(run.harnessId) ?? [run];
        const durations = candidates
            .map((item) => `${(item.endToEndMs / 1000).toFixed(1)}s`)
            .join(" / ");
        // 计分口径的坑要在人读的这一行里露出来，别让人自己回查 run.json。
        const notes = [
            cost.tailAppliedMs === 0 && run.harnessExitedAtMs === null ? "尾部未补（下界）" : "",
            run.childColumnPresent ? "" : "无 child 列（进程树偏低）",
            resolution?.source === "flag" ? "折算为事后套用（本地预览）" : "",
        ].filter((note) => note !== "");
        const calibrationNote =
            resolution === undefined || resolution.source === "none"
                ? ""
                : `（cpuScale ${resolution.cpuScale} × 核·秒，原始 ${rawCu(cost).toFixed(3)} CU）`;
        const score = scales.preview.blocked ? null : scores.get(run.runId) ?? 0;
        console.log(
            `[gen-chart-data] ${run.name.padEnd(11)} ${run.runId}  ` +
                `端到端 ${(run.endToEndMs / 1000).toFixed(1)}s · ${run.samples.length} 采样点 · ` +
                `统一计分 ${cost.cu.toFixed(3)} CU${calibrationNote} → ` +
                (score === null ? "（口径混合，不给分）" : `${score.toFixed(1)} 分`) +
                `（候选 ${candidates.length} 次：${durations}）` +
                (notes.length > 0 ? `  ⚠ ${notes.join("；")}` : ""),
        );
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        // 只列真正贡献了曲线的目录（空目录列进去会让人以为数据来自那儿）
        sourceDir: [...contributingDirs].map((dir) => relative(REPO_ROOT, dir)).join(" + "),
        // 下面这几段是**直接渲染到图表页上的文案**，所以跟着页面走英文（页面本身就是英文的）。
        // 别处的注释与命令行输出仍按仓库惯例用中文。
        pickRule:
            picks.length > 0
                ? `selected with --pick: ${picks.join(", ")}`
                : `each harness: the run whose end-to-end duration is the median of its last ${window} runs of the long script`,
        sampleColumns: [...SAMPLE_COLUMNS],
        // 计分口径写进 payload：图表页/报告都不该各自记一份公式——**公式来自 score.ts 的
        // scoreFormula()**，这里只把它序列化出去，页面直接印 lines，不再自己拼字符串。
        scoreFormula: scoreFormula(uniformCalibration(scales)),
        // 折算的来龙去脉（哪把尺子、量于何时、是事后套的还是产物自带的）。
        calibration: scales.preview,
        runs: chosen.map((run) => {
            const cost = costs.get(run.runId) as ResourceCost;
            const resolution = scales.byRun.get(run.runId);
            return {
                id: run.harnessId,
                name: run.name,
                runId: run.runId,
                command: run.commandLine,
                script: run.script,
                endToEndMs: run.endToEndMs,
                samplingWindowMs: run.samplingWindowMs,
                requests: run.requests,
                segments: run.segments,
                requestMarksMs: run.requestMarksMs,
                label: run.label,
                // 这次运行那台机器的快照（老布局没有）——页面据此说明「这个读数来自哪台机器」。
                host: run.host ?? null,
                score: serializeCost(
                    run,
                    cost,
                    scales.preview.blocked ? null : scores.get(run.runId) ?? 0,
                    scoreCalibration(run, resolution),
                ),
                samples: toRows(run.samples),
            };
        }),
    };

    const json = JSON.stringify(payload);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json + "\n");
    console.log(
        `[gen-chart-data] 已写入 ${relative(REPO_ROOT, outPath)}（${(json.length / 1024).toFixed(0)}KB，` +
            `${payload.runs.length} 条曲线）`,
    );
    console.log(
        "[gen-chart-data] 看图：cd " +
            REPO_ROOT +
            " && python3 -m http.server 8080 → http://localhost:8080/docs/perf-chart.html",
    );
}

// 只有直接执行才跑 main（测试 import 本文件时不该有副作用）。
if (import.meta.main) main();
