/**
 * 迁移脚本的单元测试：幂等、部分迁移、冲突留档、拒迁年轻文件、status 判定。
 * 真迁移（data/claude-date → data/runs）由命令行执行并用 chart-before/after diff 验收，
 * 不在这里跑。
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLayout, scanSource } from "./migrate-layout";
import { legacyStatusOf } from "./legacy-run";
import { CSV_HEADER } from "./sampler";

/** 老布局的一次运行（可控 endToEnd / 请求数 / 结尾标志）。 */
function writeFlatRun(
    dir: string,
    runId: string,
    options: { command?: string; endToEnd?: string; summary?: boolean; exitCode?: number; tail?: string[] } = {},
): void {
    const command = options.command ?? "/Users/x/.peri/peri -p '压测' --max-turns 100";
    writeFileSync(
        join(dir, `${runId}-perf.log`),
        [
            "# llm-mock 压测记录",
            `runId: ${runId}`,
            "开始: 2026-09-19T00:00:00.000Z",
            "",
            `[+0.001s] 启动 mock: bun run /repo/src/server.ts --script /repo/data/scenarios/long-run.json --port 3480 --exhausted stop`,
            `[+0.106s] 启动 harness: ${command}（cwd=/repo/playground/peri）`,
            `[+0.108s] 采样开始: proc_pid_rusage（1 tick = 41.67 ns），间隔 100ms，落盘周期 1000ms`,
            `mock 请求数: 102（5.7 次/秒）`,
            `mock 游标: index=100 / 100`,
            `端到端时长: ${options.endToEnd ?? "9.2"}s（harness 启动 → 退出；采样窗口 9.1s）`,
            `时长分段: 启动 → 首个请求 1.7s ｜ 首个请求 → 末次请求 2.5s ｜ 末次请求 → 退出 5.1s（收尾零请求：…）`,
            `harness 退出: code=${options.exitCode ?? 0} signal=无`,
            ...(options.summary === false ? [] : ["=== 摘要 ==="]),
            ...(options.tail ?? []),
        ].join("\n") + "\n",
    );
    writeFileSync(
        join(dir, `${runId}-samples.csv`),
        `${CSV_HEADER}\n2026-09-19T00:00:01.000Z,100,22.84,22096,22.84,22096,1\n`,
    );
    writeFileSync(join(dir, `${runId}-harness.log`), "harness 输出\n");
    writeFileSync(join(dir, `${runId}-mock.log`), "mock 输出\n");
}

function tempRoot(): { from: string; to: string } {
    const root = mkdtempSync(join(tmpdir(), "llm-mock-migrate-"));
    const from = join(root, "claude-date");
    const to = join(root, "runs");
    mkdirSync(from, { recursive: true });
    return { from, to };
}

const options = (from: string, to: string) => ({
    from,
    to,
    minAgeSec: 0,
    dryRun: false,
    copy: false,
    force: false,
});

describe("scanSource", () => {
    it("按 runId 把四个文件归组", () => {
        const { from } = tempRoot();
        writeFlatRun(from, "20260919-133902");
        writeFlatRun(from, "20260919-133915");
        const runs = scanSource(from);
        expect(runs.map((run) => run.runId)).toEqual(["20260919-133902", "20260919-133915"]);
        expect(Object.keys(runs[0]!.files).sort()).toEqual(["harness", "mock", "perf", "samples"]);
    });
});

describe("migrateLayout", () => {
    it("搬成 <to>/<harness>/<runId>/ 并写出可由读取端消费的 run.json", () => {
        const { from, to } = tempRoot();
        writeFlatRun(from, "20260919-133902");
        const report = migrateLayout(options(from, to));

        expect(report.migrated).toEqual(["peri/20260919-133902"]);
        const runDir = join(to, "peri", "20260919-133902");
        expect(readdirSync(runDir).sort()).toEqual([
            "harness.log",
            "mock.log",
            "perf.log",
            "run.json",
            "samples.csv",
        ]);
        // 源文件已搬走
        expect(readdirSync(from)).toEqual([]);

        const meta = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as Record<string, unknown>;
        expect(meta).toMatchObject({
            schemaVersion: 1,
            runId: "20260919-133902",
            status: "ok",
            summarySource: "samples",
            duration: { endToEndMs: 9_200, samplingWindowMs: 9_100 },
            segments: { startupMs: 1_700, spanMs: 2_500, tailMs: 5_100, idleTail: true },
            legacy: { layout: "flat" },
        });
        expect((meta.harness as Record<string, unknown>).id).toBe("peri");
        expect((meta.harness as Record<string, unknown>).idSource).toBe("command");
        // 老日志里没有绝对时刻：不猜
        expect((meta.timing as Record<string, unknown>).firstRequestAtMs).toBeNull();
        // 摘要由 samples.csv 重算
        expect((meta.summary as Record<string, number>).count).toBe(1);
    });

    it("幂等：连跑两次，第二次全部跳过", () => {
        const { from, to } = tempRoot();
        writeFlatRun(from, "20260919-133902");
        migrateLayout(options(from, to));
        const before = readFileSync(join(to, "peri", "20260919-133902", "run.json"), "utf8");
        const second = migrateLayout(options(from, to));

        expect(second.migrated).toEqual([]);
        // 源文件已被搬空，第二次无事可做（这才是 move 语义下的幂等）
        expect(second.skipped).toEqual([]);
        expect(second.tooYoung).toEqual([]);
        // 目标侧的 run.json 原封不动：不重写、不追加
        expect(readFileSync(join(to, "peri", "20260919-133902", "run.json"), "utf8")).toBe(before);
    });

    it("同一次运行横跨两种布局：已有目标目录时补搬缺的文件，不写第二份 run.json", () => {
        const { from, to } = tempRoot();
        writeFlatRun(from, "20260919-133902");
        // 先手工造出「新布局已建目录、只差 samples.csv」的中间态
        const runDir = join(to, "peri", "20260919-133902");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "run.json"), "{}");
        const report = migrateLayout(options(from, to));

        expect(report.skipped.join()).toContain("20260919-133902");
        // 目标侧的 run.json 不被覆盖（内容还是我们塞进去的占位）
        expect(readFileSync(join(runDir, "run.json"), "utf8")).toBe("{}");
    });

    it("两侧同名文件大小不同：源文件改名留档，不覆盖也不丢", () => {
        const { from, to } = tempRoot();
        writeFlatRun(from, "20260919-133902");
        const runDir = join(to, "peri", "20260919-133902");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "samples.csv"), "完全不同的内容\n");

        // 目标目录里没有 run.json，所以这次会被当成待迁移（测试的是文件级冲突）
        const report = migrateLayout({ ...options(from, to), minAgeSec: 0 });
        const files = readdirSync(runDir).sort();
        expect(files.some((name) => name.startsWith("samples.csv.conflict-"))).toBe(true);
        expect(report.conflicts).toHaveLength(1);
    });

    it("拒迁「刚写完」的文件组（防搬走正在 append 的产物）", () => {
        const { from, to } = tempRoot();
        writeFlatRun(from, "20260919-133902");
        const report = migrateLayout({ ...options(from, to), minAgeSec: 3600 });

        expect(report.migrated).toEqual([]);
        expect(report.tooYoung).toHaveLength(1);
        expect(existsSync(join(to, "peri", "20260919-133902"))).toBe(false);
        // --force 越过保护
        expect(migrateLayout({ ...options(from, to), minAgeSec: 3600, force: true }).migrated).toEqual([
            "peri/20260919-133902",
        ]);
    });

    it("harness 反推不出来时落到 unknown/，并报出来", () => {
        const { from, to } = tempRoot();
        writeFlatRun(from, "20260919-133902");
        writeFileSync(join(from, "20260919-133902-perf.log"), "不是一次运行的日志\n");
        const report = migrateLayout(options(from, to));

        expect(report.unknownHarness).toEqual(["20260919-133902"]);
        expect(readdirSync(join(to, "unknown"))).toEqual(["20260919-133902"]);
    });

    it("dry-run 不动任何文件", () => {
        const { from, to } = tempRoot();
        writeFlatRun(from, "20260919-133902");
        const report = migrateLayout({ ...options(from, to), dryRun: true });
        expect(report.migrated).toEqual(["peri/20260919-133902"]);
        expect(existsSync(to)).toBe(false);
        expect(readdirSync(from)).toHaveLength(4);
    });
});

describe("legacyStatusOf", () => {
    const withTail = (...tail: string[]): string => `启动 harness: peri\n${tail.join("\n")}`;

    it("按结尾标志判定结果", () => {
        expect(legacyStatusOf(withTail("=== 摘要 ==="), { code: 0 })).toBe("ok");
        expect(legacyStatusOf(withTail("=== 摘要 ==="), { code: 7 })).toBe("harness-exit");
        expect(legacyStatusOf(withTail("超时 60000ms: 终止 harness"), null)).toBe("timeout");
        expect(legacyStatusOf(withTail("收到中断信号: 终止 harness"), null)).toBe("interrupted");
        expect(legacyStatusOf(withTail("错误 mock 剧本不存在: /x.json"), null)).toBe("incomplete");
        expect(legacyStatusOf("错误 mock 剧本不存在: /x.json", null)).toBe("setup-error");
        expect(legacyStatusOf(withTail(), null)).toBe("incomplete");
    });
});
