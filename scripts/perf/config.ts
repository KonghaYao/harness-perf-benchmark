/**
 * 压测配置：命令行参数解析。风格与 src/config.ts 一致（node:util 的 parseArgs、
 * 中文报错、非法取值可定位）。相对路径按**启动时的工作目录**解析，内置默认值按仓库根解析。
 *
 *   bun run scripts/perf/run.ts --turns 30 --timeout-ms 60000
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ExhaustedPolicy } from "../../src/config";
import type { SamplerKind } from "./sampler";

/** 仓库根（scripts/perf/ 往上两级）。 */
export const REPO_ROOT = resolve(import.meta.dir, "../..");

export interface PerfConfig {
    /** 传给 peri 的 --max-turns（注意：peri 3.17 在 -p 模式下忽略它，见 README/CLAUDE）。 */
    turns: number;
    /** 采样间隔（毫秒）。 */
    intervalMs: number;
    /** 兜底终止时限（毫秒）：到点即杀 harness。 */
    timeoutMs: number;
    /** mock 端口就绪的等待上限（毫秒）。 */
    readyTimeoutMs: number;
    prompt: string;
    /** mock 剧本（绝对路径）。 */
    scriptPath: string;
    /** harness 二进制（绝对路径）。 */
    periPath: string;
    /** harness 的工作目录：`{cwd}/.peri/settings.json` 只在这里生效。 */
    workDir: string;
    /** 产物目录（绝对路径）。 */
    outDir: string;
    port: number;
    /** mock 剧本耗尽策略：loop 可持续供压；hold/error 下剧本走完即停（harness 有机会自行退出）。 */
    exhausted: ExhaustedPolicy;
    sampler: SamplerKind;
    /** 是否连带统计 harness 的后代进程。 */
    withTree: boolean;
    /** 追加到 harness 命令行的参数，原样透传。 */
    periArgs: string[];
}

const DEFAULT_PORT = 3457;

/**
 * 默认 harness 二进制：**优先用 PATH 里的 peri**（用户可能装的是发布版），
 * 找不到才退回同级的本地构建产物（`../perihelion/target/debug/peri`）。
 */
export function defaultHarnessPath(): string {
    return Bun.which("peri") ?? resolve(REPO_ROOT, "../perihelion/target/debug/peri");
}

function integer(
    value: string | undefined,
    label: string,
    fallback: number,
    min: number,
    max: number,
): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${label} 必须是 ${min}..${max} 的整数，收到: ${JSON.stringify(value)}`);
    }
    return parsed;
}

function samplerKind(value: string | undefined): SamplerKind {
    if (value === undefined || value === "") return "rusage";
    if (value === "rusage" || value === "ps") return value;
    throw new Error(`sampler 必须是 rusage | ps，收到: ${JSON.stringify(value)}`);
}

function exhaustedPolicy(value: string | undefined): ExhaustedPolicy {
    if (value === undefined || value === "") return "loop";
    if (value === "error" || value === "hold" || value === "loop") return value;
    throw new Error(`exhausted 必须是 error | hold | loop，收到: ${JSON.stringify(value)}`);
}

export function loadPerfConfig(
    argv: string[] = process.argv.slice(2),
    cwd: string = process.cwd(),
): PerfConfig {
    const { values } = parseArgs({
        args: argv,
        options: {
            turns: { type: "string" },
            "interval-ms": { type: "string" },
            "timeout-ms": { type: "string" },
            "ready-timeout-ms": { type: "string" },
            prompt: { type: "string" },
            script: { type: "string" },
            peri: { type: "string" },
            "work-dir": { type: "string" },
            "out-dir": { type: "string" },
            port: { type: "string" },
            exhausted: { type: "string" },
            sampler: { type: "string" },
            "no-tree": { type: "boolean" },
            "peri-arg": { type: "string", multiple: true },
        },
        allowPositionals: false,
        strict: true,
    });

    const prompt = values.prompt ?? "压测：请持续用只读命令检查当前目录状态";
    if (prompt.trim() === "") throw new Error("prompt 不能为空");

    return {
        turns: integer(values.turns, "turns", 25, 1, 100_000),
        intervalMs: integer(values["interval-ms"], "interval-ms", 100, 10, 60_000),
        timeoutMs: integer(values["timeout-ms"], "timeout-ms", 60_000, 1_000, 86_400_000),
        readyTimeoutMs: integer(values["ready-timeout-ms"], "ready-timeout-ms", 10_000, 100, 600_000),
        prompt,
        scriptPath: resolve(cwd, values.script ?? resolve(REPO_ROOT, "scripts/perf-scenario.json")),
        periPath: resolve(cwd, values.peri ?? defaultHarnessPath()),
        workDir: resolve(cwd, values["work-dir"] ?? resolve(REPO_ROOT, "playground/peri")),
        outDir: resolve(cwd, values["out-dir"] ?? resolve(REPO_ROOT, "data/claude-date")),
        port: integer(values.port, "port", DEFAULT_PORT, 1, 65535),
        exhausted: exhaustedPolicy(values.exhausted),
        sampler: samplerKind(values.sampler),
        withTree: values["no-tree"] !== true,
        periArgs: values["peri-arg"] ?? [],
    };
}

/** runId：`YYYYMMDD-HHMMSS`（本地时区）。 */
export function formatRunId(date: Date): string {
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
}
