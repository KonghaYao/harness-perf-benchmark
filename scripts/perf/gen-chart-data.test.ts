/**
 * 图表数据生成器的单元测试：两种布局的读取、挑运行、列名映射。
 * 端到端那一环（真扫产物目录 → 出 JSON）靠手跑一次核对即可。
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    collectFromFlatDir,
    collectFromRunsDir,
    costOf,
    isLongRunScript,
    pickMedianOfLatest,
    SAMPLE_COLUMNS,
    serializeCost,
    type RunRecord,
} from "./gen-chart-data";
import { RUN_META_SCHEMA_VERSION, type RunMeta } from "./run-meta";
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
            "long-run-dsh.json",
            // harness 名里带连字符的（minimax-code）也要认：早年只写 [a-z]+ 会把它挡在外面
            "long-run-minimax-code.json",
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
