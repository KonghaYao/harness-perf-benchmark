/**
 * 图表数据生成器的单元测试：两种布局的读取、挑运行、列名映射。
 * 端到端那一环（真扫产物目录 → 出 JSON）靠手跑一次核对即可。
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    collectFromFlatDir,
    collectFromRunsDir,
    costOf,
    isLongRunScript,
    selectRuns,
    SAMPLE_COLUMNS,
    serializeCost,
    type RunRecord,
} from "./gen-chart-data";
import { RUN_META_SCHEMA_VERSION, type RunMeta } from "./run-meta";
import { CU2_FORMULA } from "./score";
import { CSV_HEADER, type ProcessSample } from "./sampler";

const sampleRow = (values: Partial<Record<(typeof SAMPLE_COLUMNS)[number], number>>): string => {
    const cells = (["elapsed_ms", "cpu_pct", "rss_kb", "tree_cpu_pct", "tree_rss_kb", "procs"] as const).map(
        (column) => values[column] ?? 0,
    );
    // 末尾一列是 child_cpu_pct（CSV_HEADER 的最后一列）：缺了它这一份就不够 CU 2.0 的证据。
    return `2026-09-19T00:00:00.000Z,${cells.join(",")},0`;
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
            // 带数字的更要认（opencode2）：只写 [a-z-]* 会让它整条曲线静默消失
            "long-run-opencode2.json",
            "long-run-antigravity.json",
            "long-run-hermes.json",
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

    it("保留失败运行占重复名额，只跳过别的剧本", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-chart-"));
        writeRun(root, "peri", "20260919-140000");
        writeRun(root, "peri", "20260919-140100", { status: "timeout" });
        writeRun(root, "peri", "20260919-140200", {
            scenario: { path: "/repo/data/scenarios/large-md.json", relPath: "x", name: "large-md.json", sizeBytes: 1, sha256: null },
        });
        const { runs, skipped } = collectFromRunsDir(root);

        // 没跑完的那次照样收：它占重复运行的名额（剔除它就等于拿成功子集充数）
        expect(runs.map((run) => run.runId)).toEqual(["20260919-140000", "20260919-140100"]);
        expect(runs[1]!.status).toBe("timeout");
        expect(serializeCost(runs[1]!, costOf(runs[1]!))).toMatchObject({
            score: null,
            valid: false,
        });
        expect(serializeCost(runs[1]!, costOf(runs[1]!)).invalidReasons).toContain("run-not-ok");
        // 别的剧本（large-md）根本不在长剧本那组里，不算「跳过」
        expect(skipped).toEqual([]);
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

    it("没跑完的老产物（无摘要）被跳过：连身份都还原不出来", () => {
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
        status: "ok",
        withTree: true,
        samplingBackend: "rusage",
        scenarioSha: "0123456789abcdef",
        conditions: { harnessId: "peri", script: "data/scenarios/long-run.json", scenarioSha: "same-conditions" },
        invalidReasons: [],
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

    it("旧 CU 面积照旧积分（1:1），但 CU 2.0 不可评分：老记录没有退出时刻", () => {
        const json = JSON.stringify(CU2_FORMULA);
        const run = record({ harnessExitedAtMs: null });
        const score = serializeCost(run, costOf(run));
        // 旧面积一分不少：这一条是给老页面读的兼容字段
        expect(score.cu).toBeCloseTo(0.6, 6);
        expect(score.tailAppliedMs).toBe(0);
        expect(score.tailGapKnown).toBe(false);
        expect(score.sampleCount).toBe(3);
        // CU 2.0 则是 null（不是 0 分，也不是满分）
        expect(score).toMatchObject({ scoreVersion: "cu2-beta", score: null, valid: false });
        expect(score.invalidReasons).toContain("missing-or-invalid-exit-time");
        // 公式只此一处：payload 直接引用 CU2_FORMULA，方向与预算都写在里面
        expect(json).toContain("100 / (1 + L)");
        expect(json).toContain("\"budgetScore\":50");
        expect(json).toContain("\"sortDirection\":\"descending\"");
    });

    it("证据齐全时 CU 2.0 出绝对分：100ms 满核 + 1GiB 常驻、峰值 1GiB、总时长 1.25s", () => {
        // 末拍 ts=1200、1250 退出（空档 50ms 在上限内）→ 边距按末尾速率补齐
        const run = record({ endToEndMs: 1_250, harnessExitedAtMs: 1_250 });
        const score = serializeCost(run, costOf(run));
        expect(score.valid).toBe(true);
        // C = 0.3 + 0.05 = 0.35 核·秒；A = 0.35 GiB·秒；T = 1.25s；P = 1 GiB
        expect(score.metrics).toMatchObject({
            timeSeconds: 1.25,
            cpuSeconds: 0.35,
            memoryGiBSeconds: 0.35,
            peakGiB: 1,
        });
        // L = max(0.125, 0.035, 0.035, 1) = 1（峰值顶着预算）
        expect(score.burdens).toEqual({ time: 0.125, cpu: 0.035, memory: 0.035, peak: 1 });
        expect(score.burden).toBe(1);
        expect(score.score).toBe(50);
        // 尾补是旧面积与 CU 2.0 共用的证据，两者都要能对上
        expect(score.tailAppliedMs).toBe(50);
        expect(score.tailGapKnown).toBe(true);
    });

    it("尾部空档超过 500ms 上限 → 不可评分（旧面积仍按截断值给出，但标着已知空档）", () => {
        const run = record({ endToEndMs: 2_000, harnessExitedAtMs: 2_000 });
        const score = serializeCost(run, costOf(run));
        expect(score.score).toBeNull();
        expect(score.invalidReasons).toContain("tail-gap-exceeds-limit");
        // 空档实测 800ms（1300 末拍 → 2000 退出？按本 fixture 的末拍 1200 算是 800ms）
        expect(score.tailGapMs).toBe(800);
        expect(score.tailAppliedMs).toBe(500);
        expect(score.tailGapKnown).toBe(true);
    });

    it("有请求分界线时给出三段成本，各段首拍 dt 接在上一段之后（不重不漏）", () => {
        const run = record({ requestMarksMs: { first: 200, last: 300 } });
        const score = serializeCost(run, costOf(run));
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
        expect(serializeCost(run, costOf(run)).segments).toBeNull();
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

    it("没采到样的运行：旧面积记 0，CU 2.0 记 null（不给 0 分也不给满分）", () => {
        const run = record({ samples: [] });
        const cost = costOf(run);
        expect(cost.sampleCount).toBe(0);
        expect(cost.cu).toBe(0);
        const score = serializeCost(run, cost);
        expect(score.score).toBeNull();
        expect(score.invalidReasons).toContain("empty-samples");
    });

    it("缺 CSV / 坏行 / 缺 child 列 / 无 tree 的记录都不可评分", () => {
        const cases: Partial<RunRecord>[] = [
            { invalidReasons: ["missing-csv"], samples: [] },
            { invalidReasons: ["malformed-csv"] },
            { invalidReasons: ["invalid-csv-columns"], samples: [] },
            { childColumnPresent: false },
            { withTree: false },
            { samplingBackend: "ps" },
            { endToEndMs: null },
            { invalidReasons: ["unsuccessful-exit"], status: "harness-exit" },
        ];
        for (const patch of cases) {
            const run = record(patch);
            const score = serializeCost(run, costOf(run));
            expect(score).toMatchObject({ score: null, valid: false });
            expect(score.invalidReasons.length).toBeGreaterThan(0);
        }
    });
});

describe("selectRuns：重复运行的聚合与代表运行", () => {
    const MB = 1024 * 1024;
    /**
     * 造一次「能出分」的运行：1 拍、满转 sampleCpu%、常驻 100MB，时长与退出时刻都可控。
     * 100MB 的峰值负担（≈0.098）压在预算之下，便于让时长/CPU 拉开分数差距、手算排序。
     *
     * `conditions` 默认按身份/剧本/label 现推（与 collectFromRunsDir 里的形状一致），
     * 这样测试里改 label 或 SHA 就等于真的换了计划；要造「条件同、证据不同」的用例就显式传。
     */
    const run = (
        runId: string,
        overrides: Partial<RunRecord> = {},
        sampleCpu = 100,
    ): RunRecord => {
        const endToEndMs = overrides.endToEndMs ?? 1_000;
        const base = {
            runId,
            harnessId: "peri",
            name: "peri",
            commandLine: null,
            script: "data/scenarios/long-run.json",
            endToEndMs,
            status: "ok",
            withTree: true,
            samplingBackend: "rusage",
            scenarioSha: "same-sha" as string | null,
            invalidReasons: [],
            samplingWindowMs: endToEndMs,
            requests: 100,
            segments: null,
            requestMarksMs: null,
            harnessExitedAtMs: 1_700_000_000_000 + endToEndMs,
            samples: [{
                ts: 1_700_000_000_000 + endToEndMs,
                elapsedMs: endToEndMs,
                cpuPercent: sampleCpu,
                treeCpuPercent: sampleCpu,
                childCpuPercent: 0,
                rssBytes: 100 * MB,
                treeRssBytes: 100 * MB,
                procs: 1,
            }],
            childColumnPresent: true,
            label: "batch-a" as string | null,
            ...overrides,
        };
        return {
            ...base,
            conditions:
                overrides.conditions ?? {
                    harnessId: base.harnessId,
                    // 与写入端一致：没带 --label 就是空串（「没带」是已知事实，不是未知）
                    label: base.label ?? "",
                    script: base.script,
                    // 写入端在 SHA 未知时用 runId 占位（见 planConditions）
                    scenarioSha: base.scenarioSha ?? `unknown:${runId}`,
                    // 采样与 harness 身份这些「跑之前就定下」的键照抄 run.json 的形状
                    "sampling.intervalMs": "100",
                    "sampling.withTree": "true",
                    "harness.id": base.harnessId,
                    "harness.binary.mtimeMs": "111",
                },
        };
    };

    it("最新 3 次逐次算分，取分数中位的那一次真实运行（不是各项分别取中位）", () => {
        // 依次更贵：第 2 次（2000ms / 100%）分数居中 → 出曲线的就是它
        const runs = [run("20260919-130400", { endToEndMs: 2_000 }), run("20260919-130300", { endToEndMs: 1_000 }), run("20260919-130200", { endToEndMs: 4_000 })];
        const selected = selectRuns(runs, 3);
        expect(selected.run.runId).toBe("20260919-130400");
        expect(selected.score.valid).toBe(true);
        expect(selected.repetitions).toMatchObject({
            mode: "latest-compatible",
            requestedCount: 3,
            actualCount: 3,
            validCount: 3,
            complete: true,
            representativeRunId: "20260919-130400",
            medianRule: "lower-score-median",
        });
        // 逐次分数与 runIds 一一对应（顺序是新 → 旧）
        expect(selected.repetitions.runIds).toEqual(["20260919-130400", "20260919-130300", "20260919-130200"]);
        const scores = selected.repetitions.scores;
        // payload 里的分数收敛到两位小数（页面直接显示这个数）
        expect(scores[0]!).toBeCloseTo(100 / 1.2, 2); // T = 2s → L = 0.2
        expect(scores[1]!).toBeCloseTo(100 / 1.1, 2);
        expect(scores[2]!).toBeCloseTo(100 / 1.4, 2);
        // 代表运行的分数就是分数中位那一次的分（曲线与分数同源）
        expect(selected.score.score).toBe(scores[0]!);
    });

    it("分数中位 ≠ 时间中位：按时间挑会挑错人", () => {
        // 时长中位是 2s 那次；但 CPU 300% 让 1s 与 3s 两次更贵，分数中位落在 1s 那次。
        const runs = [
            run("20260919-131000", { endToEndMs: 1_000 }, 300),
            run("20260919-130900", { endToEndMs: 2_000 }, 100),
            run("20260919-130800", { endToEndMs: 3_000 }, 300),
        ];
        const selected = selectRuns(runs, 3);
        const byDuration = [...runs].sort((a, b) => (a.endToEndMs ?? 0) - (b.endToEndMs ?? 0))[1]!;
        expect(byDuration.runId).toBe("20260919-130900"); // 时长中位是 2s 那次
        expect(selected.run.runId).toBe("20260919-131000"); // 分数中位是 1s 那次
        const scores = selected.repetitions.scores;
        expect(scores[0]!).toBeCloseTo(100 / 1.3, 2); // 1s × 3 核
        expect(scores[1]!).toBeCloseTo(100 / 1.2, 2); // 2s × 1 核
        expect(scores[2]!).toBeCloseTo(100 / 1.9, 2); // 3s × 3 核
    });

    it("组内失败不剔除：失败占名额，聚合分为 null（不拿更早的成功子集充数）", () => {
        const runs = [
            run("20260919-132000", { status: "timeout" }),
            run("20260919-131900", { endToEndMs: 2_000 }),
            run("20260919-131800", { endToEndMs: 3_000 }),
            run("20260919-131700", { endToEndMs: 4_000 }), // 更早的成功运行：不该被拿来顶替
        ];
        const selected = selectRuns(runs, 3);
        expect(selected.repetitions.runIds).toEqual(["20260919-132000", "20260919-131900", "20260919-131800"]);
        expect(selected.repetitions.validCount).toBe(2);
        expect(selected.score.score).toBeNull();
        expect(selected.score.invalidReasons).toContain("invalid-repeat");
        // 代表运行仍是那个失败的（如实指出这次聚合里有失败项）
        expect(selected.run.runId).toBe("20260919-132000");
        expect(selected.repetitions.ignoredRunIds).toEqual(["20260919-131700"]);
    });

    it("凑不满 window 次就不给聚合分，并如实报告实际次数", () => {
        const runs = [run("20260919-133000"), run("20260919-132900")];
        const selected = selectRuns(runs, 3);
        expect(selected.repetitions).toMatchObject({ actualCount: 2, complete: false });
        expect(selected.score.score).toBeNull();
        expect(selected.score.invalidReasons).toContain("insufficient-repeats");
        // 但曲线本身还是真实的：那 2 次里选分数中位
        expect(selected.repetitions.scores.filter((value) => value !== null)).toHaveLength(2);
    });

    it("不同 label / SHA / 计划条件不与老组混：新单跑覆盖不了旧的完整组", () => {
        const base = {
            harnessId: "peri",
            label: "batch-a",
            script: "data/scenarios/long-run.json",
            scenarioSha: "same-sha",
            "sampling.intervalMs": "100",
            "sampling.withTree": "true",
            "harness.id": "peri",
            "harness.binary.mtimeMs": "111",
        };
        const old = [run("20260919-134000"), run("20260919-133900"), run("20260919-133800")];
        // oc2-cold 是新标签的单跑：它自成一档，老组的代表运行不变
        const mixed = [...old, run("20260919-134100", { label: "oc2-cold" })];
        const selected = selectRuns(mixed, 3);
        expect(selected.repetitions.runIds).toEqual(["20260919-134000", "20260919-133900", "20260919-133800"]);
        expect(selected.repetitions.ignoredRunIds).toEqual(["20260919-134100"]);

        // 剧本真不一样（SHA 不同）、采样间隔变了、harness 二进制换了：都算「另一种测法」，各自成组
        for (const patch of [
            { scenarioSha: "other-sha", conditions: { ...base, scenarioSha: "other-sha" } },
            { conditions: { ...base, "sampling.intervalMs": "200" } },
            { conditions: { ...base, "harness.binary.mtimeMs": "222" } },
        ]) {
            const split = selectRuns([...old, run("20260919-134200", patch)], 3);
            expect(split.repetitions.runIds).toEqual(["20260919-134000", "20260919-133900", "20260919-133800"]);
            expect(split.repetitions.ignoredRunIds).toEqual(["20260919-134200"]);
        }
        // 同标签的新完整组才是「最新完整兼容组」
        const newer = [
            run("20260919-135000", { label: "batch-b" }, 100),
            run("20260919-134900", { label: "batch-b" }, 200),
            run("20260919-134800", { label: "batch-b" }, 300),
        ];
        const switched = selectRuns([...old, ...newer], 3);
        expect(switched.repetitions.runIds).toEqual(["20260919-135000", "20260919-134900", "20260919-134800"]);
        expect(switched.repetitions.ignoredRunIds).toEqual(["20260919-134000", "20260919-133900", "20260919-133800"]);
        // 组内三次的分数是 100/1.1、100/1.2、100/1.3 → 中位那次（CPU 200% 的 134900）出曲线
        expect(switched.run.runId).toBe("20260919-134900");
    });

    it("证据缺失不拆组：最新那次缺 CSV 仍在同一组，聚合判 null（不给老组捡回分数）", () => {
        const ok = [run("20260919-150000"), run("20260919-145900"), run("20260919-145800")];
        // 最新那次没采到 samples.csv：childColumnPresent=false 是**证据缺失**，
        // 不是「另一种测法」——它必须留在组里占名额（旧实现会把它拆出去，让这 3 次成功照常出分）
        const missingCsv = run("20260919-150100", {
            childColumnPresent: false,
            invalidReasons: ["missing-csv"],
            samples: [],
        });
        const selected = selectRuns([...ok, missingCsv], 3);
        expect(selected.repetitions.runIds).toEqual([
            "20260919-150100",
            "20260919-150000",
            "20260919-145900",
        ]);
        expect(selected.repetitions.actualCount).toBe(3);
        expect(selected.repetitions.validCount).toBe(2);
        expect(selected.repetitions.ignoredRunIds).toEqual(["20260919-145800"]);
        expect(selected.score.score).toBeNull();
        expect(selected.score.invalidReasons).toContain("invalid-repeat");
    });

    it("中位选择用**未舍入**分数：三次都舍入到 80.0 时不会按 runId 挑错 run", () => {
        // 三次都 1s、100MB，只有 CPU 差一点：80.0038 / 80.0013 / 80.0026（展示值全是 80.0）
        const runs = [
            run("20260919-160100", { endToEndMs: 1_000 }, 249.94), // 最旧：raw 80.0038…
            run("20260919-160200", { endToEndMs: 1_000 }, 249.98), // 中间：raw 80.0013…
            run("20260919-160300", { endToEndMs: 1_000 }, 249.96), // 最新：raw 80.0026…
        ];
        const selected = selectRuns(runs, 3);
        const scores = selected.repetitions.scores;
        // 展示值确实并列（拿它排序就会退化成按 runId 选中间那次）
        expect(new Set(scores).size).toBe(1);
        expect(scores).toEqual([80, 80, 80]);
        // 真实顺序：中间(80.0013) < 最新(80.0026) < 最旧(80.0038) → 中位是**最新**那次
        expect(selected.run.runId).toBe("20260919-160300");
        expect(selected.score.score).toBe(80);
        expect(selected.repetitions.representativeRunId).toBe("20260919-160300");
    });

    it("scenario SHA 缺失（老记录）不能证明是同一份剧本 → 各自成组、不给聚合分", () => {
        const legacy = ["20260919-136000", "20260919-135900", "20260919-135800"].map((id) =>
            run(id, {
                scenarioSha: null,
                // 写入端在 SHA 未知时会用 runId 占位（见 planConditions）：这里照抄那个形状
                conditions: { harnessId: "peri", script: "data/scenarios/long-run.json", scenarioSha: `unknown:${id}` },
                childColumnPresent: false,
                harnessExitedAtMs: null,
            }),
        );
        const selected = selectRuns(legacy, 3);
        expect(selected.repetitions.actualCount).toBe(1);
        expect(selected.score.score).toBeNull();
        // 老记录读得进来（能画曲线），但没有聚合资格
        expect(selected.run.runId).toBe("20260919-136000");
    });

    it("--pick（explicit）按点名出分并标实际次数；不兼容的组合直接报错", () => {
        const single = run("20260919-137000");
        const picked = selectRuns([single], 3, true);
        expect(picked.score.valid).toBe(true);
        expect(picked.repetitions).toMatchObject({
            mode: "explicit-pick",
            requestedCount: 1,
            actualCount: 1,
            complete: true,
        });
        // 点了两次但条件不同：不拼，报错
        expect(() => selectRuns([single, run("20260919-137100", { label: "other" })], 3, true)).toThrow("不一致");
        // 点名的多次都是同一组：逐次算分取中位（两次时取**较低**中位分那次，宁可保守）
        const pair = selectRuns([run("20260919-137200"), run("20260919-137300", { endToEndMs: 2_000 })], 3, true);
        expect(pair.repetitions.actualCount).toBe(2);
        expect(pair.repetitions.representativeRunId).toBe("20260919-137300");
        expect(pair.repetitions.scores[0]!).toBeCloseTo(100 / 1.2, 2);
        expect(pair.repetitions.scores[1]!).toBeCloseTo(100 / 1.1, 2);
    });
});

describe("图表 CLI 协议（合成产物，不跑 harness）", () => {
    /** 跑一次生成器（子进程），返回写出的 payload。 */
    function runCli(dir: string, out: string, ...args: string[]): Record<string, unknown> {
        const result = Bun.spawnSync(
            [process.execPath, join(import.meta.dir, "gen-chart-data.ts"), "--dir", dir, "--out", out, ...args],
            { stderr: "pipe", stdout: "pipe" },
        );
        if (result.exitCode !== 0) {
            throw new Error(`生成器退出码 ${result.exitCode}：${result.stderr.toString()}`);
        }
        return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    }

    /** 一次「证据齐全」的运行：2s、满核、100MB（三项负担都低于预算）。 */
    function scoredRun(root: string, runId: string, overrides: Partial<RunMeta> = {}): void {
        const dir = writeRun(root, "peri", runId, {
            scenario: {
                path: "/repo/data/scenarios/long-run.json",
                relPath: "data/scenarios/long-run.json",
                name: "long-run.json",
                sizeBytes: 1,
                sha256: "same-sha",
            },
            timing: {
                harnessStartedAtMs: 1_700_000_000_000,
                samplingStartedAtMs: 1_700_000_000_000,
                firstRequestAtMs: null,
                lastRequestAtMs: null,
                harnessExitedAtMs: 1_700_000_002_000,
            },
            duration: { endToEndMs: 2_000, samplingWindowMs: 2_000 },
            ...overrides,
        });
        writeFileSync(
            join(dir, "samples.csv"),
            `${CSV_HEADER}\n2023-11-14T22:13:22.000Z,2000,100,102400,100,102400,1,0\n`,
        );
    }

    it("每轮换本地端口不算换计划；最新那次早期 setup 失败（没写 env、没 CSV）留在组里判 null", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-cu2-ports-"));
        try {
            const scenario = {
                path: "/repo/data/scenarios/long-run.json",
                relPath: "data/scenarios/long-run.json",
                name: "long-run.json",
                sizeBytes: 1,
                sha256: "same-sha",
            };
            const timing = {
                harnessStartedAtMs: 1_700_000_000_000,
                samplingStartedAtMs: 1_700_000_000_000,
                firstRequestAtMs: null,
                lastRequestAtMs: null,
                harnessExitedAtMs: 1_700_000_002_000,
            };
            /** harness 命令与环境里都带着本轮 mock 端口（codex 那种 `-c …base_url=…` 形状）。 */
            const harnessOn = (port: number, env: Record<string, string> | null): RunMeta["harness"] => ({
                id: "peri",
                idSource: "explicit",
                command: ["/bin/peri", "-c", `model_providers.llm-mock.base_url=http://127.0.0.1:${port}/v1`],
                commandLine: `/bin/peri -c model_providers.llm-mock.base_url=http://127.0.0.1:${port}/v1`,
                cwd: "/repo/playground/peri",
                binary: null,
                version: null,
                env,
            });
            const ports = [41_100, 41_200, 41_300];
            const okIds = ["20260919-170100", "20260919-170200", "20260919-170300"];
            okIds.forEach((id, index) => {
                const port = ports[index]!;
                const dir = writeRun(root, "peri", id, {
                    scenario,
                    timing,
                    duration: { endToEndMs: 2_000, samplingWindowMs: 2_000 },
                    mock: { port, exhausted: "stop", readyMs: 100, requests: 100, requestsSource: "status", cursor: null },
                    harness: harnessOn(port, {
                        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
                        HOME: "/repo/playground/peri/.peri",
                    }),
                });
                writeFileSync(
                    join(dir, "samples.csv"),
                    `${CSV_HEADER}\n2023-11-14T22:13:22.000Z,2000,100,102400,100,102400,1,0\n`,
                );
            });
            // 最新那次：mock 就没起来，harness.env 还是 null、samples.csv 是空的（早退路径的真实形状）
            const failedDir = writeRun(root, "peri", "20260919-170400", {
                scenario,
                timing: { ...timing, harnessExitedAtMs: null },
                duration: { endToEndMs: null, samplingWindowMs: null },
                status: "setup-error",
                error: "mock 剧本不存在: /nope.json",
                mock: { port: 41_400, exhausted: "stop", readyMs: null, requests: null, requestsSource: null, cursor: null },
                harness: harnessOn(41_400, null),
            });
            rmSync(join(failedDir, "samples.csv"));

            const selected = selectRuns(collectFromRunsDir(root).runs, 3);
            // 端口换了三轮仍是一组；早退那次缺 env/CSV 也在组里占名额（不剔除、不回退到旧成功组）
            expect(selected.repetitions.runIds).toEqual([
                "20260919-170400",
                "20260919-170300",
                "20260919-170200",
            ]);
            expect(selected.repetitions.validCount).toBe(2);
            expect(selected.repetitions.ignoredRunIds).toEqual(["20260919-170100"]);
            expect(selected.score.score).toBeNull();
            expect(selected.score.invalidReasons).toContain("invalid-repeat");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("公式 payload 与 score.ts 同源，主 score 是绝对分并带负担与有效性", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-cu2-cli-"));
        try {
            for (const id of ["20260919-140100", "20260919-140200", "20260919-140300"]) scoredRun(root, id);
            const payload = runCli(root, join(root, "chart.json"));
            // 公式块逐字段等于 score.ts 里那一个常量（页面/报告不许自己记一份公式）
            expect(payload.scoreFormula).toEqual(CU2_FORMULA);
            expect((payload.scoreFormula as typeof CU2_FORMULA).budgetScore).toBe(50);
            expect((payload.scoreFormula as typeof CU2_FORMULA).sortDirection).toBe("descending");
            expect(payload.pickRule).toContain("CU 2.0 score");

            const runs = payload.runs as Record<string, unknown>[];
            expect(runs).toHaveLength(1);
            const score = runs[0]!.score as Record<string, unknown>;
            expect(score.scoreVersion).toBe("cu2-beta");
            expect(score.valid).toBe(true);
            // 主分数就是 100/(1+L)，L 是四项预算负担的最大值
            const burden = score.burden as number;
            expect(score.score).toBeCloseTo(100 / (1 + burden), 2);
            expect(score.burdens).toBeTruthy();
            expect(score.metrics).toBeTruthy();
            // 旧字段仍在（老页面按它画图/列示），但已不是名次依据
            expect(score.cu as number).toBeGreaterThan(0);
            expect(score.tailGapKnown).toBe(true);
            const repetitions = runs[0]!.repetitions as Record<string, unknown>;
            expect(repetitions.actualCount).toBe(3);
            expect(repetitions.complete).toBe(true);
            expect(repetitions.runIds as string[]).toHaveLength(3);
            expect(runs[0]!.scenarioSha).toBe("same-sha");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("组内混入失败运行 → 聚合分为 null；--pick 可显式单看一次并标实际次数", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-cu2-pick-"));
        try {
            for (const id of ["20260919-141100", "20260919-141200", "20260919-141300"]) scoredRun(root, id);
            // 新单跑失败：占名额 → 这一组不给聚合分（也不回退到更早的成功组）
            scoredRun(root, "20260919-141400", { status: "timeout" });
            const failed = runCli(root, join(root, "chart.json"));
            const failedRun = (failed.runs as Record<string, unknown>[])[0]!;
            const score = failedRun.score as Record<string, unknown>;
            expect(score.score).toBeNull();
            expect(score.valid).toBe(false);
            expect(score.invalidReasons).toContain("invalid-repeat");
            // 最新 3 次里的那次失败照样占名额：它被算作「实际 3 次、有效 2 次」，
            // 更早的成功运行（141100）不会被拉来顶替
            const repeated = failedRun.repetitions as Record<string, unknown>;
            expect(repeated.actualCount).toBe(3);
            expect(repeated.validCount).toBe(2);
            expect(repeated.ignoredRunIds).toEqual(["20260919-141100"]);

            // --pick 显式选一次成功的：出分，并标明实际次数是 1
            const picked = runCli(root, join(root, "picked.json"), "--pick", "20260919-141200");
            const pickedRun = (picked.runs as Record<string, unknown>[])[0]!;
            expect((pickedRun.score as Record<string, unknown>).valid).toBe(true);
            expect(pickedRun.repetitions).toMatchObject({
                mode: "explicit-pick",
                actualCount: 1,
                requestedCount: 1,
                complete: true,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("缺 CSV / 坏行 / 缺列 / 缺时长 / 无 tree 都读得进来，但一律不评分", () => {
        const root = mkdtempSync(join(tmpdir(), "llm-mock-cu2-bad-"));
        try {
            rmSync(join(writeRun(root, "peri", "20260919-142100"), "samples.csv")); // 缺 CSV
            writeFileSync(
                join(writeRun(root, "peri", "20260919-142200"), "samples.csv"),
                `${CSV_HEADER}\n2026-09-19T00:00:00.000Z,,100,1024,100,1024,1,0\n`, // 坏行
            );
            writeFileSync(
                join(writeRun(root, "peri", "20260919-142300"), "samples.csv"),
                "ts,elapsed_ms,cpu_pct\n2026-09-19T00:00:00.000Z,100,10\n", // 缺必需列
            );
            writeFileSync(
                join(writeRun(root, "peri", "20260919-142400"), "samples.csv"),
                "ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs\n" +
                    "2026-09-19T00:00:00.000Z,100,24.77,42752,24.77,42752,1\n", // 缺 child 列（老表头）
            );
            // 没采进程树
            writeRun(root, "peri", "20260919-142500", {
                sampling: { intervalMs: 100, backend: "rusage", withTree: false, format: "csv" },
            });
            // 缺端到端时长
            writeRun(root, "peri", "20260919-142600", { duration: { endToEndMs: null, samplingWindowMs: null } });

            const payload = runCli(root, join(root, "chart.json"));
            // 读到的记录数与目录里的运行数一致（一次都不丢），且每条都有原因
            const collected = collectFromRunsDir(root).runs;
            expect(collected).toHaveLength(6);
            for (const run of collected) {
                const score = serializeCost(run, costOf(run));
                expect(score.score).toBeNull();
                expect(score.valid).toBe(false);
                expect(score.invalidReasons.length).toBeGreaterThan(0);
            }
            // payload 里每个 harness 仍只出一条曲线：曲线本体给出来（能诊断），分数为 null
            const runs = payload.runs as Record<string, unknown>[];
            expect(runs).toHaveLength(1);
            expect((runs[0]!.score as Record<string, unknown>).score).toBeNull();
            expect(Array.isArray(runs[0]!.samples)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
