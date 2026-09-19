/**
 * 压测编排的端到端测试：mock 用真 server，harness 用假进程（不依赖 peri）。
 *
 * 覆盖：正常跑完、采样对象提前退出（采样前 / 采样中）、超时强杀、mock 启动失败、端口占用。
 * 断言聚焦「退出码 / 产物 / 不留孤儿」；CPU 读数的精确性由 scripts/perf/verify.ts 验证。
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "./config";
import { EXIT_HARNESS, EXIT_SETUP, EXIT_TIMEOUT, runPerf } from "./run";

const SCENARIO = resolve(REPO_ROOT, "scripts/perf-scenario.json");
const tempDirs: string[] = [];
/** 每个用例换端口，避免相互抢占（mock 会真的监听）。 */
let nextPort = 41_000 + Math.floor(Math.random() * 5_000);

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "llm-mock-perf-test-"));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<PerfConfig> = {}): PerfConfig {
    return {
        turns: 5,
        intervalMs: 100,
        timeoutMs: 15_000,
        readyTimeoutMs: 10_000,
        prompt: "测试",
        scriptPath: SCENARIO,
        periPath: process.execPath,
        workDir: REPO_ROOT,
        outDir: tempDir(),
        port: nextPort++,
        exhausted: "loop",
        sampler: "rusage",
        withTree: true,
        periArgs: [],
        ...overrides,
    };
}

/** 产物目录里按后缀找唯一文件（runId 带时间戳，无法预先拼出完整名）。 */
function artifact(runDir: string, suffix: string): string {
    const name = readdirSync(runDir).find((entry) => entry.endsWith(suffix));
    if (name === undefined) throw new Error(`产物目录 ${runDir} 里没有 ${suffix}`);
    return join(runDir, name);
}

function listArtifacts(runDir: string): string[] {
    return readdirSync(runDir).sort();
}

/**
 * 假 harness：先 spawn 一个长命子进程并记下父子 pid，再忙转 ms 毫秒后按 code 退出。
 * 忙转是为了让采样器有非零读数可断言；子进程用于验证「按进程组回收」不留孤儿。
 */
function fakeHarness(ms: number, pidFile: string, code = 0): string[] {
    const script = `
        const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
        await Bun.write(${JSON.stringify(pidFile)}, JSON.stringify({ self: process.pid, child: child.pid }));
        const end = Date.now() + ${ms};
        let x = 0;
        while (Date.now() < end) x += Math.sqrt(Math.random());
        if (x < 0) console.log(x);
        process.exit(${code});
    `;
    return [process.execPath, "-e", script];
}

const isAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

/** 轮询等待 pid 消失（SIGKILL 后可能有极短的僵尸窗口）。 */
async function waitGone(pids: number[], timeoutMs = 2000): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const alive = pids.filter(isAlive);
        if (alive.length === 0) return [];
        await Bun.sleep(50);
    }
    return pids.filter(isAlive);
}

describe("runPerf 端到端", () => {
    it("真 mock + 假 harness：跑完留下四份产物、CSV 与摘要自洽", async () => {
        const config = makeConfig({ timeoutMs: 20_000 });
        const pidFile = join(config.outDir, "harness-pids.json");
        const lines: string[] = [];
        const code = await runPerf(config, {
            harnessCommand: () => fakeHarness(1_200, pidFile),
            log: (line) => lines.push(line),
        });

        expect(code).toBe(0);
        // 四份产物 + 假 harness 自己写的 pid 文件
        expect(listArtifacts(config.outDir).length).toBe(5);

        const csv = readFileSync(artifact(config.outDir, "-samples.csv"), "utf8")
            .trim()
            .split("\n");
        expect(csv[0]).toBe("ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs");
        const rows = csv.slice(1);
        // 忙转 1.2s、间隔 100ms：样本数 8~14
        expect(rows.length).toBeGreaterThanOrEqual(6);
        const cpu = rows.map((row) => Number(row.split(",")[2]));
        const rss = rows.map((row) => Number(row.split(",")[3]));
        expect(Math.max(...cpu)).toBeGreaterThan(5); // 忙转进程必须采到非零 CPU
        expect(cpu.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
        expect(rss.every((value) => value > 0)).toBe(true);

        const perf = readFileSync(artifact(config.outDir, "-perf.log"), "utf8");
        expect(perf).toContain("mock 就绪");
        expect(perf).toContain("采样开始");
        expect(perf).toContain("harness 退出: code=0");
        expect(perf).toContain("=== 摘要 ===");
        expect(perf).toMatch(/样本数: \d+/);

        // mock 真被用起来了：日志里有监听与请求记录
        const mockLog = readFileSync(artifact(config.outDir, "-mock.log"), "utf8");
        expect(mockLog).toContain("监听 http://localhost:");
        // 产物路径要打到 stdout，方便直接查看
        expect(lines.some((line) => line.includes("-perf.log"))).toBe(true);
    });

    it("harnessEnv 注入子进程，并写进 perf.log（凭据只留键名）", async () => {
        const config = makeConfig({ timeoutMs: 20_000 });
        const envFile = join(config.outDir, "harness-env.json");
        const script = `
            await Bun.write(${JSON.stringify(envFile)}, JSON.stringify({
                injected: process.env.LLM_MOCK_INJECTED ?? null,
                inherited: process.env.PATH === undefined ? null : "PATH",
            }));
            process.exit(0);
        `;
        const code = await runPerf(config, {
            harnessCommand: () => [process.execPath, "-e", script],
            harnessEnv: () => ({ LLM_MOCK_INJECTED: "hello", LLM_MOCK_API_KEY: "secret" }),
        });

        expect(code).toBe(0);
        const seen = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string | null>;
        expect(seen.injected).toBe("hello");
        // 注入是「追加」：原有环境（PATH 等）照旧。
        expect(seen.inherited).toBe("PATH");
        const perf = readFileSync(artifact(config.outDir, "-perf.log"), "utf8");
        expect(perf).toContain("LLM_MOCK_INJECTED=hello");
        expect(perf).toContain("LLM_MOCK_API_KEY='***'");
        expect(perf).not.toContain("secret");
    });

    it("不传 harnessEnv 时，运行时对 process.env 的赋值不会到达子进程", async () => {
        // Bun 1.4 的 Bun.spawn 不传 env 时用的是**进程启动时的环境快照**，
        // 这正是各 demo 必须走 harnessEnv 而不是 process.env.X = … 的原因。
        const config = makeConfig({ timeoutMs: 20_000 });
        const envFile = join(config.outDir, "harness-env.json");
        const script = `
            await Bun.write(${JSON.stringify(envFile)}, JSON.stringify({
                leaked: process.env.LLM_MOCK_SHOULD_NOT_LEAK ?? null,
            }));
            process.exit(0);
        `;
        process.env.LLM_MOCK_SHOULD_NOT_LEAK = "leaked";
        const code = await runPerf(config, {
            harnessCommand: () => [process.execPath, "-e", script],
        });
        delete process.env.LLM_MOCK_SHOULD_NOT_LEAK;

        expect(code).toBe(0);
        const seen = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string | null>;
        expect(seen.leaked).toBeNull();
    });

    it("超时 → 3，harness 及其子进程按进程组回收", async () => {
        const config = makeConfig({ timeoutMs: 1_000 });
        const pidFile = join(config.outDir, "harness-pids.json");
        const lines: string[] = [];
        const code = await runPerf(config, {
            harnessCommand: () => fakeHarness(60_000, pidFile),
            log: (line) => lines.push(line),
        });
        expect(code).toBe(EXIT_TIMEOUT);
        expect(lines.some((line) => line.includes("超时 1000ms"))).toBe(true);

        const perf = readFileSync(artifact(config.outDir, "-perf.log"), "utf8");
        expect(perf).toContain("超时 1000ms: 终止 harness");
        expect(perf).toContain("signal=SIGTERM");
        expect(perf).toContain("=== 摘要 ===");

        const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { self: number; child: number };
        expect(pids.self).toBeGreaterThan(0);
        expect(await waitGone([pids.self, pids.child])).toEqual([]);

        // mock 端口已释放
        const probe = Bun.serve({ port: config.port, fetch: () => new Response("ok") });
        probe.stop(true);
    });

    it("采样对象提前退出（非 0）→ 2，摘要照写", async () => {
        const config = makeConfig();
        const pidFile = join(config.outDir, "harness-pids.json");
        const lines: string[] = [];
        const code = await runPerf(config, {
            harnessCommand: () => fakeHarness(300, pidFile, 7),
            log: (line) => lines.push(line),
        });
        expect(code).toBe(EXIT_HARNESS);
        expect(lines.some((line) => line.includes("harness 非 0 退出"))).toBe(true);
        expect(readFileSync(artifact(config.outDir, "-perf.log"), "utf8")).toContain("=== 摘要 ===");
    });

    it("采样对象在首次采样前就退出 → 2，摘要说明样本为 0", async () => {
        const config = makeConfig({ intervalMs: 1_000 });
        const lines: string[] = [];
        const code = await runPerf(config, {
            harnessCommand: () => [process.execPath, "-e", "process.exit(3);"],
            log: (line) => lines.push(line),
        });
        expect(code).toBe(EXIT_HARNESS);
        const perf = readFileSync(artifact(config.outDir, "-perf.log"), "utf8");
        expect(perf).toContain("样本数: 0");
        expect(perf).toContain("harness 退出: code=3");
    });

    it("剧本不存在 → 1，根本不启动 mock", async () => {
        const config = makeConfig({ scriptPath: "/nonexistent/scenario.json" });
        const lines: string[] = [];
        const code = await runPerf(config, { log: (line) => lines.push(line) });
        expect(code).toBe(EXIT_SETUP);
        expect(lines.some((line) => line.includes("mock 剧本不存在"))).toBe(true);
        expect(listArtifacts(config.outDir).some((name) => name.endsWith("-mock.log"))).toBe(false);
        expect(readFileSync(artifact(config.outDir, "-perf.log"), "utf8")).toContain(
            "错误 mock 剧本不存在",
        );
    });

    it("剧本非法 JSON（mock 起不来）→ 1，日志带 mock 的报错", async () => {
        const badScript = join(tempDir(), "bad.json");
        await Bun.write(badScript, "{ 这不是 JSON }");
        const config = makeConfig({ scriptPath: badScript });
        const lines: string[] = [];
        const code = await runPerf(config, { log: (line) => lines.push(line) });
        expect(code).toBe(EXIT_SETUP);
        const message = lines.join("\n");
        expect(message).toContain("mock 启动失败");
        expect(message).toContain("不是合法 JSON");
    });

    it("端口被占用 → 1，并提示换端口", async () => {
        const port = nextPort++;
        const blocker = Bun.serve({ port, fetch: () => new Response("占用中", { status: 503 }) });
        try {
            const config = makeConfig({ port, readyTimeoutMs: 8_000 });
            const lines: string[] = [];
            const code = await runPerf(config, { log: (line) => lines.push(line) });
            expect(code).toBe(EXIT_SETUP);
            const message = lines.join("\n");
            expect(message).toContain("mock 启动失败");
            expect(message).toContain("已被占用");
        } finally {
            blocker.stop(true);
        }
    });

    it("端口上蹲着上一轮残留的 mock（状态字段齐备）→ 1，不拿别人的数据出报告", async () => {
        // 真实踩过：上一轮被中断的压测把旧 mock 留在端口上，它 /__mock/status 的字段齐备，
        // 探活与字段校验都通过，我们自己的 mock 则因 EADDRINUSE 退出——整轮压测静默打到旧实例上
        // （mock 请求数 0，harness 收到的是别人剧本的回复）。身份核对必须挡住这一路。
        const port = nextPort++;
        const stale = Bun.serve({
            port,
            fetch: (request) =>
                new URL(request.url).pathname === "/__mock/status"
                    ? Response.json({
                          source: "/tmp/stale-script.json",
                          policy: "hold",
                          size: 1,
                          index: 0,
                      })
                    : new Response("你好，我是脚本驱动的假模型。"),
        });
        try {
            const config = makeConfig({ port, readyTimeoutMs: 8_000 });
            const lines: string[] = [];
            const code = await runPerf(config, { log: (line) => lines.push(line) });
            expect(code).toBe(EXIT_SETUP);
            const message = lines.join("\n");
            expect(message).toContain("mock");
            expect(message).toMatch(/已被占用|不是本次启动的 mock/);
            // 退出发生在起 harness 之前：不该留下 harness.log（否则等于用别人的数据压了一轮）。
            expect(listArtifacts(config.outDir).some((name) => name.endsWith("-harness.log"))).toBe(
                false,
            );
        } finally {
            stale.stop(true);
        }
    });
});

describe("loadPerfConfig → runPerf 联通", () => {
    it("命令行解析出的配置可直接跑通", async () => {
        const outDir = tempDir();
        const config = loadPerfConfig(
            [
                "--out-dir",
                outDir,
                "--port",
                String(nextPort++),
                "--interval-ms",
                "50",
                "--timeout-ms",
                "20000",
                "--script",
                SCENARIO,
            ],
            REPO_ROOT,
        );
        expect(config.outDir).toBe(outDir);
        const code = await runPerf(config, {
            harnessCommand: () => fakeHarness(500, join(outDir, "harness-pids.json")),
            log: () => {},
        });
        expect(code).toBe(0);
        expect(readFileSync(artifact(outDir, "-perf.log"), "utf8")).toContain("=== 摘要 ===");
    });
});
