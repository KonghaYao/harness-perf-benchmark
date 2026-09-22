/**
 * 压测编排的端到端测试：mock 用真 server，harness 用假进程（不依赖 peri）。
 *
 * 覆盖：正常跑完、采样对象提前退出（采样前 / 采样中）、超时强杀、mock 启动失败、端口占用。
 * 断言聚焦「退出码 / 产物 / 不留孤儿」；CPU 读数的精确性由 scripts/perf/verify.ts 验证。
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { calibrationHost, type Calibration } from "./calibrate";
import { fakeCalibration } from "./calibrate.test";
import { REPO_ROOT, loadPerfConfig, type PerfConfig } from "./config";
import { EXIT_HARNESS, EXIT_SETUP, EXIT_TIMEOUT, runPerf } from "./run";
import { CSV_HEADER } from "./sampler";

const tempDirs: string[] = [];
/** 每个用例换端口，避免相互抢占（mock 会真的监听）。 */
let nextPort = 41_000 + Math.floor(Math.random() * 5_000);

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "llm-mock-perf-test-"));
    tempDirs.push(dir);
    return dir;
}

/**
 * 测试用剧本：写在测试自己的临时目录里，**不依赖仓库里的剧本文件**——压测剧本一律由生成器
 * （scripts/perf/gen-long-run.ts）按需现造，仓库里没有随手可用的默认剧本。
 */
function minimalScenario(dir: string): string {
    const path = join(dir, "scenario.json");
    writeFileSync(path, `${JSON.stringify({ responses: ["测试响应"] }, null, 4)}\n`);
    return path;
}

const SCENARIO = minimalScenario(tempDir());

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
        // 固定 harness 身份，产物路径就能预测（`<outDir>/test-harness/<runId>/`）；
        // 「不给时从命令推断」由单独的用例覆盖。
        harnessId: "test-harness",
        label: null,
        // 不校准：CU 里的核·秒就是本机秒（校准路径由 config.test.ts 与 calibrate.test.ts 覆盖）。
        cpuCalibrationPath: null,
        port: nextPort++,
        exhausted: "loop",
        sampler: "rusage",
        withTree: true,
        periArgs: [],
        ...overrides,
    };
}

/** 一次运行的目录（`<outDir>/<harnessId>/<runId>/`）；runId 带时间戳，只能扫出来。 */
function runDirOf(outDir: string, harnessId = "test-harness"): string {
    const harnessDir = join(outDir, harnessId);
    const runIds = readdirSync(harnessDir).sort();
    if (runIds.length !== 1) throw new Error(`期望 ${harnessDir} 下恰好一次运行，实际 ${runIds.length}`);
    return join(harnessDir, runIds[0]!);
}

/** 一次运行目录里的产物文件（run.json + 四份原始产物）。 */
function artifact(outDir: string, fileName: string, harnessId = "test-harness"): string {
    const path = join(runDirOf(outDir, harnessId), fileName);
    if (!existsSync(path)) throw new Error(`运行目录里没有 ${fileName}`);
    return path;
}

function readRunMeta(outDir: string, harnessId = "test-harness"): Record<string, unknown> {
    return JSON.parse(readFileSync(artifact(outDir, "run.json", harnessId), "utf8")) as Record<
        string,
        unknown
    >;
}

function listArtifacts(outDir: string): string[] {
    return readdirSync(runDirOf(outDir)).sort();
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
    it("Codex demo 仅向 harness 注入快速失败代理，并覆盖继承的绕过规则", async () => {
        const dir = tempDir();
        const harness = join(dir, "fake-codex");
        writeFileSync(harness, `#!${process.execPath}
            const env = process.env;
            const ok = env.HTTPS_PROXY === "http://127.0.0.1:9"
                && env.https_proxy === env.HTTPS_PROXY
                && env.NO_PROXY === "127.0.0.1,localhost,::1"
                && env.no_proxy === env.NO_PROXY;
            console.log(ok ? "代理隔离正确" : "代理隔离失败");
            process.exit(ok ? 0 : 1);
        `, { mode: 0o755 });
        const child = Bun.spawn([
            process.execPath, join(REPO_ROOT, "playground/codex/perf-demo.ts"),
            "--peri", harness, "--script", SCENARIO,
            "--out-dir", dir, "--port", String(nextPort++), "--timeout-ms", "10000",
        ], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                HTTPS_PROXY: "http://127.0.0.1:1",
                https_proxy: "http://127.0.0.1:2",
                NO_PROXY: "*",
                no_proxy: "*",
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        // 并行消费管道，防止日志写满后阻塞子进程。
        const [code] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(readFileSync(artifact(dir, "harness.log", "codex"), "utf8"))
            .toContain("代理隔离正确");
        expect(readFileSync(artifact(dir, "mock.log", "codex"), "utf8"))
            .toContain("监听 http://localhost:");
    }, 20_000);

    it("PATH 里没有 peri 且没显式指定 → 不猜本地构建产物，直接报错", async () => {
        // 不传 harnessCommand：走默认的 peri 命令。periPath=null 代表 Bun.which("peri") 落空，
        // 这时必须停在报错上——旧行为会悄悄回退 ../perihelion 的 debug 构建（读数不可比）。
        const config = makeConfig({ periPath: null, harnessId: null });
        await expect(runPerf(config)).rejects.toThrow(/PATH 里找不到 peri/);
        expect(existsSync(join(config.outDir, "test-harness"))).toBe(false);
    });

    it("真 mock + 假 harness：跑完留下四份产物、CSV 与摘要自洽", async () => {
        const config = makeConfig({ timeoutMs: 20_000 });
        const pidFile = join(config.outDir, "harness-pids.json");
        const lines: string[] = [];
        const code = await runPerf(config, {
            harnessCommand: () => fakeHarness(1_200, pidFile),
            log: (line) => lines.push(line),
        });

        expect(code).toBe(0);
        // 一次运行 = 一个目录：run.json + 四份原始产物
        expect(listArtifacts(config.outDir)).toEqual([
            "harness.log",
            "mock.log",
            "perf.log",
            "run.json",
            "samples.csv",
        ]);

        const csv = readFileSync(artifact(config.outDir, "samples.csv"), "utf8")
            .trim()
            .split("\n");
        // 表头**逐字**钉死：老读取端按表头名取列，但图表那条线是按列序取值的，
        // 所以新增列只能往后追加，绝不能插队（child_cpu_pct 就是 2026-09-19 追加的）。
        expect(csv[0]).toBe(CSV_HEADER);
        expect(csv[0]).toBe("ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs,child_cpu_pct");
        const rows = csv.slice(1);
        // 忙转 1.2s、间隔 100ms：样本数 8~14
        expect(rows.length).toBeGreaterThanOrEqual(6);
        const cpu = rows.map((row) => Number(row.split(",")[2]));
        const rss = rows.map((row) => Number(row.split(",")[3]));
        expect(Math.max(...cpu)).toBeGreaterThan(5); // 忙转进程必须采到非零 CPU
        expect(cpu.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
        expect(rss.every((value) => value > 0)).toBe(true);

        const perf = readFileSync(artifact(config.outDir, "perf.log"), "utf8");
        expect(perf).toContain("mock 就绪");
        expect(perf).toContain("采样开始");
        expect(perf).toContain("harness 退出: code=0");
        expect(perf).toContain("=== 摘要 ===");
        expect(perf).toMatch(/样本数: \d+/);

        // mock 真被用起来了：日志里有监听与请求记录
        const mockLog = readFileSync(artifact(config.outDir, "mock.log"), "utf8");
        expect(mockLog).toContain("监听 http://localhost:");
        // 产物目录要打到 stdout，方便直接打开查看
        expect(lines.some((line) => line.includes("test-harness"))).toBe(true);

        // run.json：身份、时长、分段、摘要、退出码、产物清单都要齐（读取端只认它）
        const meta = readRunMeta(config.outDir);
        expect(meta).toMatchObject({
            schemaVersion: 1,
            status: "ok",
            error: null,
            legacy: null,
            sampling: { intervalMs: 100, backend: "rusage", withTree: true, format: "csv" },
            exit: { code: 0, signal: null },
            summarySource: "runtime",
        });
        expect((meta.harness as Record<string, unknown>).id).toBe("test-harness");
        expect((meta.harness as Record<string, unknown>).idSource).toBe("explicit");
        expect((meta.mock as Record<string, unknown>).requestsSource).toBe("status");
        expect((meta.duration as Record<string, number>).endToEndMs).toBeGreaterThan(1_000);
        expect((meta.summary as Record<string, number>).count).toBeGreaterThanOrEqual(6);
        // 统一计分随 run.json 落盘（FC 的 CU 口径），且各项自洽
        const cost = meta.cost as Record<string, number>;
        expect(cost.sampleCount).toBeGreaterThanOrEqual(6);
        expect(cost.cu).toBeCloseTo(cost.cpuCu + cost.memoryCu, 9);
        expect(cost.cu).toBeGreaterThan(0);
        expect(cost.tailAppliedMs).toBeGreaterThanOrEqual(0);
        expect(cost.tailAppliedMs).toBeLessThanOrEqual(500);
        // 假 harness 不打印任何东西，所以 harness.log 是 0 字节——但文件必须在（peri 被强杀时也是这个形状）
        const artifacts = meta.artifacts as Record<string, { file: string; bytes: number } | null>;
        expect(artifacts.harness?.file).toBe("harness.log");
        expect(artifacts.mock!.bytes).toBeGreaterThan(0);
        // 采样起点要落在 harness 启动之后、退出之前，读取端靠它把分界线挪到曲线的时间轴上
        const timing = meta.timing as Record<string, number>;
        expect(timing.harnessStartedAtMs).toBeLessThanOrEqual(timing.samplingStartedAtMs);
    });

    it("harness 身份：不给 --harness 时从启动命令的第一个 token 推断（带别名）", async () => {
        // 用符号链接冒充「命令名与目录名不同」的那类 harness：`claude` → claude-code。
        const binDir = tempDir();
        const link = join(binDir, "claude");
        symlinkSync(process.execPath, link);
        const config = makeConfig({ timeoutMs: 20_000, harnessId: null, periPath: link });
        const code = await runPerf(config, {
            harnessCommand: () => [link, "-e", "await Bun.sleep(400); process.exit(0);"],
            log: () => {},
        });

        expect(code).toBe(0);
        const meta = readRunMeta(config.outDir, "claude-code");
        expect((meta.harness as Record<string, unknown>).id).toBe("claude-code");
        expect((meta.harness as Record<string, unknown>).idSource).toBe("command");
        expect(runDirOf(config.outDir, "claude-code")).toContain("/claude-code/");
    });

    it("同一秒的第二次运行不会写进同一组文件（runId 加 -2 后缀）", async () => {
        const config = makeConfig({ timeoutMs: 20_000 });
        const first = await runPerf(config, {
            harnessCommand: () => fakeHarness(300, join(config.outDir, "pids-1.json")),
            log: () => {},
        });
        const second = await runPerf(config, {
            harnessCommand: () => fakeHarness(300, join(config.outDir, "pids-2.json")),
            log: () => {},
        });

        expect([first, second]).toEqual([0, 0]);
        const runIds = readdirSync(join(config.outDir, "test-harness")).sort();
        expect(runIds.length).toBe(2);
        // 撞在同一秒里才会加后缀；跨秒就是两个正常的 runId（这条断言在两种情况下都成立）
        if (runIds[0]!.slice(0, 15) === runIds[1]!.slice(0, 15)) expect(runIds[1]).toMatch(/-2$/);
        // 两份产物各自独立：不是同一组文件被追加了两遍
        for (const runId of runIds) {
            const meta = JSON.parse(
                readFileSync(join(config.outDir, "test-harness", runId, "run.json"), "utf8"),
            ) as Record<string, unknown>;
            expect(meta.status).toBe("ok");
            expect((meta.runId as string).length).toBeGreaterThan(0);
        }
    });

    it("时长分段：借 mock 侧的首/末次请求时刻，把端到端时长拆成启动 / 运转 / 收尾", async () => {
        // 假 harness：先睡 300ms（冒充启动开销），打两次 mock，再睡 1.1s（冒充收尾等待）。
        const config = makeConfig({ timeoutMs: 20_000 });
        const script = `
            const base = "http://127.0.0.1:${config.port}";
            await Bun.sleep(300);
            for (let i = 0; i < 2; i += 1) {
                await fetch(base + "/v1/chat/completions", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                });
            }
            await Bun.sleep(1100);
            process.exit(0);
        `;
        const code = await runPerf(config, {
            harnessCommand: () => [process.execPath, "-e", script],
        });

        expect(code).toBe(0);
        const perf = readFileSync(artifact(config.outDir, "perf.log"), "utf8");
        const line = perf.split("\n").find((entry) => entry.includes("时长分段:"))!;
        expect(line).toMatch(
            /时长分段: 启动 → 首个请求 [\d.]+s ｜ 首个请求 → 末次请求 [\d.]+s ｜ 末次请求 → 退出 [\d.]+s/,
        );
        // 三段各自的数量级要能对上假 harness 的设计（启动 0.3s、收尾 1.1s）
        const [, startup, span, tail] = line.match(/([\d.]+)s .*?([\d.]+)s .*?([\d.]+)s/)!;
        expect(Number(startup)).toBeGreaterThanOrEqual(0.2);
        expect(Number(span)).toBeLessThan(1);
        expect(Number(tail)).toBeGreaterThanOrEqual(1);
        // 收尾零请求时给一句说明，免得读的人以为是 harness 在干活
        expect(line).toContain("收尾零请求");
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
        const perf = readFileSync(artifact(config.outDir, "perf.log"), "utf8");
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

        const perf = readFileSync(artifact(config.outDir, "perf.log"), "utf8");
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
        expect(readFileSync(artifact(config.outDir, "perf.log"), "utf8")).toContain("=== 摘要 ===");
    });

    it("采样对象在首次采样前就退出 → 2，摘要说明样本为 0", async () => {
        const config = makeConfig({ intervalMs: 1_000 });
        const lines: string[] = [];
        const code = await runPerf(config, {
            harnessCommand: () => [process.execPath, "-e", "process.exit(3);"],
            log: (line) => lines.push(line),
        });
        expect(code).toBe(EXIT_HARNESS);
        const perf = readFileSync(artifact(config.outDir, "perf.log"), "utf8");
        expect(perf).toContain("样本数: 0");
        expect(perf).toContain("harness 退出: code=3");
    });

    it("剧本不存在 → 1，根本不启动 mock；run.json 留下 setup-error 的判定", async () => {
        const config = makeConfig({ scriptPath: "/nonexistent/scenario.json" });
        const lines: string[] = [];
        const code = await runPerf(config, { log: (line) => lines.push(line) });
        expect(code).toBe(EXIT_SETUP);
        expect(lines.some((line) => line.includes("mock 剧本不存在"))).toBe(true);
        expect(existsSync(join(runDirOf(config.outDir), "mock.log"))).toBe(false);
        expect(readFileSync(artifact(config.outDir, "perf.log"), "utf8")).toContain(
            "错误 mock 剧本不存在",
        );
        // 早退也要留下可判定的 run.json：读取端据此跳过，而不是把半截运行当成跑完
        const meta = readRunMeta(config.outDir);
        expect(meta.status).toBe("setup-error");
        expect(String(meta.error)).toContain("mock 剧本不存在");
        expect(meta.endedAt).toBeTruthy();
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
            expect(existsSync(join(runDirOf(config.outDir), "harness.log"))).toBe(false);
            expect(readRunMeta(config.outDir).status).toBe("setup-error");
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
                "--harness",
                "test-harness",
            ],
            REPO_ROOT,
        );
        expect(config.outDir).toBe(outDir);
        expect(config.harnessId).toBe("test-harness");
        const code = await runPerf(config, {
            harnessCommand: () => fakeHarness(500, join(outDir, "harness-pids.json")),
            log: () => {},
        });
        expect(code).toBe(0);
        expect(readFileSync(artifact(outDir, "perf.log"), "utf8")).toContain("=== 摘要 ===");
    });
});

describe("CPU 校准（写侧）：加载、核对、写进 run.json", () => {
    /** 一份「宿主就是本机」的校准 JSON 文件（校准值本身是假的，用来验证链路）。 */
    function writeCalibration(dir: string, overrides: Partial<Calibration> = {}, cpuScale = 7): string {
        const path = join(dir, "calibration.json");
        const calibration = fakeCalibration({
            host: calibrationHost(),
            scale: {
                baselineMips: 1000,
                cpuScale,
                cpuScaleValue: cpuScale * 1000,
                baseline: "1000 benchmark MIPS per CPU-second",
                unit: "本机核·秒 × cpuScale = 标准机核·秒",
                oneCoreSecond: { rawRu: [cpuScale * 1000], rawRatings: [cpuScale * 1000] },
            },
            ...overrides,
        });
        writeFileSync(path, JSON.stringify(calibration, null, 2));
        return path;
    }

    it("校准与当前机器相符：run.json 记下折算摘要，CU 的 CPU 项按 scale 折算", async () => {
        const dir = tempDir();
        const calibrationPath = writeCalibration(dir, {}, 7);
        const config = makeConfig({ cpuCalibrationPath: calibrationPath, timeoutMs: 20_000 });
        const lines: string[] = [];
        const code = await runPerf(config, {
            harnessCommand: () => fakeHarness(1_000, join(config.outDir, "harness-pids.txt")),
            log: (line) => lines.push(line),
        });
        expect(code).toBe(0);
        const meta = readRunMeta(config.outDir) as {
            cpuCalibration: { cpuScale: number; baselineMips: number; toolVersion: string } | null;
            cost: { cpuScale?: number; cpuSeconds: number; standardCpuSeconds?: number; rawCu?: number; cu: number; memoryCu: number };
        };
        expect(meta.cpuCalibration?.cpuScale).toBe(7);
        expect(meta.cpuCalibration?.baselineMips).toBe(1000);
        expect(meta.cpuCalibration?.toolVersion).toBe("26.01");
        // CPU 项 ×7、内存项不变；rawCu 是未折算的那一份
        const cost = meta.cost;
        expect(cost.cpuScale).toBe(7);
        expect(cost.standardCpuSeconds).toBeCloseTo(cost.cpuSeconds * 7, 9);
        expect(cost.rawCu).toBeCloseTo(cost.cu - cost.cpuSeconds * 7 + cost.cpuSeconds, 6);
        // run.json 里存的是摘要，不是整份校准 JSON
        expect(JSON.stringify(meta.cpuCalibration)).not.toContain("configSignature\":\"a");
        // 日志文案：cpuScale 显示缩到 4 位小数（7 就写 7，不写 7.0000），且不声称参考机器
        const summary = lines.join("\n");
        expect(summary).toContain("cpuScale 7 = 7000 / 1000");
        expect(summary).toContain("项目标准 CPU 单位");
        expect(summary).not.toContain("标准机");
        expect(summary).not.toContain("名次与未折算一致");
    }, 30_000);

    it("校准的宿主与当前机器不符：起进程前就拒绝，不留半截产物", async () => {
        const dir = tempDir();
        const path = join(dir, "calibration.json");
        const calibration = fakeCalibration({
            host: { ...calibrationHost(), hostname: "another-mac", cpuModel: "Apple M1" },
        });
        writeFileSync(path, JSON.stringify(calibration, null, 2));
        const config = makeConfig({ cpuCalibrationPath: path });
        // 与「PATH 里没有 peri」同类：起跑前的配置错误直接抛（而不是跑一轮再写 setup-error）
        await expect(
            runPerf(config, {
                harnessCommand: () => fakeHarness(200, join(config.outDir, "pids.txt")),
                log: () => {},
            }),
        ).rejects.toThrow(/与当前机器不符/);
        // 校准核对在起进程之前：连产物目录都还没建
        expect(existsSync(join(config.outDir, "test-harness"))).toBe(false);
    });

    it("校准文件不存在 / 口径不对：直接报错，不当成「没校准」", async () => {
        const missing = makeConfig({ cpuCalibrationPath: join(tempDir(), "nope.json") });
        await expect(
            runPerf(missing, { harnessCommand: () => fakeHarness(100, "x"), log: () => {} }),
        ).rejects.toThrow(/找不到校准文件/);

        const dir = tempDir();
        const wrongVersion = join(dir, "cal.json");
        writeFileSync(wrongVersion, JSON.stringify({ ...fakeCalibration(), tool: { ...fakeCalibration().tool, version: "25.01" } }));
        await expect(
            runPerf(makeConfig({ cpuCalibrationPath: wrongVersion }), {
                harnessCommand: () => fakeHarness(100, "x"),
                log: () => {},
            }),
        ).rejects.toThrow(/26\.01/);
    });

    it("没给 --cpu-calibration：run.json 里是 null，CU 不折算（旧行为不变）", async () => {
        const config = makeConfig({ timeoutMs: 20_000 });
        const code = await runPerf(config, {
            harnessCommand: () => fakeHarness(600, join(config.outDir, "pids.txt")),
            log: () => {},
        });
        expect(code).toBe(0);
        const meta = readRunMeta(config.outDir) as {
            cpuCalibration: unknown;
            cost: { cpuScale?: number; rawCu?: number; cu: number };
        };
        expect(meta.cpuCalibration).toBeNull();
        expect(meta.cost.cpuScale).toBe(1);
        expect(meta.cost.rawCu).toBeCloseTo(meta.cost.cu, 9);
    }, 30_000);
});
