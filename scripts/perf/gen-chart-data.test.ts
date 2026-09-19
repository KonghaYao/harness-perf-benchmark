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
    isLongRunScript,
    pickMedianOfLatest,
    SAMPLE_COLUMNS,
    type RunRecord,
} from "./gen-chart-data";
import { RUN_META_SCHEMA_VERSION, type RunMeta } from "./run-meta";
import { CSV_HEADER } from "./sampler";

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
        expect(run.samples[0]).toEqual([100, 22.8, 22096, 22.8, 22096, 1]);
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
        samples: [[100, 1, 1, 1, 1, 1]],
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
