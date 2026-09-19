/**
 * **老布局**（`data/claude-date/<runId>-*.{log,csv}` 平铺那套）的解析器。
 *
 * 存在的意义有两个：
 *   1. 迁移脚本（migrate-layout.ts）要从老产物里反推出 run.json；
 *   2. 读取端（gen-chart-data.ts）在迁移完成前要能同时认两种布局。
 *
 * 它靠正则扒中文日志行——这是老布局的**原罪**（日志措辞一改就静默出错），
 * 所以新布局把这些事实都搬进了 `run.json`。**这份文件是过渡件**：
 * 迁移完成、且一周内没有新的老布局产物之后，整份删掉（连同读取端的兼容分支）。
 */

import { harnessIdFromCommandLine } from "./harness-id";
import type { RunStatus } from "./run-meta";

/** 从老产物里能还原出来的全部事实；还原不出的一律 null（不猜）。 */
export interface LegacyRunMeta {
    runId: string;
    harnessId: string;
    /** `启动 harness:` 里的命令全文（`quote()` 之后）。 */
    commandLine: string;
    cwd: string | null;
    scriptPath: string;
    port: number | null;
    exhausted: string | null;
    samplingBackend: "rusage" | "ps" | null;
    samplingIntervalMs: number | null;
    /** perf.log 头部 `开始:` 的 ISO 时刻。 */
    startIso: string | null;
    /** 「启动 harness」的时刻（由头部 ISO + 相对秒还原，毫秒级）。 */
    harnessStartedAtMs: number | null;
    /** 「采样开始」的时刻（同上）。 */
    samplingStartedAtMs: number | null;
    endToEndMs: number | null;
    samplingWindowMs: number | null;
    requests: number | null;
    mockCursorSize: number | null;
    segments: { startupMs: number; spanMs: number; tailMs: number } | null;
    exit: { code: number | null; signal: string | null } | null;
    status: RunStatus;
}

/** 毫秒取整的秒数字符串（`1.7` → 1700）。 */
const ms = (raw: string | undefined): number | null =>
    raw === undefined ? null : Math.round(Number(raw) * 1000);

/** 老产物里 `[+x.xxx s]` 的相对秒 → epoch 毫秒；缺头部 ISO 时返回 null。 */
function epochAt(startIso: string | null, relativeSeconds: string | undefined): number | null {
    if (startIso === null || relativeSeconds === undefined) return null;
    const base = Date.parse(startIso);
    return Number.isNaN(base) ? null : base + Math.round(Number(relativeSeconds) * 1000);
}

/** 结果判定表（顺序敏感：先看明确的失败标志，再看摘要）。 */
export function legacyStatusOf(text: string, exit: { code: number | null } | null): RunStatus {
    if (/超时 \d+ms: 终止 harness/.test(text) || /收到中断信号: 终止 harness/.test(text)) {
        return /收到中断信号/.test(text) ? "interrupted" : "timeout";
    }
    if (!/启动 harness:/.test(text)) {
        return /错误 /.test(text) ? "setup-error" : "incomplete";
    }
    if (!/=== 摘要 ===/.test(text)) return "incomplete";
    return exit?.code === 0 ? "ok" : "harness-exit";
}

/**
 * 解析一份老布局的 `perf.log`。缺关键字段（不是一次完整运行的日志）时返回 null。
 */
export function parseLegacyPerfLog(runId: string, text: string): LegacyRunMeta | null {
    const scriptPath = /启动 mock: .*?--script (\S+)/.exec(text)?.[1];
    const commandLine = /启动 harness: (.*?)（cwd=/.exec(text)?.[1];
    const endToEnd = /端到端时长: ([\d.]+)s（harness 启动 → 退出；采样窗口 ([\d.]+)s）/.exec(text);
    if (scriptPath === undefined || commandLine === undefined || endToEnd === null) return null;

    const segments =
        /时长分段: 启动 → 首个请求 ([\d.]+)s ｜ 首个请求 → 末次请求 ([\d.]+)s ｜ 末次请求 → 退出 ([\d.]+)s/.exec(
            text,
        );
    const requests = /mock 请求数: (\d+)/.exec(text)?.[1];
    const cursor = /mock 游标: index=\S+ \/ (\S+)/.exec(text)?.[1];
    const exitMatch = /harness 退出: code=(\S+) signal=(\S+)/.exec(text);
    const startIso = /^开始: (.+)$/m.exec(text)?.[1]?.trim() ?? null;
    const interval = /采样开始: .*?间隔 (\d+)ms/.exec(text)?.[1];
    const backend = /采样开始: (proc_pid_rusage|ps)/.exec(text)?.[1];

    const exit =
        exitMatch === null
            ? null
            : {
                  code: exitMatch[1] === "null" ? null : Number(exitMatch[1]),
                  signal: exitMatch[2] === "无" ? null : exitMatch[2]!,
              };

    return {
        runId,
        harnessId: harnessIdFromCommandLine(commandLine),
        commandLine,
        cwd: /启动 harness: .*?（cwd=([^，）]+)/.exec(text)?.[1] ?? null,
        scriptPath,
        port: Number(/--port (\d+)/.exec(text)?.[1] ?? "") || null,
        exhausted: /--exhausted (\S+)/.exec(text)?.[1] ?? null,
        samplingBackend: backend === undefined ? null : backend === "ps" ? "ps" : "rusage",
        samplingIntervalMs: interval === undefined ? null : Number(interval),
        startIso,
        harnessStartedAtMs: epochAt(startIso, /\[\+([\d.]+)s\] 启动 harness:/.exec(text)?.[1]),
        samplingStartedAtMs: epochAt(startIso, /\[\+([\d.]+)s\] 采样开始:/.exec(text)?.[1]),
        endToEndMs: ms(endToEnd[1]),
        samplingWindowMs: ms(endToEnd[2]),
        requests: requests === undefined ? null : Number(requests),
        mockCursorSize: cursor === undefined || cursor === "?" ? null : Number(cursor),
        segments:
            segments === null
                ? null
                : {
                      startupMs: ms(segments[1])!,
                      spanMs: ms(segments[2])!,
                      tailMs: ms(segments[3])!,
                  },
        exit,
        status: legacyStatusOf(text, exit),
    };
}
