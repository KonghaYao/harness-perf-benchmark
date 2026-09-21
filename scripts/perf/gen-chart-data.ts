#!/usr/bin/env bun
/**
 * 汇总「长剧本」压测产物 → 图表数据 JSON（配 docs/perf-chart.html 画折线图）。
 *
 * 只挑长剧本那一组（`data/scenarios/long-run*.json`，100 轮 × 4KB、跑到自然结束）：每个
 * harness 一条曲线，x 为相对时间（采样起点算 0），y 为 CPU 或 RSS。
 *
 * 除了曲线，每个 harness 给一份 CU 2.0 Beta **绝对分**（定义只在 score.ts 的 CU2_FORMULA）：
 * 固定预算下把时长、CPU、内存与 RSS 峰值四项取最大负担折成 0~100（50 分 = 压在预算上）。
 * 计分在这里**现算**而不是读 run.json 的 `cost`：`cost.cu` 是旧面积、不是新分数，而
 * samples.csv 一律都在——现算才能让新老产物同口径；缺关键证据的（老产物没记退出时刻、
 * 缺 child 列等）一律 score = null，不拿 0 或 100 糊过去。
 *
 * 数据来源是**一次运行一个目录**的新布局：`<dir>/<harness>/<runId>/`，身份、时长、分段、
 * 摘要都从 `run.json` 读（不再拿正则扒中文日志）；曲线本体仍来自 `samples.csv`。
 * 顺带兼容老的平铺布局（`<runId>-perf.log` 那套，见 legacy-run.ts），迁完就该删掉那条分支。
 *
 * 取哪一次运行（一个 harness 只给一条线）：在该 harness **最新一组相互兼容的重复运行**里，
 * 逐次算 CU 2.0 分数，取分数中位的**那一次真实运行**出曲线（不是各项各自取中位再拼）。
 * 兼容看的是**计划条件**（label、scenario SHA、采样间隔、harness 命令/环境/二进制等，
 * 见 planConditions）：两边都认识的键必须一致，一方不知道的键按通配——所以「最新那次缺 CSV，
 * 或早退到连 harness.env 都没写」不会把它挤出小组，它照样占名额、把聚合判成 null；
 * 而不同 label 或不同真实 SHA 依然各成一组。本地 mock 端口每轮都变，按记录规范化掉。
 * 最新一组凑不满 window 次就不给聚合分（score = null，并标出实际次数）；
 * 要单看某一次用 `--pick <runId>` 显式指定。
 *
 *   bun run scripts/perf/gen-chart-data.ts                 # → data/perf-chart.json
 *   bun run scripts/perf/gen-chart-data.ts --pick 20260919-140227
 *   bun run scripts/perf/gen-chart-data.ts --window 3      # 最新兼容组凑满 3 次才算数
 *
 * 看图的本地服务（CORS 关系不能直接 file:// 打开）：
 *   cd <仓库根> && python3 -m http.server 8080
 *   → http://localhost:8080/docs/perf-chart.html
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "./config";
import { displayName } from "./harness-id";
import { parseLegacyPerfLog } from "./legacy-run";
import { csvHasColumn, parseSamplesCsv, type ProcessSample } from "./sampler";
import {
    CU2_FORMULA,
    cu2Score,
    resourceCost,
    resourcePeaks,
    segmentCosts,
    type Cu2Score,
    type ResourceCost,
} from "./score";

const USAGE = `汇总长剧本压测产物 → 图表数据 JSON

用法:
  bun run scripts/perf/gen-chart-data.ts [选项]

选项:
  --dir <path>       产物目录，可重复（默认 data/runs，另自动带上仍在的老布局 data/claude-date）
  --out <path>       输出 JSON（默认 data/perf-chart.json；data/ 已 gitignore）
  --window <n>       最新兼容组凑满 n 次才给聚合分（默认 3；少于 n 次时 score = null）
  --pick <runId>     显式指定用哪一次运行（可重复；给了就按它出，并标明实际次数）
  --exclude <id>     按 harness id 排除，可重复（大小写不敏感）。某个 harness 退出常规批次后
                     用它把留在 data/runs 里的历史产物挡在图表外
  -h, --help         显示本帮助

产物 JSON 的 samples 行 = [elapsed_ms, cpu_pct, rss_kb, tree_cpu_pct, tree_rss_kb, procs]，
对应 samples.csv 的列序（去掉了 ts 列）；主进程与进程树两套口径都在里面，页面按钮切着看。

每个 harness 的 score 块（公式、预算与说明只在 scripts/perf/score.ts 一处）：
  score.score        CU 2.0 绝对分（0~100，越高越好，50 = 固定预算）；不可得时是 null
  score.valid        false 表示这一份没资格出分，原因在 score.invalidReasons
  score.metrics      T 端到端秒 / C 核·秒 / A GiB·秒 / P RSS 峰值 GiB（实测值）
  score.burdens      四项各自的预算倍数；score.burden 是它们的最大值（= L）
  score.tailGapMs    末拍 → harness 退出的实测空档；超过 500ms 直接不可评分
  repetitions        本次聚合用了几次真实运行、逐次分数、代表 runId、被忽略的运行
  cu / cpuCu / …     旧 CU 面积（CPU 与内存 1:1 积分）与 peaks、segments：**只作兼容展示**
                     与旧页面读取，不参与 CU 2.0 排名

读到这些字段说明这一份要当心：
  repetitions.actualCount < window             最新兼容组没凑满，score = null
  repetitions.validCount < actualCount         组内有失败/不可评分的运行（不剔除，直接判 null）
  invalidReasons 含 tail-gap-exceeds-limit     末拍与退出空档超过 500ms，CU 2.0 不给分
  childColumnPresent=false                     采样没有 child_cpu_pct 列 → 不可评分
  requests 是 mock 请求数（含辅助请求），**不是工具轮数**，不能据此声称跑满 100 轮
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
    /** 端到端时长；老产物没写或写不出来时是 null（这一类不可评分）。 */
    endToEndMs: number | null;
    /** run.json 里的结果判定；老布局由日志还原（不可评分）。 */
    status: string | null;
    /** 采样是否带进程树（老布局未知，记 null）。 */
    withTree: boolean | null;
    /** 采样后端：`ps` 拿不到已回收后代计数器，不满足 CU 2.0 的证据要求。 */
    samplingBackend: string | null;
    /** 剧本 SHA（前 16 位）；老产物为 null，无法证明与别的运行是同一份剧本。 */
    scenarioSha: string | null;
    /**
     * **计划条件**（身份 + 跑之前就定下的配置），只在本次运行真的记下来时才进表；
     * 比对规则见 `conditionsAgree`：两边都认识的键必须一致，一方不知道的键按通配。
     *
     * 刻意**不含**证据完整性（缺 CSV 导致的 childColumnPresent=false、早退路径没写上的
     * harness.env、实际回退到 ps 的后端等）：那些是「这一份能不能出分」，
     * 不是「这一份是不是同一种测法」——放进来会正好把失败剔除出组，让更早的完整组捡回分数。
     */
    conditions: Record<string, string>;
    /** 读取时发现的硬伤（缺 CSV、坏行、非 0 退出等），直接让 CU 2.0 不可评分。 */
    invalidReasons: string[];
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
     * **这一张图上混了不同批次的运行**——不同批次的机器状态、后台负载、剧本都可能不同；
     * 它也参与重复运行分组：**不同 label 的运行绝不当作同一组的三次**。
     */
    label: string | null;
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

/**
 * 读一次 samples.csv：原始采样点（全精度）、「表头带不带 child_cpu_pct」、以及**读到的硬伤**。
 *
 * 解析器会把缺列/空单元格按 0 补上（它的职责是尽量读出来），但 0 与「没读到」是两码事：
 * 空单元格、非数字、缺必需列都记成 invalidReasons，别让补出来的 0 变成一份看着正常的低读数。
 * 缺文件也走这条（README 与测试都依赖「产出的记录数与目录里的运行数一致」）。
 */
function readCsvSamples(csvPath: string): {
    samples: ProcessSample[];
    childColumnPresent: boolean;
    invalidReasons: string[];
} {
    if (!existsSync(csvPath)) {
        return { samples: [], childColumnPresent: false, invalidReasons: ["missing-csv"] };
    }
    const text = readFileSync(csvPath, "utf8");
    const childColumnPresent = csvHasColumn(text, "child_cpu_pct");
    const lines = text.trim().split("\n");
    const header = (lines[0] ?? "").split(",").map((name) => name.trim());
    const malformed = lines
        .slice(1)
        .filter((line) => line.trim() !== "")
        .some((line) => {
            const cells = line.split(",");
            return header.some((name, index) => {
                const cell = cells[index]?.trim();
                if (cell === undefined || cell === "") return true;
                return name === "ts" ? Number.isNaN(Date.parse(cell)) : !Number.isFinite(Number(cell));
            });
        });
    try {
        return {
            samples: parseSamplesCsv(text),
            childColumnPresent,
            invalidReasons: malformed ? ["malformed-csv"] : [],
        };
    } catch {
        return { samples: [], childColumnPresent, invalidReasons: ["invalid-csv-columns"] };
    }
}

/**
 * 末拍到 harness 退出之间的空档（毫秒）——旧面积按末尾几拍的速率把它补上。
 *
 * 采样循环在读到「进程已不在」时就停，最后一拍到真正退出之间固定还有约一个采样间隔
 * （实测 ≈100ms）没记账；对 pi 这种 1.5s 就跑完的快 harness 相当于漏计 ~7%。
 * 老产物没记 `harnessExitedAtMs` 时返回 0，**那一份旧面积是下界**（由 `tailAppliedMs: 0`
 * + `tailGapKnown: false` 标出来）；CU 2.0 遇到空档过大则直接判无效（见 cu2Score）。
 */
export function tailGapMs(run: RunRecord): number {
    if (run.harnessExitedAtMs === null || run.samples.length === 0) return 0;
    const last = run.samples[run.samples.length - 1] as ProcessSample;
    return Math.max(0, run.harnessExitedAtMs - last.ts);
}

/** 一次运行的资源成本（进程树口径，含尾部补齐）。 */
export function costOf(run: RunRecord): ResourceCost {
    return resourceCost(run.samples, { tailMs: tailGapMs(run) });
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
        cpuSeconds: round(cost.cpuSeconds, 6),
        gbSeconds: round(cost.gbSeconds, 6),
        sampleCount: cost.sampleCount,
    };
}

/** 一次运行的 CU 2.0 输入（读取端有的证据全摊在这里，判断只在 score.ts 做）。 */
function cu2InputOf(run: RunRecord) {
    return {
        status: run.status,
        endToEndMs: run.endToEndMs,
        harnessExitedAtMs: run.harnessExitedAtMs,
        withTree: run.withTree,
        samplingBackend: run.samplingBackend,
        childColumnPresent: run.childColumnPresent,
        samples: run.samples,
        requests: run.requests,
        invalidReasons: run.invalidReasons,
    };
}

/**
 * 逐次评估一次运行：`raw` 是**未舍入**的 CU 2.0 结果，`score` 是入 payload 的展示版。
 *
 * 分开是为了让中位选择用真实数值（见 selectRuns）：展示版把分数收敛到两位小数，
 * 拿它排序会在 80.001 / 80.002 / 80.004 这种差距上退化成「按 runId 选」。
 */
function evaluateRun(run: RunRecord): { run: RunRecord; raw: Cu2Score; score: RunScore } {
    const raw = cu2Score(cu2InputOf(run));
    return { run, raw, score: serializeCost(run, costOf(run), raw) };
}

/**
 * 计分块（payload 里每个 harness 一份）：CU 2.0 的每一项都摊开写，图表页只负责显示，
 * 不自己记公式也不自己算——公式、预算、有效性判定都只有 score.ts 一处。
 *
 * 旧 CU 面积（`cu` 及其明细）与 `segments`、`peaks` 一起留着：它们答的是「CPU/内存各烧了
 * 多少、哪一段烧的」，是**历史兼容字段**，不再参与排名。
 */
export function serializeCost(run: RunRecord, cost: ResourceCost, raw?: Cu2Score): RunScore {
    const marks = run.requestMarksMs;
    const peaks = resourcePeaks(run.samples);
    const cu2 = raw ?? cu2Score(cu2InputOf(run));
    const segments =
        marks === null
            ? null
            : (() => {
                  // 分段不做尾部外推（那是整个窗口的性质，塞进某一段会重复计），所以 tailMs 不传。
                  const parts = segmentCosts(run.samples, marks);
                  return {
                      startup: segmentRow(parts.startup),
                      span: segmentRow(parts.span),
                      tail: segmentRow(parts.tail),
                  };
              })();
    return {
        ...cu2,
        // payload 里的数字统一收敛到固定小数位（浮点噪声不进 JSON，页面也不用自己格式化）。
        score: cu2.score === null ? null : round(cu2.score, 2),
        tailGapMs: cu2.tailGapMs === null ? null : round(cu2.tailGapMs, 0),
        metrics:
            cu2.metrics === null
                ? null
                : {
                      timeSeconds: round(cu2.metrics.timeSeconds, 3),
                      cpuSeconds: round(cu2.metrics.cpuSeconds, 6),
                      memoryGiBSeconds: round(cu2.metrics.memoryGiBSeconds, 6),
                      peakGiB: round(cu2.metrics.peakGiB, 6),
                  },
        burdens:
            cu2.burdens === null
                ? null
                : {
                      time: round(cu2.burdens.time, 6),
                      cpu: round(cu2.burdens.cpu, 6),
                      memory: round(cu2.burdens.memory, 6),
                      peak: round(cu2.burdens.peak, 6),
                  },
        burden: cu2.burden === null ? null : round(cu2.burden, 6),
        cu: round(cost.cu, 6),
        cpuCu: round(cost.cpuCu, 6),
        memoryCu: round(cost.memoryCu, 6),
        cpuSeconds: round(cost.cpuSeconds, 6),
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
    cpuSeconds: number;
    gbSeconds: number;
    sampleCount: number;
}

/**
 * 计分块：`score` 等字段是 CU 2.0（`Cu2Score`，绝对分，可能是 null）；
 * 其余为历史兼容的旧 CU 面积与展示用明细。
 */
export interface RunScore extends Cu2Score {
    /** 旧 CU 面积（进程树 CPU 与内存 1:1 积分 + 尾部补齐）；**不参与新排名**。 */
    cu: number;
    cpuCu: number;
    memoryCu: number;
    cpuSeconds: number;
    gbSeconds: number;
    /** = `gbSeconds × 1024`：报告与页面按 MB·秒 显示（数值比 GB·秒 直观），口径不变。 */
    mbSeconds: number;
    rootCpuSeconds: number;
    childCpuSeconds: number;
    childCpuFrom: "counter" | "sampled";
    /** 实际补进来的尾部时长；是否知道退出时刻看 `tailGapKnown`。 */
    tailAppliedMs: number;
    /** 是否知道「末拍 → 退出」的空档（老布局 / 旧 run.json 为 false）。 */
    tailGapKnown: boolean;
    samplingMs: number;
    sampleCount: number;
    /** samples.csv 是否带 child_cpu_pct 列；false 表示进程树口径偏低。 */
    childColumnPresent: boolean;
    /** 峰值原始量：RSS 峰值参与 CU 2.0 的 P 项，其余作展示。 */
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
            const scenario = meta.scenario as
                | { name?: string; relPath?: string; path?: string; sha256?: string }
                | undefined;
            const scriptName = scenario?.name ?? "";
            if (!isLongRunScript(scriptName)) continue;
            // 跑失败/没跑完的运行**照样收进来**：它占重复运行的名额，不能被悄悄剔掉后
            // 拿更早的成功运行充数（那种「中位数」是挑出来的，不是测出来的）。
            const csvPath = join(runDir, "samples.csv");
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
            const script = scenario?.relPath ?? scenario?.path ?? scriptName;
            const label = typeof meta.label === "string" ? meta.label : null;
            const csv = readCsvSamples(csvPath);
            const sampling = meta.sampling as { withTree?: boolean | null; backend?: string } | undefined;
            const exit = meta.exit as { code?: number | null; signal?: string | null } | undefined;
            runs.push({
                status: typeof meta.status === "string" ? meta.status : null,
                withTree: sampling?.withTree ?? null,
                samplingBackend: sampling?.backend ?? null,
                scenarioSha: scenario?.sha256 ?? null,
                conditions: planConditions(meta, { harnessId, label, script, runId }),
                invalidReasons: [
                    ...csv.invalidReasons,
                    // error 有值就是这次跑挂了（早退路径也一样），别只看 status 文案。
                    ...(meta.error ? ["run-error"] : []),
                    ...(exit?.code === 0 && !exit.signal ? [] : ["unsuccessful-exit"]),
                ],
                runId,
                harnessId,
                name: displayName(harnessId),
                commandLine: harness?.commandLine ?? null,
                script,
                endToEndMs: duration?.endToEndMs ?? null,
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
        // 老布局没有 status 之外的证据，且一律缺「退出时刻/child 列/SHA」——照收，
        // 由 cu2Score 判成不可评分（老记录读得进来，但别指望它出分）。
        const csvPath = join(dir, `${runId}-samples.csv`);
        const csv = readCsvSamples(csvPath);
        const script = relative(REPO_ROOT, parsed.scriptPath).startsWith("..")
            ? parsed.scriptPath
            : relative(REPO_ROOT, parsed.scriptPath);
        runs.push({
            status: parsed.status,
            withTree: null,
            samplingBackend: parsed.samplingBackend,
            scenarioSha: null,
            // 老布局没记计划配置，只留身份与剧本；SHA 未知 → 用 runId 占位，
            // 于是老记录各自成组、凑不满 window（读得进来但不冒充重复运行）。
            conditions: planConditions(
                {
                    scenario: { sha256: null },
                    sampling: { intervalMs: parsed.samplingIntervalMs, withTree: null },
                },
                { harnessId: parsed.harnessId, label: null, script, runId },
            ),
            invalidReasons: csv.invalidReasons,
            runId,
            harnessId: parsed.harnessId,
            name: displayName(parsed.harnessId),
            commandLine: parsed.commandLine,
            script,
            endToEndMs: parsed.endToEndMs,
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
            // 老布局没记 harness 退出时刻、也没有 child 列 → CU 2.0 不可评分（旧面积仍按 0 补尾）。
            harnessExitedAtMs: null,
            samples: csv.samples,
            childColumnPresent: csv.childColumnPresent,
            label: null,
        });
    }
    return { runs, skipped };
}

/**
 * 本地 mock 端点端口规范化：**只**替换「本地地址 + 端口」这种形状的已知端口
 * （`127.0.0.1:43117`、`localhost:43117`、`[::1]:43117`、`0.0.0.0:43117`），
 * 别的数字一个都不动。
 *
 * 为什么必须做：本地跑批每一轮都换端口，而端口会渗进启动命令（codex 的
 * `-c model_providers…base_url=http://127.0.0.1:<port>/v1`）与注入环境变量
 * （`ANTHROPIC_BASE_URL`、`GOOGLE_GEMINI_BASE_URL`…）。不规范化，同一个计划的三次
 * 会各成一组，永远凑不满 window。
 */
function normalizeLocalPorts(value: unknown, port: number | null): unknown {
    if (port === null || !Number.isInteger(port) || port <= 0) return value;
    if (typeof value === "string") {
        return value.replace(
            /(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)/g,
            (all, host: string, digits: string) =>
                Number(digits) === port ? `${host}:<mock-port>` : all,
        );
    }
    if (Array.isArray(value)) return value.map((item) => normalizeLocalPorts(item, port));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
                key,
                normalizeLocalPorts(item, port),
            ]),
        );
    }
    return value;
}

/**
 * 展平成「点路径 → 字符串」的条件表：**null / undefined 一律视为未知，不入表**。
 *
 * 未知不入表是这套分组的关键（早退路径的 `harness.env: null`、老记录没写的字段）：
 * 少知道一件事的运行仍然属于同一组，只是它自己不可评分——而不是被拆出去。
 */
function flattenKnown(value: unknown, prefix: string, out: Record<string, string>): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => flattenKnown(item, `${prefix}[${index}]`, out));
        return;
    }
    if (typeof value === "object") {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            flattenKnown(item, prefix === "" ? key : `${prefix}.${key}`, out);
        }
        return;
    }
    out[prefix] = String(value);
}

/**
 * 这次运行的**计划条件**：跑之前就定下、且 run.json 真的记下来的那些值。
 *
 * 刻意排除的字段：
 *   - `sampling.backend`：运行时回退（rusage 不可用 → ps）是**证据能力**，不是计划；
 *     留着它会把「这次没采到 child 计数器」的运行拆出去，让更早的完整组白捡分数。
 *     这一份照样留在组里，由 cu2Score 判 `missing-child-counter`；
 *   - `mock.port` 与命令/环境里的本地端点端口（每轮都变，见 normalizeLocalPorts）；
 *   - `loadAvg*`（宿主瞬时负载，恰恰是要被测的噪声）。
 * harness 二进制的 size/mtime 留着——debug 与 release 构建读数不可比。
 */
function planConditions(
    meta: Record<string, unknown>,
    identity: { harnessId: string; label: string | null; script: string; runId: string },
): Record<string, string> {
    // 缺字段一律当未知（老布局只给得出零星几项），不要在这里炸。
    const host = (meta.host ?? null) as Record<string, unknown> | null;
    const mock = (meta.mock ?? null) as { port?: unknown; exhausted?: unknown } | null;
    const sampling = (meta.sampling ?? null) as Record<string, unknown> | null;
    const port = typeof mock?.port === "number" ? mock.port : null;
    const hostStatic =
        host === null
            ? null
            : Object.fromEntries(Object.entries(host).filter(([key]) => !key.startsWith("loadAvg")));
    const samplingPlan =
        sampling === null
            ? null
            : Object.fromEntries(
                  Object.entries(sampling).filter(([key]) => key !== "backend"),
              );
    const known: Record<string, string> = {};
    flattenKnown(
        {
            harnessId: identity.harnessId,
            // label 的「没带」是**已知事实**（开跑时就写进 run.json），不是未知：
            // 空串占位，于是「没打 label 的运行」与「label=batch-a 的运行」不会混成一组。
            label: identity.label ?? "",
            script: identity.script,
            // SHA 未知时用 runId 占位：**没有 SHA 就无法证明是同一份剧本**，宁可各自成组。
            scenarioSha: (meta.scenario as { sha256?: unknown } | undefined)?.sha256
                ? String((meta.scenario as { sha256?: unknown }).sha256)
                : `unknown:${identity.runId}`,
            harness: normalizeLocalPorts(meta.harness, port),
            sampling: normalizeLocalPorts(samplingPlan, port),
            limits: meta.limits,
            prompt: meta.prompt,
            exhausted: mock?.exhausted ?? null,
            host: hostStatic,
        },
        "",
        known,
    );
    return known;
}

/** 两份条件在**两边都知道的键**上是否一致（一方不知道的键按通配）。 */
function conditionsAgree(known: Record<string, string>, conditions: Record<string, string>): boolean {
    for (const [key, value] of Object.entries(conditions)) {
        const expected = known[key];
        if (expected !== undefined && expected !== value) return false;
    }
    return true;
}

/**
 * 按计划条件分组（新→旧遍历）：能并入已有组就并入，否则新开一组。
 *
 * 组内已知条件只增不改——后加入者才知道的键补进来（例如早退的那次没写 env，
 * 后面几次都写了，就用它们的 env 继续约束后面的成员），冲突的键本来就进不来。
 * 于是「最新那次失败（缺 CSV / 早退）」留在组里把聚合判成 null，
 * 而不同 label 或不同真实 SHA 的运行依然各成一组、不会互相污染。
 */
function groupByConditions(ordered: readonly RunRecord[]): RunRecord[][] {
    const groups: { known: Record<string, string>; runs: RunRecord[] }[] = [];
    for (const run of ordered) {
        const group = groups.find((candidate) => conditionsAgree(candidate.known, run.conditions));
        if (group === undefined) {
            groups.push({ known: { ...run.conditions }, runs: [run] });
            continue;
        }
        for (const [key, value] of Object.entries(run.conditions)) group.known[key] = value;
        group.runs.push(run);
    }
    return groups.map((group) => group.runs);
}

/** 一次选中结果的元信息：这一条曲线到底是几次运行算出来的、哪些没被选中。 */
export interface RunRepetitions {
    /** `latest-compatible`：默认按最新兼容组；`explicit-pick`：--pick 指定。 */
    mode: "latest-compatible" | "explicit-pick";
    /** 规则要求几次（默认 3）；`explicit-pick` 时等于实际点名的次数。 */
    requestedCount: number;
    /** 实际参与聚合的次数（不剔除失败，失败也算一次）。 */
    actualCount: number;
    /** 其中可评分的次数。 */
    validCount: number;
    /** 次数是否满足规则（否则聚合分是 null）。 */
    complete: boolean;
    /** 参与聚合的运行（新→旧）。 */
    runIds: string[];
    /** 逐次 CU 2.0 分数，与 `runIds` 一一对应（不可评分为 null）。 */
    scores: (number | null)[];
    /** 逐次不可评分原因（可评分的为空数组）。 */
    invalidReasonsByRun: { runId: string; reasons: string[] }[];
    /** 同 harness 存在但**没被选中**的运行：新单跑覆盖不了旧的完整组，就在这里现身。 */
    ignoredRunIds: string[];
    /** 出曲线的那一次真实运行（分数中位对应的那一次，不是拼出来的）。 */
    representativeRunId: string;
    /** 取中位的规则：偶数次取**较低**中位分对应的那一次，写死免得含糊。 */
    medianRule: "lower-score-median";
}

/** 选中结果：代表运行 + 它的 CU 2.0 分 + 聚合过程。 */
export interface RunSelection {
    run: RunRecord;
    score: RunScore;
    repetitions: RunRepetitions;
}

/**
 * 在一个 harness 的候选运行里选一次真实运行出曲线。
 *
 * 规则（默认 `explicit = false`）：按计划条件分组（见 groupByConditions）→ 取**最新**一个
 * 凑满 `window` 次的小组（都凑不满就取最新那组，并标成不完整）→ 组内每次各自算 CU 2.0
 * → 取分数中位对应的那一次真实运行。
 *
 * 为什么不是「时长中位」：时长只是 L 里的四项之一，且同一组内时长中位那次未必是负担中位。
 * 为什么失败的不剔除：剔了就成了「挑成功的那几次取中位」，分数只反映最好情况；缺 CSV、
 * 早退没写 env 这类**证据缺失**也不会把运行挤出小组（那是「不可评分」，不是「另一种测法」）。
 * 为什么排序用**未舍入**分数：入 payload 时分数收敛到两位小数，若拿它排序，
 * 80.001 / 80.004 / 80.002 会因为并列而按 runId 选错代表运行（曲线跟着选错）。
 * 为什么按组而不是全局：`oc2-cold` 这类新标签的单跑不能盖掉老的完整组，也不能与它拼批次。
 */
export function selectRuns(runs: RunRecord[], window = 3, explicit = false): RunSelection {
    if (runs.length === 0) throw new Error("没有候选运行");
    if (!Number.isInteger(window) || window < 1) throw new Error(`window 必须是 >= 1 的整数：${window}`);
    const ordered = [...runs].sort((a, b) => b.runId.localeCompare(a.runId));

    const groups = groupByConditions(ordered);
    if (explicit && groups.length !== 1) {
        // --pick 点了同一家的多次运行，但它们计划条件/SHA 不同：拼起来没有意义，直接报错。
        throw new Error("--pick 点的运行之间 label、scenario SHA 或计划条件不一致，不能作为一组重复运行");
    }
    const group = explicit
        ? ordered
        : // 最新一个完整组优先；没有完整组就退回最新那组，把「不完整」如实标出来。
          (groups.find((items) => items.length >= window) ?? groups[0]!);
    const recent = explicit ? group : group.slice(0, window);

    const evaluated = recent.map(evaluateRun);
    const invalid = evaluated.filter((item) => !item.raw.valid);
    // 偶数次取较低中位（`floor((n-1)/2)`）——两次里选较差的那次，宁可保守。
    const byScore = [...evaluated].sort(
        (a, b) => (a.raw.score ?? -1) - (b.raw.score ?? -1) || a.run.runId.localeCompare(b.run.runId),
    );
    const representative = invalid[0] ?? byScore[Math.floor((byScore.length - 1) / 2)]!;

    const complete = explicit || recent.length === window;
    const score: RunScore = { ...representative.score };
    if (invalid.length > 0 || !complete) {
        // 组内有失败/无效的，或次数不够：不给聚合分（null），并把原因如实列出来。
        score.score = null;
        score.valid = false;
        score.invalidReasons = [
            ...new Set([
                ...score.invalidReasons,
                ...(invalid.length > 0 ? ["invalid-repeat"] : []),
                ...(!complete ? ["insufficient-repeats"] : []),
            ]),
        ];
    }
    return {
        run: representative.run,
        score,
        repetitions: {
            mode: explicit ? "explicit-pick" : "latest-compatible",
            requestedCount: explicit ? recent.length : window,
            actualCount: recent.length,
            validCount: evaluated.length - invalid.length,
            complete,
            runIds: recent.map((run) => run.runId),
            // 展示值是入 payload 的舍入值；中位选择用的是未舍入值（见函数头），
            // 所以极端并列时「scores 里的中位」未必等于代表运行那一项。
            scores: evaluated.map((item) => item.score.score),
            invalidReasonsByRun: evaluated.map((item) => ({
                runId: item.run.runId,
                reasons: item.raw.invalidReasons,
            })),
            ignoredRunIds: ordered.filter((run) => !recent.includes(run)).map((run) => run.runId),
            representativeRunId: representative.run.runId,
            medianRule: "lower-score-median",
        },
    };
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
        // 一次运行的目录布局可以不按 --dir 的字面名判断（测试与临时目录常是任意名字），
        // 所以两种布局都扫：同一家 harness 的同名 runId 只留先扫到的那个（新布局优先）。
        const modern = collectFromRunsDir(dir);
        const legacy = collectFromFlatDir(dir);
        const runs = [...modern.runs, ...legacy.runs];
        const dirSkipped = [...modern.skipped, ...legacy.skipped];
        for (const run of runs) {
            contributingDirs.add(dir);
            // 同一 harness 下同名 runId 才算同一份产物（不同 harness 撞 id 是正常的）。
            if (found.some((existing) => existing.harnessId === run.harnessId && existing.runId === run.runId)) {
                skipped.push(`${run.harnessId}/${run.runId}（${dir} 里是重复的老布局副本）`);
                continue;
            }
            found.push(run);
        }
        for (const note of dirSkipped) skipped.push(`${relative(REPO_ROOT, dir)}/${note}`);
        if (legacy.runs.length > 0) {
            console.warn(
                `[gen-chart-data] 读到老布局产物（${relative(REPO_ROOT, dir)}，${legacy.runs.length} 次）；` +
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

    const chosen: RunSelection[] = [];
    for (const harnessId of [...byHarness.keys()].sort((a, b) => a.localeCompare(b))) {
        const list = byHarness.get(harnessId) as RunRecord[];
        // --pick 点了名：按它出（同一次运行只点多次时也照办），实际次数写进 repetitions。
        chosen.push(selectRuns(list, window, picks.length > 0));
    }

    for (const { run, score, repetitions } of chosen) {
        // 口子要在人读的这一行里露出来，别让人自己回查 run.json。
        const notes = [
            repetitions.complete ? "" : `兼容组只凑到 ${repetitions.actualCount} 次（规则要 ${repetitions.requestedCount}）`,
            score.valid ? "" : `不可评分：${score.invalidReasons.join("、")}`,
            repetitions.ignoredRunIds.length > 0 ? `未选运行 ${repetitions.ignoredRunIds.join(", ")}` : "",
        ].filter((note) => note !== "");
        console.log(
            `[gen-chart-data] ${run.name.padEnd(11)} ${run.runId}  ` +
                `${CU2_FORMULA.label} ${score.score === null ? "null" : `${score.score.toFixed(1)} 分`}` +
                `（实际 ${repetitions.actualCount} 次，${repetitions.validCount} 次有效：` +
                `${repetitions.runIds.join(" / ")}）` +
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
                : `each harness: the run whose CU 2.0 score is the median of the latest ${window} compatible repeats of the long script`,
        sampleColumns: [...SAMPLE_COLUMNS],
        // 公式、预算、方向与适用说明都从 score.ts 的 CU2_FORMULA 原样带出：
        // 图表页/报告/日志都不许各自记一份（改口径就是改那一个常量）。
        scoreFormula: CU2_FORMULA,
        runs: chosen.map(({ run, score, repetitions }) => ({
            id: run.harnessId,
            name: run.name,
            runId: run.runId,
            command: run.commandLine,
            script: run.script,
            scenarioSha: run.scenarioSha,
            status: run.status,
            endToEndMs: run.endToEndMs,
            samplingWindowMs: run.samplingWindowMs,
            requests: run.requests,
            segments: run.segments,
            requestMarksMs: run.requestMarksMs,
            label: run.label,
            score,
            repetitions,
            samples: toRows(run.samples),
        })),
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
