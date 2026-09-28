/**
 * 图表数据生成器的单元测试：两种布局的读取、挑运行、列名映射。
 * 端到端那一环（真扫产物目录 → 出 JSON）靠手跑一次核对即可。
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCalibration } from "./calibrate.test";
import { scoreFormula } from "./score";
import type { Calibration, CalibrationHost } from "./calibrate";
import {
    collectFromFlatDir,
    collectFromRunsDir,
    costOf,
    isLongRunScript,
    pickMedianOfLatest,
    resolveScales,
    SAMPLE_COLUMNS,
    serializeCost,
    type RunRecord,
} from "./gen-chart-data";
import { RUN_META_SCHEMA_VERSION, type RunMeta, type RunMetaCpuCalibration, type RunMetaHost } from "./run-meta";
import { CSV_HEADER, type ProcessSample } from "./sampler";

const sampleRow = (values: Partial<Record<(typeof SAMPLE_COLUMNS)[number], number>>): string => {
    const cells = (["elapsed_ms", "cpu_pct", "rss_kb", "tree_cpu_pct", "tree_rss_kb", "procs"] as const).map(
        (column) => values[column] ?? 0,
    );
    return `2026-09-19T00:00:00.000Z,${cells.join(",")}`;
};

/** 新布局的一次运行：run.json + samples.csv。 */
function writeRun(
    root: string,
    harnessId: string,
    runId: string,
    overrides: Partial<RunMeta> = {},
): string {
    const runDir = join(root, harnessId, runId);
    mkdirSync(runDir, { recursive: true });
    const meta: RunMeta = {
        schemaVersion: RUN_META_SCHEMA_VERSION,
        runId,
        status: "ok",
        error: null,
        legacy: null,
        harness: {
            id: harnessId,
            idSource: "explicit",
            command: null,
            commandLine: `/bin/${harnessId} -p 压测`,
            cwd: null,
            binary: null,
            version: null,
            env: null,
        },
        scenario: {
            path: `/repo/data/scenarios/long-run.json`,
            relPath: "data/scenarios/long-run.json",
            name: "long-run.json",
            sizeBytes: 1,
            sha256: null,
        },
        mock: { port: 3480, exhausted: "stop", readyMs: 100, requests: 101, requestsSource: "status", cursor: null },
        sampling: { intervalMs: 100, backend: "rusage", withTree: true, format: "csv" },
        limits: null,
        prompt: null,
        label: null,
        host: null,
        startedAtMs: 1,
        startedAt: "2026-09-19T00:00:00.000Z",
        endedAtMs: 2,
        endedAt: "2026-09-19T00:00:02.000Z",
        duration: { endToEndMs: 9_200, samplingWindowMs: 9_100 },
        timing: {
            harnessStartedAtMs: 1_000,
            samplingStartedAtMs: 1_010,
            firstRequestAtMs: 2_710,
            lastRequestAtMs: 5_210,
            harnessExitedAtMs: 10_200,
        },
        segments: { startupMs: 1_700, spanMs: 2_500, tailMs: 5_100, idleTail: true },
        summary: null,
        summarySource: "runtime",
        cost: null,
        peaks: null,
        exit: { code: 0, signal: null },
        artifacts: null,
        ...overrides,
    };
    writeFileSync(join(runDir, "run.json"), JSON.stringify(meta, null, 2));
    writeFileSync(
        join(runDir, "samples.csv"),
        `${CSV_HEADER}\n${sampleRow({ elapsed_ms: 100, cpu_pct: 22.84, rss_kb: 22096, tree_cpu_pct: 22.84, tree_rss_kb: 22096, procs: 1 })}\n`,
    );
    return runDir;
}

/** 老布局的一次运行：`<runId>-perf.log` + `<runId>-samples.csv`。 */
function writeFlatRun(
    dir: string,
    runId: string,
    options: { script?: string; command?: string; endToEnd?: string } = {},
): void {
    const script = options.script ?? "/repo/data/scenarios/long-run.json";
    const command = options.command ?? "/Users/x/.peri/peri -p '压测' --max-turns 100";
    writeFileSync(
        join(dir, `${runId}-perf.log`),
        [
            `# llm-mock 压测记录`,
            `runId: ${runId}`,
            `开始: 2026-09-19T00:00:00.000Z`,
            `产物目录: ${dir}`,
            "",
            `[+0.001s] 启动 mock: bun run /repo/src/server.ts --script ${script} --port 3480 --exhausted stop`,
            `[+0.106s] 启动 harness: ${command}（cwd=/repo/playground/peri）`,
            `[+0.108s] 采样开始: proc_pid_rusage（1 tick = 41.67 ns），间隔 100ms，落盘周期 1000ms`,
            `mock 请求数: 102（5.7 次/秒）`,
            `端到端时长: ${options.endToEnd ?? "9.2"}s（harness 启动 → 退出；采样窗口 9.1s）`,
            `时长分段: 启动 → 首个请求 1.7s ｜ 首个请求 → 末次请求 2.5s ｜ 末次请求 → 退出 5.1s（收尾零请求：…）`,
            `harness 退出: code=0 signal=无`,
            `=== 摘要 ===`,
        ].join("\n") + "\n",
    );
    writeFileSync(
        join(dir, `${runId}-samples.csv`),
        `${CSV_HEADER}\n${sampleRow({ elapsed_ms: 100, cpu_pct: 5, rss_kb: 1024, tree_cpu_pct: 5, tree_rss_kb: 1024, procs: 1 })}\n`,
    );
}

describe("isLongRunScript", () => {
    it("认长剧本与各家的变体", () => {
        for (const name of [
            "long-run.json",
            "long-run-codex.json",
            "long-run-pi.json",
            "long-run-copilot.json",
            "long-run-dsh.json",
            // harness 名里带连字符的（minimax-code）也要认：早年只写 [a-z]+ 会把它挡在外面
            "long-run-minimax-code.json",
            // 带数字的更要认（opencode2）：只写 [a-z-]* 会让它整条曲线静默消失
            "long-run-opencode2.json",
            "long-run-antigravity.json",
            "long-run-hermes.json",
            "long-run-grok.json",
        ]) {
            expect(isLongRunScript(`/repo/data/scenarios/${name}`)).toBe(true);
        }
    });

    it("挡掉固定成本探针与别的剧本", () => {
        expect(isLongRunScript("/tmp/long-run-startup.json")).toBe(false);
        expect(isLongRunScript("/repo/data/scenarios/large-md.json")).toBe(false);
        expect(isLongRunScript("/repo/scripts/perf-scenario.json")).toBe(false);
    });
});

describe("collectFromRunsDir（新布局）", () => {
    it("从 run.json 取身份与时长，曲线来自 samples.csv", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-chart-"));
        writeRun(root, "peri", "20260919-140136");
        const { runs, skipped } = collectFromRunsDir(root);

        expect(skipped).toEqual([]);
        expect(runs).toHaveLength(1);
        const run = runs[0]!;
        expect(run.harnessId).toBe("peri");
        expect(run.name).toBe("peri");
        expect(run.endToEndMs).toBe(9_200);
        expect(run.requests).toBe(101);
        expect(run.segments).toEqual({ startupMs: 1_700, spanMs: 2_500, tailMs: 5_100 });
        // 分界线优先用绝对时刻：first = 2710 - 1010，last = 5210 - 1010
        expect(run.requestMarksMs).toEqual({ first: 1_700, last: 4_200 });
        expect(run.samples).toHaveLength(1);
        expect(run.samples[0]).toMatchObject({
            elapsedMs: 100,
            cpuPercent: 22.84,
            rssBytes: 22096 * 1024,
            treeCpuPercent: 22.84,
            procs: 1,
        });
        // 表头带 child_cpu_pct（CSV_HEADER 就是当前口径）
        expect(run.childColumnPresent).toBe(true);
        expect(run.harnessExitedAtMs).toBe(10_200);
    });

    it("samples.csv 缺 child_cpu_pct 列时标成 false（那份的进程树口径偏低）", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-chart-"));
        const runDir = writeRun(root, "peri", "20260919-140300");
        writeFileSync(
            join(runDir, "samples.csv"),
            "ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs\n" +
                "2026-09-19T00:00:00.000Z,100,24.77,42752,24.77,42752,1\n",
        );
        const run = collectFromRunsDir(root).runs[0]!;
        expect(run.childColumnPresent).toBe(false);
        // 老表头也得能读：child_cpu_pct 是可选列，不能因此报错
        expect(run.samples[0]?.childCpuPercent).toBe(0);
    });

    it("老产物没有绝对时刻时，用「启动→采样」的间隔 + segments 还原分界线", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-chart-"));
        writeRun(root, "dsh", "20260919-140424", {
            timing: {
                harnessStartedAtMs: 1_000,
                samplingStartedAtMs: 1_019,
                firstRequestAtMs: null,
                lastRequestAtMs: null,
                harnessExitedAtMs: null,
            },
        });
        expect(collectFromRunsDir(root).runs[0]!.requestMarksMs).toEqual({
            first: 19 + 1_700,
            last: 19 + 1_700 + 2_500,
        });
    });

    it("跳过没跑完的运行与别的剧本", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-chart-"));
        writeRun(root, "peri", "20260919-140000");
        writeRun(root, "peri", "20260919-140100", { status: "timeout" });
        writeRun(root, "peri", "20260919-140200", {
            scenario: { path: "/repo/data/scenarios/large-md.json", relPath: "x", name: "large-md.json", sizeBytes: 1, sha256: null },
        });
        const { runs, skipped } = collectFromRunsDir(root);

        expect(runs.map((run) => run.runId)).toEqual(["20260919-140000"]);
        // 别的剧本（large-md）根本不在长剧本那组里，不算「跳过」，只有没跑完的那次算
        expect(skipped).toHaveLength(1);
        expect(skipped.join("\n")).toContain("status=timeout");
    });
});

describe("collectFromFlatDir（老布局兼容）", () => {
    it("反解出 harness 与时长，harness 别名生效（claude → claude-code）", () => {
        const dir = mkdtempSync(join(tmpdir(), "llm-mock-flat-"));
        writeFlatRun(dir, "20260919-133950", { command: "/Users/x/.local/bin/claude -p '压测'" });
        const { runs, skipped } = collectFromFlatDir(dir);

        expect(skipped).toEqual([]);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.harnessId).toBe("claude-code");
        expect(runs[0]!.name).toBe("Claude Code");
        expect(runs[0]!.endToEndMs).toBe(9_200);
        // anchor = 0.108 - 0.106 = 2ms；first = 2 + 1700
        expect(runs[0]!.requestMarksMs).toEqual({ first: 1_702, last: 4_202 });
    });

    it("没跑完的老产物（无摘要）被跳过", () => {
        const dir = mkdtempSync(join(tmpdir(), "llm-mock-flat-"));
        writeFlatRun(dir, "20260919-133950");
        const perfPath = join(dir, "20260919-133950-perf.log");
        writeFileSync(perfPath, "随便一段不属于任何运行的日志\n");
        expect(collectFromFlatDir(dir).runs).toEqual([]);
    });
});

describe("计分（score 块）", () => {
    const MB = 1024 * 1024;
    /** 一拍：默认满转一个核 + 1GB 常驻，便于手算核·秒 / GB·秒。 */
    const beat = (elapsedMs: number, ts: number, overrides: Partial<ProcessSample> = {}): ProcessSample => ({
        ts,
        elapsedMs,
        cpuPercent: 100,
        rssBytes: 1024 * MB,
        treeCpuPercent: 100,
        treeRssBytes: 1024 * MB,
        procs: 1,
        childCpuPercent: 0,
        ...overrides,
    });
    /** 3 拍、每拍 100ms 满转：核·秒 = 3 × 0.1 = 0.3。 */
    const beats = (): ProcessSample[] => [beat(100, 1_000), beat(200, 1_100), beat(300, 1_200)];

    const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
        runId: "20260919-140000",
        harnessId: "peri",
        name: "peri",
        commandLine: null,
        script: "data/scenarios/long-run.json",
        endToEndMs: 2_000,
        samplingWindowMs: 1_000,
        requests: 100,
        segments: null,
        requestMarksMs: null,
        harnessExitedAtMs: null,
        samples: beats(),
        childColumnPresent: true,
        label: null,
        ...overrides,
    });

    it("核·秒与 GB·秒按实测间隔积分，再按 CPU 与内存 1:1 折成 CU", () => {
        const cost = costOf(record());
        expect(cost.cpuSeconds).toBeCloseTo(0.3, 9);
        expect(cost.gbSeconds).toBeCloseTo(0.3, 9);
        // 0.3 核·秒 × 1.0 + 0.3 GB·秒 × 1.0
        expect(cost.cu).toBeCloseTo(0.3 + 0.3, 9);
        expect(cost.tailAppliedMs).toBe(0);
    });

    it("末拍 → 退出的空档按末尾速率补齐（run.json 记了退出时刻才有）", () => {
        // 末拍 ts=1200，harness 1250 才退出：50ms 没记账 → 补 0.05 核·秒
        const cost = costOf(record({ harnessExitedAtMs: 1_250 }));
        expect(cost.tailAppliedMs).toBe(50);
        expect(cost.cpuSeconds).toBeCloseTo(0.35, 9);
        expect(cost.cu).toBeCloseTo(0.35 + 0.35, 9);
    });

    it("序列化后能看出「这一份是下界」：tailAppliedMs=0 且 tailGapKnown=false", () => {
        const run = record();
        const cost = costOf(run);
        const score = serializeCost(run, cost, 100);
        expect(score.tailAppliedMs).toBe(0);
        expect(score.tailGapKnown).toBe(false);
        expect(score.sampleCount).toBe(3);
        expect(score.cu).toBeCloseTo(0.6, 6);

        const known = serializeCost(record({ harnessExitedAtMs: 1_250 }), costOf(record({ harnessExitedAtMs: 1_250 })), 42);
        expect(known.tailGapKnown).toBe(true);
        expect(known.tailAppliedMs).toBe(50);
        expect(known.score).toBe(42);
    });

    it("有请求分界线时给出三段成本，各段首拍 dt 接在上一段之后（不重不漏）", () => {
        const run = record({ requestMarksMs: { first: 200, last: 300 } });
        const score = serializeCost(run, costOf(run), 100);
        expect(score.segments).not.toBeNull();
        const { startup, span, tail } = score.segments!;
        // 启动段 = 前两拍（各 0.1s）；运转段 = 第三拍；收尾段 = 空
        expect(startup.cpuSeconds).toBeCloseTo(0.2, 9);
        expect(startup.sampleCount).toBe(2);
        expect(span.cpuSeconds).toBeCloseTo(0.1, 9);
        expect(tail.sampleCount).toBe(0);
        // 三段之和 == 整段（首拍 dt 若各自从 0 起算就会多出一拍）
        expect(startup.cu + span.cu + tail.cu).toBeCloseTo(score.cu, 9);
    });

    it("没有请求分界线就不编造分段", () => {
        const run = record();
        expect(serializeCost(run, costOf(run), 0).segments).toBeNull();
    });

    it("后代 CPU 取「计数器」与「采样到的后代」的较大者，不求和", () => {
        const samples = [
            beat(100, 1_000, { cpuPercent: 50, treeCpuPercent: 60, childCpuPercent: 30 }),
            beat(200, 1_100, { cpuPercent: 50, treeCpuPercent: 60, childCpuPercent: 30 }),
        ];
        const cost = costOf(record({ samples }));
        // 采样到的后代 = 每拍 10% × 0.1s ×2 = 0.02；计数器 = 30% × 0.1 ×2 = 0.06 → 取 0.06
        expect(cost.childSampledSeconds).toBeCloseTo(0.02, 9);
        expect(cost.childCounterSeconds).toBeCloseTo(0.06, 9);
        expect(cost.childCpuSeconds).toBeCloseTo(0.06, 9);
        expect(cost.childCpuFrom).toBe("counter");
        expect(cost.cpuSeconds).toBeCloseTo(0.1 + 0.06, 9);
    });

    it("没采到样的运行记 0 CU（相对分里也就不会是 100 分）", () => {
        const cost = costOf(record({ samples: [] }));
        expect(cost.sampleCount).toBe(0);
        expect(cost.cu).toBe(0);
    });
});

describe("pickMedianOfLatest", () => {
    const run = (runId: string, endToEndMs: number): RunRecord => ({
        runId,
        harnessId: "peri",
        name: "peri",
        commandLine: null,
        script: "data/scenarios/long-run.json",
        endToEndMs,
        samplingWindowMs: endToEndMs - 100,
        requests: 101,
        segments: null,
        requestMarksMs: null,
        harnessExitedAtMs: null,
        samples: [],
        childColumnPresent: true,
        label: null,
    });

    it("只在最近 N 次里挑，取时长居中者", () => {
        const runs = [
            run("20260919-130000", 7.0),
            run("20260919-130100", 7.1),
            // 最近 3 次：9.3 / 7.7 / 9.2 → 中位数是 9.2
            run("20260919-130200", 9.3),
            run("20260919-130300", 7.7),
            run("20260919-130400", 9.2),
        ];
        expect(pickMedianOfLatest(runs, 3).runId).toBe("20260919-130400");
        // 窗口大于总数：全用上（7.0/7.1/7.7/9.2/9.3 → 中位数 7.7）
        expect(pickMedianOfLatest(runs, 10).runId).toBe("20260919-130300");
    });

    it("次序不敏感：乱序传入也按 runId 取最近的那批", () => {
        const runs = [run("20260919-130400", 9.2), run("20260919-130200", 9.3), run("20260919-130300", 7.7)];
        expect(pickMedianOfLatest(runs, 3).runId).toBe("20260919-130400");
    });
});

describe("CPU 折算（读侧）：口径、宿主、方向", () => {
    /** 一份「形状与 calibrate() 产物一致」的假校准，只用于读侧用例（不 spawn 任何进程）。 */
    const fakeCalibrationFor = (
        calibrationHost: CalibrationHost | RunMetaHost,
        cpuScale: number,
        repeats = 5,
    ): Calibration => {
        const calibration = fakeCalibration({
            host: { ...calibrationHost, loadAvg: "loadAvg" in calibrationHost ? calibrationHost.loadAvg : calibrationHost.loadAvgStart },
        });
        return {
            ...calibration,
            scale: {
                baselineMips: 1000,
                cpuScale,
                cpuScaleValue: cpuScale * 1000,
                baseline: "1000 benchmark MIPS per CPU-second",
                unit: "本机核·秒 × cpuScale = 标准机核·秒",
                oneCoreSecond: { rawRu: [cpuScale * 1000], rawRatings: [cpuScale * 1000] },
            },
            statistic: { ...calibration.statistic, repeats },
        };
    };
    const MB = 1024 * 1024;
    const beats = (): ProcessSample[] => [
        { ts: 1_000, elapsedMs: 100, cpuPercent: 100, rssBytes: 1024 * MB, treeCpuPercent: 100, treeRssBytes: 1024 * MB, procs: 1, childCpuPercent: 0 },
        { ts: 1_100, elapsedMs: 200, cpuPercent: 100, rssBytes: 1024 * MB, treeCpuPercent: 100, treeRssBytes: 1024 * MB, procs: 1, childCpuPercent: 0 },
        { ts: 1_200, elapsedMs: 300, cpuPercent: 100, rssBytes: 1024 * MB, treeCpuPercent: 100, treeRssBytes: 1024 * MB, procs: 1, childCpuPercent: 0 },
    ];
    const host: RunMetaHost = {
        hostname: "mac",
        platform: "darwin",
        osRelease: "25.5.0",
        arch: "arm64",
        cpuModel: "Apple M5 Pro",
        cpus: 18,
        totalMemBytes: 51_539_607_552,
        bunVersion: "1.4.0",
        loadAvgStart: [3, 3, 3],
        loadAvgEnd: null,
    };
    const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
        runId: "20260919-140000",
        harnessId: "peri",
        name: "peri",
        commandLine: null,
        script: "data/scenarios/long-run.json",
        endToEndMs: 2_000,
        samplingWindowMs: 1_000,
        requests: 100,
        segments: null,
        requestMarksMs: { first: 100, last: 300 },
        harnessExitedAtMs: null,
        samples: beats(),
        childColumnPresent: true,
        label: null,
        host,
        cpuCalibration: null,
        ...overrides,
    });
    /** run.json 里那一份校准摘要（形状与 run.ts 写的完全一致）。 */
    const storedCalibration = (overrides: Partial<RunMetaCpuCalibration> = {}): RunMetaCpuCalibration => ({
        method: "cpu-calibration-7zip-v1",
        file: "/repo/data/calibration/20260922-130000",
        measuredAt: "2026-09-22T05:00:00.000Z",
        cpuScale: 7,
        baselineMips: 1000,
        cpuScaleValue: 7000,
        statistic: { metric: "ru-arith-mean", repeats: 5 },
        binary: { path: "/opt/homebrew/bin/7zz", realPath: "/opt/homebrew/Cellar/sevenzip/26.01/bin/7zz", sha256: "a".repeat(64) },
        toolVersion: "26.01",
        configSignature: ["a".repeat(64), "26.01", "b 1 -mmt1 -md25", "dict=25", "baseline=1000", "repeats=5", "threads=18"].join("|"),
        warningCount: 0,
        calibrationHost: {
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
        ...overrides,
    });

    it("未校准时 scale=1：cu 与 rawCu 相等，payload 标 applied=false", () => {
        const run = record();
        const scales = resolveScales([run], null);
        expect(scales.byRun.get(run.runId)?.source).toBe("none");
        expect(scales.preview.applied).toBe(false);
        expect(scales.preview.mode).toBe("none");
        const cost = costOf(run, scales.byRun.get(run.runId)?.cpuScale ?? 1);
        const score = serializeCost(run, cost, 100, null);
        expect(score.cpuScale).toBe(1);
        expect(score.standardCpuSeconds).toBeCloseTo(score.cpuSeconds, 9);
        expect(score.rawCu).toBeCloseTo(score.cu, 9);
        expect(score.calibration).toBeNull();
    });

    it("产物自带校准：cu 用折算值、rawCu 留着原值、内存项不变", () => {
        const run = record({ cpuCalibration: storedCalibration() });
        const scales = resolveScales([run], null);
        expect(scales.preview.applied).toBe(true);
        expect(scales.preview.mode).toBe("as-recorded");
        expect(scales.preview.retrospective).toBe(false);
        const cost = costOf(run, scales.byRun.get(run.runId)?.cpuScale ?? 1);
        const score = serializeCost(run, cost, 100, null);
        expect(score.cpuScale).toBe(7);
        expect(score.cpuSeconds).toBeCloseTo(0.3, 9);
        expect(score.standardCpuSeconds).toBeCloseTo(2.1, 9);
        expect(score.rawCu).toBeCloseTo(0.6, 9);
        expect(score.cu).toBeCloseTo(2.1 + 0.3, 9);
        // 折算只乘 CPU 项：内存项、峰值都不动
        expect(score.memoryCu).toBeCloseTo(0.3, 9);
        expect(score.gbSeconds).toBeCloseTo(0.3, 9);
        expect(score.peaks.treeRssMb).toBeCloseTo(1024, 6);
        // 三段各自带着同一个系数，且三段之和 == 整段
        expect(score.segments?.span.cpuScale).toBe(7);
        const parts = score.segments!;
        expect(parts.startup.cu + parts.span.cu + parts.tail.cu).toBeCloseTo(score.cu, 9);
    });

    it("--cpu-calibration 显式给：套在没校准的产物上，标成 retrospective 本地预览", () => {
        const run = record();
        const calibration = fakeCalibrationFor(host, 7);
        const scales = resolveScales([run], calibration, { explicitFile: "data/calibration/x/calibration.json" });
        expect(scales.preview.applied).toBe(true);
        expect(scales.preview.retrospective).toBe(true);
        expect(scales.preview.mode).toBe("local-preview");
        expect(scales.byRun.get(run.runId)?.source).toBe("flag");
        expect(scales.preview.disclaimers.join(" ")).toContain("local preview");
        expect(scales.preview.files).toEqual(["data/calibration/x/calibration.json"]);
    });

    it("显式校准与产物自带的一致时不算事后重算（source=stored）", () => {
        const run = record({ cpuCalibration: storedCalibration() });
        const scales = resolveScales([run], fakeCalibrationFor(host, 7));
        expect(scales.preview.retrospective).toBe(false);
        expect(scales.byRun.get(run.runId)?.source).toBe("stored");
    });

    it("宿主对不上时显式校准直接抛（不许静默用错 host）", () => {
        const other = record({ host: { ...host, cpuModel: "Apple M1" } });
        expect(() => resolveScales([other], fakeCalibrationFor(host, 7))).toThrow(/宿主对不上/);
        // 老布局连 host 都没有 → 同样拒绝
        const flat = record({ host: null });
        expect(() => resolveScales([flat], fakeCalibrationFor(host, 7))).toThrow(/宿主快照缺失|宿主对不上/);
    });

    it("产物自相矛盾（calibrationHost 与 host 不符）时抛出", () => {
        const run = record({
            cpuCalibration: storedCalibration({
                calibrationHost: { ...storedCalibration().calibrationHost, hostname: "another-mac" },
            }),
        });
        expect(() => resolveScales([run], null)).toThrow(/自相矛盾/);
    });

    it("混了有校准 / 无校准 → 标 blocked，不给相对排名", () => {
        const withCal = record({ runId: "a", name: "peri", cpuCalibration: storedCalibration() });
        const without = record({
            runId: "b",
            name: "pi",
            harnessId: "pi",
            cpuCalibration: null,
        });
        const scales = resolveScales([withCal, without], null);
        expect(scales.preview.applied).toBe(false);
        expect(scales.preview.blocked).toBe(true);
        expect(scales.preview.blockedReasons.join(" ")).toContain("mixes calibrated and uncalibrated");
    });

    it("口径不一致（baseline / 版本 / 参数不同）也标 blocked", () => {
        const a = record({ runId: "a", name: "peri", cpuCalibration: storedCalibration() });
        const b = record({
            runId: "b",
            name: "pi",
            harnessId: "pi",
            cpuCalibration: storedCalibration({ baselineMips: 2000, cpuScale: 3.5 }),
        });
        const scales = resolveScales([a, b], null);
        expect(scales.preview.blocked).toBe(true);
        expect(scales.preview.blockedReasons.join(" ")).toContain("baselineMips");
    });

    it("不同机器各自的 scale 是允许的（那正是折算的意义）", () => {
        const a = record({ runId: "a", name: "peri", cpuCalibration: storedCalibration({ cpuScale: 7, cpuScaleValue: 7000 }) });
        const b = record({
            runId: "b",
            name: "pi",
            harnessId: "pi",
            cpuCalibration: storedCalibration({ cpuScale: 3, cpuScaleValue: 3000 }),
        });
        const scales = resolveScales([a, b], null);
        expect(scales.preview.applied).toBe(true);
        expect(scales.preview.blocked).toBe(false);
        expect(scales.byRun.get("a")?.cpuScale).toBe(7);
        expect(scales.byRun.get("b")?.cpuScale).toBe(3);
    });

    it("评分方向：scale 越大的机器上同样的核·秒折算后越贵（不是越便宜）", () => {
        const run = record({ cpuCalibration: storedCalibration({ cpuScale: 7, cpuScaleValue: 7000 }) });
        const fast = costOf(run, 7);
        const slow = costOf(run, 3);
        expect(fast.cu).toBeGreaterThan(slow.cu);
        expect(fast.memoryCu).toBeCloseTo(slow.memoryCu, 9);
    });
});

/**
 * 图表页与 payload 的契约：页面里的那段 JS 直接读 payload 的字段，
 * 一旦字段改名/挪位，这一组用例会先失败，而不是等打开页面才发现是空的。
 *
 * `docs/perf-chart.html` 的 `<script>` 不是模块、也没有构建步骤，所以这里只能
 * 从源码里抽函数出来跑（`new Function`），并且断言页面**确实引用**了那几个字段。
 */
describe("图表页契约（docs/perf-chart.html）", () => {
    const html = readFileSync(join(import.meta.dir, "../../docs/perf-chart.html"), "utf8");

    /** 抽出页面里 `?data=` 的路径解析器（纯函数，不碰 DOM）。 */
    function dataPathResolver(): (raw: string | null, baseHref: string) => string | null {
        const start = html.indexOf("function resolveDataPath(");
        const end = html.indexOf("function dataBaseHref(");
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const source = html.slice(start, end);
        // eslint-disable-next-line no-new-func
        return new Function(`${source}; return resolveDataPath;`)() as (
            raw: string | null,
            baseHref: string,
        ) => string | null;
    }

    it("`?data=` 只接受同源的相对路径（绝对 URL / 协议相对 / 反斜杠一律拒绝）", () => {
        const resolve = dataPathResolver();
        const base = "http://localhost:8080/docs/";
        // 页面在 /docs/ 下，载荷在仓库根的 data/ 下：`../` 是正常用法，必须通得过
        expect(resolve("../data/perf-chart-calibrated.json", base)).toBe("/data/perf-chart-calibrated.json");
        expect(resolve("data/other.json", base)).toBe("/docs/data/other.json");
        expect(resolve("/data/x.json", base)).toBe("/data/x.json");
        expect(resolve("./data/x.json?v=2", base)).toBe("/docs/data/x.json?v=2");
        // 多余的分隔符归一化（同一份文件不该在缓存里算两份）
        expect(resolve("data//x.json", base)).toBe("/docs/data/x.json");
        expect(resolve("", base)).toBeNull();
        expect(resolve(null, base)).toBeNull();
        expect(resolve("https://evil.example/x.json", base)).toBeNull();
        expect(resolve("//evil.example/x.json", base)).toBeNull();
        expect(resolve("data:application/json,{}", base)).toBeNull();
        // `..` 折叠后落在站点根上（没有任何文件），挡掉
        expect(resolve("../../..", base)).toBeNull();
        expect(resolve("..\\..\\data\\x.json", base)).toBeNull();
    });

    it("页面脚本能编译（语法错不该等到打开页面才发现）", () => {
        const start = html.indexOf("<script>");
        const end = html.lastIndexOf("</script>");
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const body = html.slice(start + "<script>".length, end);
        // `new Function` 只编译不执行：重复声明、漏括号这类错会在这里抛出来
        expect(() => new Function(body)).not.toThrow();
    });

    it("页面引用了 payload 里新加的字段（校准 + 公式按 payload 印）", () => {
        for (const key of [
            "scoreFormula",
            "formula.lines",
            "run.score.calibration",
            "run.score.cpuScale",
            "run.score.rawCu",
            "run.score.standardCpuSeconds",
            "calibration.mode",
            "calibration.blocked",
            "calibration.retrospective",
            "calibration.toolVersion",
            "calibration.baselineMips",
            "calibration.measuredAt",
            "calibration.host",
            "calibration.singleThreadCvPercent",
            "calibration.machine",
            "standardUnitsThroughput",
        ]) {
            // 页面读的是嵌套属性；这里按最后一段查，容忍写法差异（`x.y` 或 `x?.y`）
            const leaf = key.split(".").pop() as string;
            expect(html).toContain(leaf);
        }
        // 公式来自 payload：页面不能再把表达式写死在自己的 JS 里
        expect(html).not.toContain('"CU = 1.0 × core·s + 1.0 × GB·s"');
    });

    it("页面保留 CPU% / RSS 峰值两块图，且主 CU 用已折算的 score.cu", () => {
        expect(html).toContain('id="bar-cpu"');
        expect(html).toContain('id="bar-rss"');
        expect(html).toContain("run.score.peaks?.treeCpuPercent");
        expect(html).toContain("run.score.peaks?.treeRssMb");
        // 主 CU 图读 run.score.cu（payload 里已经折算过），页面自己不乘 scale
        expect(html).toContain("{ id: \"bar-cu\", value: (run) => run.score.cu");
    });
});

describe("口径混合时不给分、页面不排名（回归）", () => {
    const MB = 1024 * 1024;
    const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
        runId: "20260922-100000",
        harnessId: "peri",
        name: "peri",
        commandLine: null,
        script: "data/scenarios/long-run.json",
        endToEndMs: 2_000,
        samplingWindowMs: 1_900,
        requests: 100,
        segments: null,
        requestMarksMs: null,
        harnessExitedAtMs: null,
        samples: [
            { ts: 1_000, elapsedMs: 100, cpuPercent: 100, rssBytes: 1024 * MB, treeCpuPercent: 100, treeRssBytes: 1024 * MB, procs: 1, childCpuPercent: 0 },
            { ts: 1_100, elapsedMs: 200, cpuPercent: 100, rssBytes: 1024 * MB, treeCpuPercent: 100, treeRssBytes: 1024 * MB, procs: 1, childCpuPercent: 0 },
        ],
        childColumnPresent: true,
        label: null,
        ...overrides,
    });

    it("blocked 时 score 记 null（不给一个「看着像分数」的数）", () => {
        const record = run();
        const cost = costOf(record, 7);
        expect(serializeCost(record, cost, null).score).toBeNull();
        // 数值本身照旧：rawCu / 折算后的 cu 都还在，页面按各自的单位显示
        const score = serializeCost(record, cost, null);
        expect(score.cu).toBeGreaterThan(score.rawCu);
        expect(score.cpuScale).toBe(7);
    });

    it("未 blocked 时 score 照常是数字", () => {
        const record = run();
        expect(serializeCost(record, costOf(record, 1), 42).score).toBe(42);
    });

    it("页面：CU 图在 blocked 时不排序、不强调前两名", () => {
        const html = readFileSync(join(import.meta.dir, "../../docs/perf-chart.html"), "utf8");
        expect(html).toContain("calibrationBlocked");
        expect(html).toContain("noRanking");
        // blocked 时按名字排（不是按值），且不套用「前两名实心」
        expect(html).toContain("noRanking ? a.label.localeCompare(b.label) : a.value - b.value");
        expect(html).toContain("excluded || (!noRanking && rank >= 2)");
    });

    it("页面：动态文本（harness 名 / label / blockedReasons）都过 escapeHtml", () => {
        const html = readFileSync(join(import.meta.dir, "../../docs/perf-chart.html"), "utf8");
        const start = html.indexOf("function escapeHtml(");
        expect(start).toBeGreaterThan(-1);
        const escapeHtml = new Function(
            `${html.slice(start, html.indexOf("function showError("))}; return escapeHtml;`,
        )() as (value: unknown) => string;
        expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
            "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
        );
        expect(escapeHtml("a&b")).toBe("a&amp;b");
        expect(escapeHtml(undefined)).toBe("");
        // 表格行与警告里必须真的用上它（不是一个没被调用的装饰函数）
        expect(html).toContain("escapeHtml(run.name)");
        expect((html.match(/escapeHtml\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    });
});

/**
 * 文案回归（读侧 + 页面）：折算口径的文字**曾经写错过**，错的方向很危险——
 * 说「名次不变」会让人以为折算只是换单位，而实际上是「CPU 项乘 scale、内存项不变」，
 * 排序会变；说「某台参考机器」则是在声称一台从未测量过的机器。
 */
describe("折算文案：读侧与页面都不许出现错误结论", () => {
    /** 与 main() 里同一条路径：payload 的 scoreFormula 就是 score.ts 的那个 builder。 */
    const scoreFormulaForTest = (scales: ReturnType<typeof resolveScales>) =>
        scoreFormula(
            scales.preview.applied && scales.preview.identity !== null
                ? {
                      cpuScale: scales.preview.scales[0]!.cpuScale,
                      baselineMips: scales.preview.baselineMips ?? 0,
                      cpuScaleValue: scales.preview.scales[0]!.cpuScale * (scales.preview.baselineMips ?? 0),
                      toolVersion: scales.preview.toolVersion ?? "",
                      measuredAt: scales.preview.measuredAt ?? "",
                  }
                : null,
        );

    const forbidden = [
        "名次与未折算一致",
        "归一化系数在批内约掉",
        "不改变名次",
        "排序不变",
        "ranking is unchanged",
        "reference machine seconds",
        "reference-machine seconds",
        "scaled to the reference machine",
        "标准机",
    ];

    it("gen-chart-data 的 payload 文案里没有这些句子", () => {
        // 本块自带一份最小 fixture：文案检查不该依赖别的 describe 里的作用域。
        const host: RunMetaHost = {
            hostname: "mac",
            platform: "darwin",
            osRelease: "25.5.0",
            arch: "arm64",
            cpuModel: "Apple M5 Pro",
            cpus: 18,
            totalMemBytes: 1,
            bunVersion: "1.4.0",
            loadAvgStart: [1, 1, 1],
            loadAvgEnd: null,
        };
        const cal = fakeCalibration({
            host: { ...host, loadAvg: host.loadAvgStart },
            scale: {
                baselineMips: 1000,
                cpuScale: 9.386899999999999,
                cpuScaleValue: 9386.9,
                baseline: "1000 benchmark MIPS per CPU-second",
                unit: "本机核·秒 × cpuScale = 项目标准 CPU 单位·秒",
                oneCoreSecond: { rawRu: [9386.9], rawRatings: [9353] },
            },
        });
        const run: RunRecord = {
            runId: "20260922-100000",
            harnessId: "peri",
            name: "peri",
            commandLine: null,
            script: "data/scenarios/long-run.json",
            endToEndMs: 2_000,
            samplingWindowMs: 1_900,
            requests: 100,
            segments: null,
            requestMarksMs: null,
            harnessExitedAtMs: null,
            samples: [],
            childColumnPresent: true,
            label: null,
            host,
            cpuCalibration: null,
        };
        const scales = resolveScales([run], cal, { explicitFile: "data/calibration/x/calibration.json" });
        const text = JSON.stringify(scales.preview) + JSON.stringify(scoreFormulaForTest(scales));
        for (const phrase of forbidden) expect(text).not.toContain(phrase);
        // 正面要求：必须写清「只有 CPU 项折算、名次会变」「没有真实参考机器」
        expect(text).toContain("no real reference machine was measured");
        expect(text).toContain("ranking can change");
    });

    it("页面源码里没有这些句子，也没有把公式写死", () => {
        const html = readFileSync(join(import.meta.dir, "../../docs/perf-chart.html"), "utf8");
        for (const phrase of forbidden) expect(html).not.toContain(phrase);
        expect(html).not.toContain("reference-machine CPU");
        // 页面必须写出「只有 CPU 项折算 / 内存项不变 / 名次可能不同」
        expect(html).toContain("名次可能与未折算时不同");
        expect(html).toContain("no real reference machine was measured");
    });

    it("页面显示 cpuScale 时缩到 4 位小数", () => {
        const html = readFileSync(join(import.meta.dir, "../../docs/perf-chart.html"), "utf8");
        const start = html.indexOf("function formatScale(");
        expect(start).toBeGreaterThan(-1);
        const formatScale = new Function(
            `${html.slice(start, html.indexOf("function escapeHtml("))}; return formatScale;`,
        )() as (value: number) => string;
        expect(formatScale(9.386899999999999)).toBe("9.3869");
        expect(formatScale(6.949)).toBe("6.949");
        // 公式块与对照表都得用它（不是只在某处）
        expect((html.match(/formatScale\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    });
});
