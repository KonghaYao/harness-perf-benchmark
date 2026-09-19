/**
 * `run.json` 的 schema 与写入：一次运行的**机器接口**。
 *
 * 为什么要有它：老的平铺布局把「是谁跑的、跑了什么、跑完没有、各段多久」全塞在人读的
 * 中文日志里，读取端只能拿正则去扒——日志措辞一改就静默出错（实测踩过：筛选正则漏掉
 * 新增的剧本变体、harness 别名没解析对，图例就落成裸命令名）。现在这些事实由写入端**结构化**
 * 落盘，读取端（图表生成器、迁移脚本、报告）只认字段。
 *
 * 两次写：
 *   - 开跑：`status:"running"`，只放「起手就知道」的事实（身份、剧本、参数、宿主）；
 *   - 结束：原子替换（写 .tmp 再 rename）补全结尾才知道的事实（时间线、分段、摘要、退出码）。
 *     `finally` 里兜底再补一次，保证早退路径（剧本不存在、端口被占、mock 起不来）也留下 status。
 *
 * **所有「说不出来」的字段一律写 null，不要省略键**：JSON.stringify 会丢掉 undefined 的键，
 * 读取端就分不清「字段缺失」和「值为空」了。
 */

import { renameSync, writeFileSync } from "node:fs";
import { cpus, hostname, loadavg, platform, release, totalmem } from "node:os";
import type { ResourceCost } from "./score";

/** schema 版本：字段有破坏性变化时 +1（读取端据此判断能不能读）。 */
export const RUN_META_SCHEMA_VERSION = 1;

/** 一次运行的结果判定。`running` 是开跑时的初值，其余在结束时定型。 */
export type RunStatus =
    | "running"
    | "ok"
    | "harness-exit"
    | "timeout"
    | "interrupted"
    | "setup-error"
    | "incomplete";

export interface RunMetaHost {
    hostname: string;
    platform: string;
    osRelease: string;
    arch: string;
    cpuModel: string;
    cpus: number;
    totalMemBytes: number;
    bunVersion: string;
    /** `os.loadavg()` 是 1/5/15 分钟均值（macOS 上不是瞬时值），跨机器比读数时要说清口径。 */
    loadAvgStart: [number, number, number];
    loadAvgEnd: [number, number, number] | null;
}

export interface RunMeta {
    schemaVersion: number;
    runId: string;
    status: RunStatus;
    /** 失败原因（与 perf.log 里 `错误 …` 同源）；正常路径为 null。 */
    error: string | null;
    /** 由迁移脚本写入：老布局的出处（新产物为 null）。 */
    legacy: { layout: "flat"; source: string; migratedAt: string } | null;
    harness: {
        id: string;
        /** id 的来源：命令行显式指定还是从命令推断（迁移来的老产物一律 "command"）。 */
        idSource: "explicit" | "command";
        command: string[] | null;
        commandLine: string | null;
        cwd: string | null;
        /** harness 二进制的 stat（记录测的是哪份二进制：路径 + size/mtime，能区分 debug 与 release 构建）。 */
        binary: { path: string; sizeBytes: number; mtimeMs: number } | null;
        /** 版本号：不做 `--version` 探测（会多一次 spawn、且各家 flag 不同），默认 null。 */
        version: string | null;
        /** 注入给 harness 的环境变量；凭据类只留键名（值为 "***"）。 */
        env: Record<string, string> | null;
    };
    scenario: {
        path: string;
        relPath: string | null;
        name: string;
        sizeBytes: number | null;
        /** 前 16 位十六进制：跨机器复测时确认「确实是同一份剧本」。 */
        sha256: string | null;
    };
    mock: {
        port: number;
        exhausted: string;
        readyMs: number | null;
        requests: number | null;
        /** 请求数来自 /__mock/status 还是数 mock 日志（兜底路径）。 */
        requestsSource: "status" | "mock-log" | null;
        cursor: { index: number; size: number; exhausted: boolean } | null;
    };
    sampling: {
        intervalMs: number;
        backend: "rusage" | "ps";
        withTree: boolean | null;
        /** 采样文件格式；将来换格式时的开关。 */
        format: "csv";
    };
    limits: { timeoutMs: number; readyTimeoutMs: number; maxTurns: number } | null;
    prompt: string | null;
    label: string | null;
    host: RunMetaHost | null;
    startedAtMs: number;
    startedAt: string;
    endedAtMs: number | null;
    endedAt: string | null;
    duration: { endToEndMs: number | null; samplingWindowMs: number | null };
    /** 墙上时刻（epoch 毫秒）：读取端据此把「首个/末次请求」画到采样时间轴上。 */
    timing: {
        harnessStartedAtMs: number | null;
        samplingStartedAtMs: number | null;
        firstRequestAtMs: number | null;
        lastRequestAtMs: number | null;
        harnessExitedAtMs: number | null;
    };
    segments: { startupMs: number; spanMs: number; tailMs: number; idleTail: boolean } | null;
    summary: {
        count: number;
        durationMs: number;
        cpuMean: number;
        cpuMax: number;
        rssMeanBytes: number;
        rssMaxBytes: number;
        rssLastBytes: number;
        treeCpuMean: number;
        treeCpuMax: number;
        treeRssMeanBytes: number;
        treeRssMaxBytes: number;
    } | null;
    /** 摘要来自内存里的样本（本进程跑的）还是从 samples.csv 重算（迁移的老产物）。 */
    summarySource: "runtime" | "samples" | null;
    /**
     * 统一计分（阿里云 FC 的 CU 口径，见 score.ts）：把 CPU 与内存折成一个标量。
     * 2026-09-19 追加的字段；那之前的老产物没有，读取端认 null 并按 samples.csv 现算。
     */
    cost: ResourceCost | null;
    exit: { code: number | null; signal: string | null } | null;
    artifacts: Record<"perf" | "samples" | "harness" | "mock", { file: string; bytes: number } | null> | null;
}

/** 原子写 JSON：先写 .tmp 再 rename，读取端不会读到半截文件。 */
export function writeJsonAtomic(path: string, value: unknown): void {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
    renameSync(temp, path);
}

/** 宿主信息快照（跑完再取一次 loadAvg 补进 loadAvgEnd）。 */
export function hostSnapshot(): RunMetaHost {
    const [one, five, fifteen] = loadavg();
    return {
        hostname: hostname(),
        platform: platform(),
        osRelease: release(),
        arch: process.arch,
        cpuModel: cpus()[0]?.model ?? "unknown",
        cpus: cpus().length,
        totalMemBytes: totalmem(),
        bunVersion: Bun.version,
        loadAvgStart: [one ?? 0, five ?? 0, fifteen ?? 0],
        loadAvgEnd: null,
    };
}
