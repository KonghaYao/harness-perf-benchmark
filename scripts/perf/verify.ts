#!/usr/bin/env bun
/**
 * 采样方案验证实验（选型依据的可复现版本）。
 *
 *   bun run scripts/perf/verify.ts
 *
 * 做四件事：
 *   1. 对已知满转负载（`yes > /dev/null`，单核 100%）采样，检验读数是否接近 100%；
 *   2. 对空闲进程（`sleep`）采样，检验读数是否接近 0；
 *   3. 对比两个候选方案的单次开销与读数分辨率（rusage vs ps -o time=）；
 *   4. 报告采样动作自身的开销。
 * 任一项超出容差则以退出码 1 结束，便于当冒烟检查用。
 */

import {
    ProcessSampler,
    createPsBackend,
    createRusageBackend,
    parsePsTimeToMs,
    type SamplerBackend,
} from "./sampler";

const TICKS = 20;
const INTERVAL_MS = 100;
/** 满转进程的容差：用户要求误差 ≤10%。 */
const BUSY_TOLERANCE = 10;
const IDLE_LIMIT = 2;

function spawnLoad(command: string[]): { pid: number; stop: () => void } {
    const proc = Bun.spawn(command, {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });
    return {
        pid: proc.pid,
        stop: () => {
            try {
                process.kill(-proc.pid, "SIGKILL");
            } catch {
                // 已退出。
            }
        },
    };
}

/** 按 100ms 间隔采样，返回每拍的 CPU%（单核 100%）。 */
async function samplePercents(pid: number, backend: SamplerBackend, ticks = TICKS): Promise<number[]> {
    const sampler = new ProcessSampler({ pid, backend });
    if (!sampler.prime()) throw new Error(`进程 ${pid} 不存在，无法采样`);
    const values: number[] = [];
    let last = performance.now();
    for (let i = 0; i < ticks; i++) {
        await Bun.sleep(INTERVAL_MS);
        const now = performance.now();
        const sample = sampler.sample({ elapsedMs: now - last, deltaMs: now - last });
        last = now;
        if (sample === null) break;
        values.push(sample.cpuPercent);
    }
    return values;
}

function stats(values: number[]): { mean: number; min: number; max: number } {
    if (values.length === 0) return { mean: Number.NaN, min: Number.NaN, max: Number.NaN };
    return {
        mean: values.reduce((total, value) => total + value, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
    };
}

function row(label: string, values: number[], verdict: string): string {
    const { mean, min, max } = stats(values);
    return (
        `  ${label.padEnd(26)}` +
        `均值 ${mean.toFixed(1).padStart(6)}%   ` +
        `最小 ${min.toFixed(1).padStart(6)}%   最大 ${max.toFixed(1).padStart(6)}%   ${verdict}`
    );
}

const failures: string[] = [];
const busy = spawnLoad(["yes"]);
const idle = spawnLoad(["sleep", "120"]);
await Bun.sleep(400); // 让负载进入稳态

try {
    const rusage = createRusageBackend();
    const ps = createPsBackend();

    console.log("=== 1/2. 已知负载读数 ===");
    if (rusage === null) {
        failures.push("proc_pid_rusage 不可用（FFI 加载失败）");
        console.log("  proc_pid_rusage 不可用，跳过 rusage 部分");
    } else {
        console.log(`  后端: ${rusage.describe()}`);
        const busyValues = await samplePercents(busy.pid, rusage);
        const idleValues = await samplePercents(idle.pid, rusage);
        console.log(row("满转进程 rusage", busyValues, ""));
        console.log(row("空闲进程 rusage", idleValues, ""));
        const busyStats = stats(busyValues);
        const idleStats = stats(idleValues);
        if (Math.abs(busyStats.mean - 100) > BUSY_TOLERANCE) {
            failures.push(`满转读数均值 ${busyStats.mean.toFixed(1)}% 超出 100%±${BUSY_TOLERANCE}%`);
        }
        if (idleStats.max > IDLE_LIMIT) {
            failures.push(`空闲读数峰值 ${idleStats.max.toFixed(1)}% 超过 ${IDLE_LIMIT}%`);
        }
        // 若把 rusage 的返回值直接当纳秒（不做 timebase 换算）会低估多少
        const naive = busyStats.mean / 41.67;
        console.log(
            `  对照：若把 rusage 返回的 tick 直接当纳秒用，满转会被读成约 ` +
                `${naive.toFixed(1)}%（本机 timebase 1 tick ≈ 41.67ns）`,
        );
    }

    console.log("");
    console.log("=== 3. 候选方案开销与分辨率 ===");
    const psBusy = await samplePercents(busy.pid, ps);
    console.log(row("满转进程 ps 差分", psBusy, ""));

    // ps -o time= 的读数分辨率：连续读数的最小非零增量
    const reads: number[] = [];
    for (let i = 0; i < 12; i++) {
        const result = Bun.spawnSync(["ps", "-p", String(busy.pid), "-o", "time="]);
        const value = parsePsTimeToMs(result.stdout.toString());
        if (value !== null) reads.push(value);
        await Bun.sleep(60);
    }
    const deltas = reads.slice(1).map((value, index) => value - (reads[index] as number));
    const nonZero = deltas.filter((delta) => delta > 0);
    const resolution = nonZero.length > 0 ? `${Math.min(...nonZero).toFixed(0)} ms` : "未测到增量";

    const timeCost = (() => {
        const start = performance.now();
        for (let i = 0; i < 20; i++) Bun.spawnSync(["ps", "-p", String(busy.pid), "-o", "time=,rss="]);
        return (performance.now() - start) / 20;
    })();
    const tableCost = (() => {
        const start = performance.now();
        for (let i = 0; i < 10; i++) Bun.spawnSync(["ps", "-axo", "pid=,ppid="]);
        return (performance.now() - start) / 10;
    })();
    console.log(`  ps -p <pid> -o time=,rss=  单次 ${timeCost.toFixed(2)} ms，读数分辨率 ≈ ${resolution}`);
    console.log(`  ps -axo pid=,ppid=（进程树）单次 ${tableCost.toFixed(2)} ms`);
    if (rusage !== null) {
        const start = performance.now();
        for (let i = 0; i < 2000; i++) rusage.read(busy.pid);
        console.log(
            `  proc_pid_rusage            单次 ${(((performance.now() - start) / 2000) * 1000).toFixed(2)} µs`,
        );
    }

    console.log("");
    console.log("=== 4. 采样动作自身开销（含差分与进程树遍历）===");
    if (rusage !== null) {
        const sampler = new ProcessSampler({ pid: busy.pid, backend: rusage });
        sampler.prime();
        const rounds = 2000;
        const start = performance.now();
        for (let i = 0; i < rounds; i++) sampler.sample({ elapsedMs: i * 100, deltaMs: 100 });
        const perSample = ((performance.now() - start) / rounds) * 1000;
        const dutyCycle = ((perSample / 1000 / INTERVAL_MS) * 100).toFixed(4);
        console.log(
            `  每拍采样（rusage）        ${perSample.toFixed(1)} µs` +
                `（${INTERVAL_MS}ms 间隔下占用 ${dutyCycle}%）`,
        );
        const treeSampler = new ProcessSampler({ pid: busy.pid, backend: rusage, withTree: true });
        treeSampler.prime();
        const startTree = performance.now();
        for (let i = 0; i < 10; i++) treeSampler.refreshTree();
        console.log(
            `  进程树刷新（每 2s 一次）  ${((performance.now() - startTree) / 10).toFixed(1)} ms/次`,
        );
    }

    console.log("");
    if (failures.length === 0) {
        console.log("结论: 全部检查通过（容差：满转 100%±10%，空闲 ≤2%）");
    } else {
        console.log(`结论: ${failures.length} 项超差`);
        for (const failure of failures) console.log(`  - ${failure}`);
    }
} finally {
    busy.stop();
    idle.stop();
}

process.exit(failures.length === 0 ? 0 : 1);
