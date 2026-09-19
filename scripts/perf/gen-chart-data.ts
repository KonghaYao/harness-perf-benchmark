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
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "./config";
import { displayName } from "./harness-id";
import { parseLegacyPerfLog } from "./legacy-run";
import { csvHasColumn, parseSamplesCsv, type ProcessSample } from "./sampler";
import {
    CU_COEFFICIENTS,
    relativeScores,
    resourceCost,
    resourcePeaks,
    segmentCosts,
    type ResourceCost,
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
  -h, --help         显示本帮助

产物 JSON 的 samples 行 = [elapsed_ms, cpu_pct, rss_kb, tree_cpu_pct, tree_rss_kb, procs]，
对应 samples.csv 的列序（去掉了 ts 列）；主进程与进程树两套口径都在里面，页面按钮切着看。

每个 harness 还带一个 score 块（口径与系数只在 scripts/perf/score.ts 一处）：
  - cu / score       把「进程树 CPU × 时长」与「内存 × 时长」按 **1:1**（1 核·秒 = 1 GB·秒）
                     混成一个标量，再折成「100 × 本批次最小 CU / 本次 CU」的百分制（最优 100 分）；
  - peaks            进程树 RSS / CPU 的整个窗口最大值，不折算成分数（绝对量可直接横比）；
                     它答的是「最坏一刻要占多少」，与 cu 的「总共烧多少」互补。
分数**只在同一批次内可比**。

读到这些字段说明这一份要当心：
  tailAppliedMs=0 且 tailGapKnown=false   尾部空档补不了（老产物没记退出时刻）→ CU 是下界
  childColumnPresent=false                采样没有 child_cpu_pct 列 → 进程树口径偏低
`;

/**
 * 只认长剧本那组：`long-run.json`（peri / opencode / Claude Code）与各家的
 * `long-run-<harness>.json`（codex / pi / dsh / minimax-code，工具形状各家不同）。
 * harness 名里可以带 `-`（`minimax-code`），所以后缀不是「一串小写字母」而是「小写与连字符」。
 */
const LONG_RUN_SCRIPT = /^long-run(-[a-z][a-z-]*)?\.json$/;

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

/**
 * 计分块（payload 里每个 harness 一份）：公式的每一项都摊开写，图表页只负责显示，
 * 不自己记公式也不自己算——口径只有 score.ts 一处。
 *
 * 除了 CU（面积，含时长），再给一份**峰值**（压力口径，不折算）：它答的是「最坏一刻要占
 * 多少」，与时长、比例都无关，直接从原始采样点取。
 */
export function serializeCost(run: RunRecord, cost: ResourceCost, score: number): RunScore {
    const marks = run.requestMarksMs;
    const peaks = resourcePeaks(run.samples);
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
        score: round(score, 1),
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

/** 计分块：`100 × 本批次最小 CU / 本次 CU`，最优 100 分。 */
export interface RunScore {
    score: number;
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
    /** 实际补进来的尾部时长；0 表示这一份是下界（老产物没记退出时刻）。 */
    tailAppliedMs: number;
    /** 是否知道「末拍 → 退出」的空档（老布局 / 旧 run.json 为 false）。 */
    tailGapKnown: boolean;
    samplingMs: number;
    sampleCount: number;
    /** samples.csv 是否带 child_cpu_pct 列；false 表示进程树口径偏低。 */
    childColumnPresent: boolean;
    /** **压力口径**（峰值）：整个窗口的最大值，不折算成分数（MB 与 % 本来就能横比）。 */
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

    // 计分按 runId 索引（一个 harness 只留一条线，但 --pick 理论上能点同一家多次）。
    const costs = new Map<string, ResourceCost>();
    for (const run of chosen) costs.set(run.runId, costOf(run));
    const scores = relativeScores(
        chosen.map((run) => ({ id: run.runId, cu: costs.get(run.runId)?.cu ?? 0 })),
    );

    for (const run of chosen) {
        const cost = costs.get(run.runId) as ResourceCost;
        const candidates = byHarness.get(run.harnessId) ?? [run];
        const durations = candidates
            .map((item) => `${(item.endToEndMs / 1000).toFixed(1)}s`)
            .join(" / ");
        // 计分口径的坑要在人读的这一行里露出来，别让人自己回查 run.json。
        const notes = [
            cost.tailAppliedMs === 0 && run.harnessExitedAtMs === null ? "尾部未补（下界）" : "",
            run.childColumnPresent ? "" : "无 child 列（进程树偏低）",
        ].filter((note) => note !== "");
        console.log(
            `[gen-chart-data] ${run.name.padEnd(11)} ${run.runId}  ` +
                `端到端 ${(run.endToEndMs / 1000).toFixed(1)}s · ${run.samples.length} 采样点 · ` +
                `统一计分 ${cost.cu.toFixed(3)} CU → ${((scores.get(run.runId) ?? 0)).toFixed(1)} 分` +
                `（候选 ${candidates.length} 次：${durations}）` +
                (notes.length > 0 ? `  ⚠ ${notes.join("；")}` : ""),
        );
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        // 只列真正贡献了曲线的目录（空目录列进去会让人以为数据来自那儿）
        sourceDir: [...contributingDirs].map((dir) => relative(REPO_ROOT, dir)).join(" + "),
        pickRule:
            picks.length > 0
                ? `--pick 指定：${picks.join(", ")}`
                : `每个 harness 取最近 ${window} 次长剧本运行中端到端时长居中的一次`,
        sampleColumns: [...SAMPLE_COLUMNS],
        // 计分口径写进 payload：图表页/报告都不该各自记一份公式。
        scoreFormula: {
            source: "公式结构借自阿里云函数计算（FC）的「资源使用量 × 转换系数」，系数是本项目定的 CPU 与内存 1:1",
            expression: "CU = 1.0 × 核·秒 + 1.0 × GB·秒",
            coefficients: { ...CU_COEFFICIENTS },
            scope: "进程树（含 harness 拉起的子进程）",
            score: "100 × 本批次最小 CU / 本次 CU（最优 100 分）",
            deviations: [
                "内存用实测 RSS，不是 FC 的「申报规格 × 时长」",
                "不含磁盘项（无数据）与 GPU 项（不采 GPU）",
                "系数不是 FC 的 0.15：FC 眼里 1 核 ≈ 6.67 GB（内存项只占总账 1%~8%），" +
                    "本项目按「资源负担」读，CPU 与内存逐秒同价",
                "调用次数不折算（请求数由剧本决定，不是 harness 的开销）",
            ],
            // 压力口径：峰值，不折算。
            peaks: {
                label: "峰值（压力口径）",
                note:
                    "取整个窗口的最大值（进程树 RSS / CPU），不折算成分数——峰值是绝对量，可直接横比；" +
                    "它答的是「最坏一刻要占多少」，与 CU 的「总共烧多少」互补",
            },
        },
        runs: chosen.map((run) => {
            const cost = costs.get(run.runId) as ResourceCost;
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
                score: serializeCost(run, cost, scores.get(run.runId) ?? 0),
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
