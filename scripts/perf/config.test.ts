import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { REPO_ROOT, defaultHarnessPath, formatRunId, loadPerfConfig } from "./config";

/** 剧本必填后，多数用例只关心被覆盖的那几项，统一在这里补一个占位路径。 */
const argvWithScript = (...args: string[]): string[] => ["--script", "s.json", ...args];

describe("loadPerfConfig", () => {
    it("内置默认值：100ms 采样、60s 兜底、loop 耗尽策略、playground/peri 工作目录", () => {
        const config = loadPerfConfig(argvWithScript(), REPO_ROOT);
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
        expect(config.scriptPath).toBe(resolve(REPO_ROOT, "s.json"));
        expect(config.periPath).toBe(defaultHarnessPath());
        expect(config.workDir).toBe(resolve(REPO_ROOT, "playground/peri"));
        expect(config.outDir).toBe(resolve(REPO_ROOT, "data/runs"));
        // harness 身份默认由 run.ts 从启动命令推断，config 层给 null
        expect(config.harnessId).toBeNull();
        expect(config.label).toBeNull();
    });

    it("剧本必填：没有 --script 直接报错，不给隐式默认剧本", () => {
        expect(() => loadPerfConfig([], REPO_ROOT)).toThrow(/--script/);
        // 空串等同于没给：parseArgs 允许 --script ""，但那不该被当成一份剧本路径
        expect(() => loadPerfConfig(["--script", "  "], REPO_ROOT)).toThrow(/--script/);
    });

    it("defaults.scriptPath：demo 带自家默认剧本，用户显式传的 --script 优先", () => {
        const defaults = { scriptPath: "data/scenarios/long-run.json" };
        // 各家 demo 的用法：没传 --script 时用 defaults（相对 cwd 解析）
        expect(loadPerfConfig([], REPO_ROOT, defaults).scriptPath).toBe(
            resolve(REPO_ROOT, "data/scenarios/long-run.json"),
        );
        expect(loadPerfConfig(["--script", "mine.json"], REPO_ROOT, defaults).scriptPath).toBe(
            resolve(REPO_ROOT, "mine.json"),
        );
        // 空串等同于没给，在 demo 里落到 defaults 上（run.ts 不传 defaults，仍是必填报错）
        expect(loadPerfConfig(["--script", " "], REPO_ROOT, defaults).scriptPath).toBe(
            resolve(REPO_ROOT, "data/scenarios/long-run.json"),
        );
        // defaults 本身是空串也当没给
        expect(() => loadPerfConfig([], REPO_ROOT, { scriptPath: "  " })).toThrow(/--script/);
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
            argvWithScript("--peri-arg=--db-path", "--peri-arg=/tmp/p.db", "--peri-arg", "/tmp/extra"),
            REPO_ROOT,
        );
        expect(config.periArgs).toEqual(["--db-path", "/tmp/p.db", "/tmp/extra"]);
    });

    it("非法取值给出可定位的错误", () => {
        expect(() => loadPerfConfig(argvWithScript("--interval-ms", "0"), REPO_ROOT)).toThrow(
            /interval-ms/,
        );
        expect(() => loadPerfConfig(argvWithScript("--interval-ms", "abc"), REPO_ROOT)).toThrow(
            /interval-ms/,
        );
        expect(() => loadPerfConfig(argvWithScript("--timeout-ms", "10"), REPO_ROOT)).toThrow(
            /timeout-ms/,
        );
        expect(() => loadPerfConfig(argvWithScript("--turns", "0"), REPO_ROOT)).toThrow(/turns/);
        expect(() => loadPerfConfig(argvWithScript("--port", "70000"), REPO_ROOT)).toThrow(/port/);
        expect(() => loadPerfConfig(argvWithScript("--sampler", "nope"), REPO_ROOT)).toThrow(
            /sampler/,
        );
        expect(() => loadPerfConfig(argvWithScript("--exhausted", "nope"), REPO_ROOT)).toThrow(
            /exhausted/,
        );
        expect(() => loadPerfConfig(argvWithScript("--prompt", "   "), REPO_ROOT)).toThrow(/prompt/);
    });

    it("拒绝未知参数", () => {
        expect(() => loadPerfConfig(argvWithScript("--nope"), REPO_ROOT)).toThrow();
        expect(() => loadPerfConfig(["positional"], REPO_ROOT)).toThrow();
    });
});

describe("formatRunId", () => {
    it("按 YYYYMMDD-HHMMSS 补零", () => {
        expect(formatRunId(new Date(2026, 8, 19, 15, 30, 12))).toBe("20260919-153012");
        expect(formatRunId(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
    });
});
