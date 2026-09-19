import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { REPO_ROOT, formatRunId, loadPerfConfig } from "./config";

describe("loadPerfConfig", () => {
    it("内置默认值：100ms 采样、60s 兜底、loop 剧本、playground/peri 工作目录", () => {
        const config = loadPerfConfig([], REPO_ROOT);
        expect(config).toMatchObject({
            turns: 25,
            intervalMs: 100,
            timeoutMs: 60_000,
            readyTimeoutMs: 10_000,
            port: 3457,
            exhausted: "loop",
            sampler: "rusage",
            withTree: true,
            periArgs: [],
        });
        expect(config.scriptPath).toBe(resolve(REPO_ROOT, "scripts/perf-scenario.json"));
        expect(config.periPath).toBe(resolve(REPO_ROOT, "../perihelion/target/debug/peri"));
        expect(config.workDir).toBe(resolve(REPO_ROOT, "playground/peri"));
        expect(config.outDir).toBe(resolve(REPO_ROOT, "data/claude-date"));
    });

    it("可覆盖各项参数；相对路径按传入的 cwd 解析", () => {
        const config = loadPerfConfig(
            [
                "--turns",
                "30",
                "--interval-ms",
                "50",
                "--timeout-ms",
                "90000",
                "--ready-timeout-ms",
                "3000",
                "--prompt",
                "跑起来",
                "--script",
                "s.json",
                "--peri",
                "./bin/peri",
                "--work-dir",
                "sandbox",
                "--out-dir",
                "out",
                "--port",
                "4000",
                "--exhausted",
                "hold",
                "--sampler",
                "ps",
                "--no-tree",
            ],
            "/tmp/work",
        );
        expect(config).toMatchObject({
            turns: 30,
            intervalMs: 50,
            timeoutMs: 90_000,
            readyTimeoutMs: 3000,
            prompt: "跑起来",
            port: 4000,
            exhausted: "hold",
            sampler: "ps",
            withTree: false,
        });
        expect(config.scriptPath).toBe("/tmp/work/s.json");
        expect(config.periPath).toBe("/tmp/work/bin/peri");
        expect(config.workDir).toBe("/tmp/work/sandbox");
        expect(config.outDir).toBe("/tmp/work/out");
    });

    it("--peri-arg 可重复，按顺序透传", () => {
        // 值以 - 开头时必须写 --peri-arg=<值>（parseArgs 的规则），普通值可空格分隔
        const config = loadPerfConfig(
            ["--peri-arg=--db-path", "--peri-arg=/tmp/p.db", "--peri-arg", "/tmp/extra"],
            REPO_ROOT,
        );
        expect(config.periArgs).toEqual(["--db-path", "/tmp/p.db", "/tmp/extra"]);
    });

    it("非法取值给出可定位的错误", () => {
        expect(() => loadPerfConfig(["--interval-ms", "0"], REPO_ROOT)).toThrow(/interval-ms/);
        expect(() => loadPerfConfig(["--interval-ms", "abc"], REPO_ROOT)).toThrow(/interval-ms/);
        expect(() => loadPerfConfig(["--timeout-ms", "10"], REPO_ROOT)).toThrow(/timeout-ms/);
        expect(() => loadPerfConfig(["--turns", "0"], REPO_ROOT)).toThrow(/turns/);
        expect(() => loadPerfConfig(["--port", "70000"], REPO_ROOT)).toThrow(/port/);
        expect(() => loadPerfConfig(["--sampler", "nope"], REPO_ROOT)).toThrow(/sampler/);
        expect(() => loadPerfConfig(["--exhausted", "nope"], REPO_ROOT)).toThrow(/exhausted/);
        expect(() => loadPerfConfig(["--prompt", "   "], REPO_ROOT)).toThrow(/prompt/);
    });

    it("拒绝未知参数", () => {
        expect(() => loadPerfConfig(["--nope"], REPO_ROOT)).toThrow();
        expect(() => loadPerfConfig(["positional"], REPO_ROOT)).toThrow();
    });
});

describe("formatRunId", () => {
    it("按 YYYYMMDD-HHMMSS 补零", () => {
        expect(formatRunId(new Date(2026, 8, 19, 15, 30, 12))).toBe("20260919-153012");
        expect(formatRunId(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
    });
});
