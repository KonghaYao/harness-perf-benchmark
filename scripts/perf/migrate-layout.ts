#!/usr/bin/env bun
/**
 * 老布局 → 新布局的一次性迁移：把平铺的
 *
 *   data/claude-date/<runId>-{perf.log,samples.csv,harness.log,mock.log}
 *
 * 搬成一次运行一个目录，并**反推**出一份 `run.json`：
 *
 *   data/runs/<harness>/<runId>/{run.json,samples.csv,perf.log,harness.log,mock.log}
 *
 * 反推的依据是 legacy-run.ts（老日志的正则解析）+ samples.csv 重算的摘要；
 * 老产物里**还原不出**的字段（绝对时刻、宿主信息、剧本 sha、limits…）一律写 null，
 * 不猜——读的人要能分清「当时没记」与「记了是空」。
 *
 *   bun run scripts/perf/migrate-layout.ts --dry-run        # 只看要做什么
 *   bun run scripts/perf/migrate-layout.ts                  # 真迁（移动）
 *   bun run scripts/perf/migrate-layout.ts --copy           # 保留源文件（先演练一遍用）
 *   bun run scripts/perf/migrate-layout.ts --min-age-sec 0  # 允许搬「刚写完」的文件
 *
 * 三种保护：
 *   1. **幂等**：目标目录里已有 run.json 就跳过；源文件不在了也跳过；可安全重复执行。
 *   2. **不覆盖**：两侧同名文件都在时，把源文件改名成 `<name>.conflict-<时间戳>` 放进目标目录，
 *      并在结尾列出来（不丢数据、也不猜哪个才是对的）。
 *   3. **不碰运行中的产物**：按 runId 取该组文件的最新 mtime，太年轻就拒迁（`--min-age-sec`，
 *      默认 120s）——迁移脚本把一个正在 append 的文件搬走，写入端会在新位置重建同名文件，
 *      那就真的分裂了。
 *
 * 源目录迁空后**不自动删**：由人确认一遍再 `rmdir`。
 */

import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "./config";
import { harnessIdFromCommandLine, isValidHarnessId } from "./harness-id";
import { parseLegacyPerfLog, type LegacyRunMeta } from "./legacy-run";
import { RUN_META_SCHEMA_VERSION, writeJsonAtomic, type RunMeta, type RunStatus } from "./run-meta";
import { parseSamplesCsv, summarize } from "./sampler";
import { resourceCost } from "./score";

const USAGE = `把老布局（平铺的 <runId>-*.{log,csv}）迁成一次运行一个目录

用法:
  bun run scripts/perf/migrate-layout.ts [选项]

选项:
  --from <dir>        源目录（默认 data/claude-date）
  --to <dir>          目标根目录（默认 data/runs）
  --min-age-sec <n>   文件组的最新 mtime 距今小于 n 秒则拒迁，防搬走运行中的产物（默认 120）
  --dry-run           只打印将要做的事，不动文件
  --copy              拷贝而不是移动（源文件保留）
  --force             越过 --min-age-sec 的保护
  -h, --help          显示本帮助
`;

/** 老布局的四个文件在目标目录里的新名字。 */
const FILE_ROLES = {
    perf: "perf.log",
    samples: "samples.csv",
    harness: "harness.log",
    mock: "mock.log",
} as const;

type Role = keyof typeof FILE_ROLES;

interface SourceRun {
    runId: string;
    /** runId → 老文件绝对路径。 */
    files: Partial<Record<Role, string>>;
    /** 该组文件的最新 mtime（毫秒）。 */
    newestMtimeMs: number;
}

/** 扫描源目录，按 runId 把 `<runId>-<role>.<ext>` 归组。 */
export function scanSource(from: string): SourceRun[] {
    const groups = new Map<string, Partial<Record<Role, string>>>();
    for (const name of readdirSync(from).sort()) {
        for (const [role, fileName] of Object.entries(FILE_ROLES) as [Role, string][]) {
            const suffix = `-${fileName}`;
            if (!name.endsWith(suffix)) continue;
            const runId = name.slice(0, -suffix.length);
            const group = groups.get(runId) ?? {};
            group[role] = join(from, name);
            groups.set(runId, group);
        }
    }
    return [...groups].map(([runId, files]) => ({
        runId,
        files,
        newestMtimeMs: Math.max(
            ...Object.values(files).map((path) => statSync(path).mtimeMs),
        ),
    }));
}

/**
 * 老日志 + CSV → run.json。`legacy` 为 null 表示连日志都解析不了（产物残缺）：
 * 那就只按文件本身落一份最小 run.json，harness 归到 unknown/，别把文件丢在原地。
 * 还原不出的字段一律 null。
 */
export function buildMigratedMeta(
    run: SourceRun,
    legacy: LegacyRunMeta | null,
    sourceDir: string,
    migratedAt: string,
): RunMeta {
    const csvPath = run.files.samples;
    let summary: RunMeta["summary"] = null;
    let summarySource: RunMeta["summarySource"] = null;
    let cost: RunMeta["cost"] = null;
    if (csvPath !== undefined) {
        try {
            const samples = parseSamplesCsv(readFileSync(csvPath, "utf8"));
            if (samples.length > 0) {
                summary = { ...summarize(samples) };
                summarySource = "samples";
                // 老产物没有 harnessExitedAtMs，尾部空档补不了：这一份是下界。
                cost = resourceCost(samples);
            }
        } catch {
            // CSV 读不动（列不全/损坏）就当没有摘要，不因一个文件挡住整次迁移。
        }
    }
    const artifacts = Object.fromEntries(
        (Object.entries(FILE_ROLES) as [Role, string][]).map(([role, fileName]) => {
            const path = run.files[role];
            return [
                role,
                path === undefined || !existsSync(path)
                    ? null
                    : { file: fileName, bytes: statSync(path).size },
            ];
        }),
    ) as RunMeta["artifacts"];

    const scriptPath = legacy?.scriptPath ?? null;
    const status: RunStatus = legacy?.status ?? "incomplete";
    return {
        schemaVersion: RUN_META_SCHEMA_VERSION,
        runId: run.runId,
        status,
        error: null,
        legacy: {
            layout: "flat",
            source: relative(REPO_ROOT, sourceDir),
            migratedAt,
        },
        harness: {
            id: legacy === null ? "unknown" : harnessIdFromCommandLine(legacy.commandLine),
            idSource: "command",
            command: null,
            commandLine: legacy?.commandLine ?? null,
            cwd: legacy?.cwd ?? null,
            binary: null,
            version: null,
            env: null,
        },
        scenario: {
            path: scriptPath ?? "",
            relPath:
                scriptPath === null || relative(REPO_ROOT, scriptPath).startsWith("..")
                    ? null
                    : relative(REPO_ROOT, scriptPath),
            name: scriptPath === null ? "" : (scriptPath.split("/").pop() ?? scriptPath),
            sizeBytes: scriptPath !== null && existsSync(scriptPath) ? statSync(scriptPath).size : null,
            sha256: null,
        },
        mock: {
            port: legacy?.port ?? 0,
            exhausted: legacy?.exhausted ?? "unknown",
            readyMs: null,
            requests: legacy?.requests ?? null,
            // 老日志分不出请求数来自哪条路径，按主路径记，并接受这一点。
            requestsSource: legacy?.requests == null ? null : "status",
            cursor:
                legacy?.mockCursorSize == null
                    ? null
                    : { index: 0, size: legacy.mockCursorSize, exhausted: true },
        },
        sampling: {
            intervalMs: legacy?.samplingIntervalMs ?? 0,
            backend: legacy?.samplingBackend ?? "rusage",
            withTree: null,
            format: "csv",
        },
        limits: null,
        prompt: null,
        label: null,
        host: null,
        startedAtMs: legacy?.harnessStartedAtMs ?? 0,
        startedAt: legacy?.startIso ?? "",
        endedAtMs: null,
        endedAt: null,
        duration: {
            endToEndMs: legacy?.endToEndMs ?? null,
            samplingWindowMs: legacy?.samplingWindowMs ?? null,
        },
        timing: {
            harnessStartedAtMs: legacy?.harnessStartedAtMs ?? null,
            samplingStartedAtMs: legacy?.samplingStartedAtMs ?? null,
            // 老日志只有相对秒，绝对 epoch 还不了原；分界线由 segments + anchor 推。
            firstRequestAtMs: null,
            lastRequestAtMs: null,
            harnessExitedAtMs: null,
        },
        segments:
            legacy?.segments == null
                ? null
                : { ...legacy.segments, idleTail: legacy.segments.tailMs >= 1000 },
        summary,
        summarySource,
        cost,
        exit: legacy?.exit ?? null,
        artifacts,
    };
}

export interface MigrateOptions {
    from: string;
    to: string;
    minAgeSec: number;
    dryRun: boolean;
    copy: boolean;
    force: boolean;
    /** 注入时钟，便于测试。 */
    now?: () => number;
}

export interface MigrateReport {
    migrated: string[];
    skipped: string[];
    tooYoung: string[];
    conflicts: string[];
    /** 归属不明的运行（harness 反推不出来）。 */
    unknownHarness: string[];
}

/** 移动或拷贝一个文件；跨设备（EXDEV）时退化成「拷贝 + 删源」，逐个文件做，不用 rm -rf。 */
function transfer(source: string, target: string, copy: boolean): void {
    if (existsSync(target)) return;
    if (!copy) {
        try {
            renameSync(source, target);
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        }
    }
    if (source === target) return;
    copyFileSync(source, target);
    if (!copy) unlinkSync(source);
}

/** 目标侧是否已经存在这次运行（任意 harness 目录下）。目标根还不存在时当然没有。 */
function findExistingRun(to: string, runId: string): string | null {
    if (!existsSync(to)) return null;
    for (const harnessDir of readdirSync(to)) {
        const candidate = join(to, harnessDir, runId);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/** 目标目录里四个产物的字节数（迁移后才知道最终大小，所以搬完再补）。 */
function artifactsOfDir(dir: string): RunMeta["artifacts"] {
    const entries = (Object.entries(FILE_ROLES) as [Role, string][]).map(([role, fileName]) => {
        const path = join(dir, fileName);
        return [role, existsSync(path) ? { file: fileName, bytes: statSync(path).size } : null];
    });
    return Object.fromEntries(entries) as RunMeta["artifacts"];
}

/**
 * 执行迁移。返回清单（dry-run 时只统计不落盘）。幂等：可重复执行。
 */
export function migrateLayout(options: MigrateOptions): MigrateReport {
    const now = options.now ?? (() => Date.now());
    const migratedAt = new Date(now()).toISOString();
    const report: MigrateReport = {
        migrated: [],
        skipped: [],
        tooYoung: [],
        conflicts: [],
        unknownHarness: [],
    };
    const runs = scanSource(options.from);

    for (const run of runs) {
        // mtime 的精度可能比 Date.now() 高（APFS 亚毫秒），算出来会是 -0.0005s 这种负值，
        // 所以阈值 0 必须解释成「不设保护」，而不是「小于 0 就拒迁」。
        const ageSec = (now() - run.newestMtimeMs) / 1000;
        if (!options.force && options.minAgeSec > 0 && ageSec < options.minAgeSec) {
            report.tooYoung.push(`${run.runId}（${ageSec.toFixed(0)}s 前还在写）`);
            continue;
        }
        const perfPath = run.files.perf;
        const legacy =
            perfPath === undefined ? null : parseLegacyPerfLog(run.runId, readFileSync(perfPath, "utf8"));
        // 解析不出来（或解析出的 id 不合法）就落到 unknown/：文件照迁、run.json 留最小一份，
        // 既不丢数据也不冒充别人。这属于要人看一眼的异常，单独列出来。
        const harnessDir =
            legacy !== null && isValidHarnessId(legacy.harnessId) ? legacy.harnessId : "unknown";
        if (harnessDir === "unknown") report.unknownHarness.push(run.runId);

        // 目标侧已经有这次运行（「同一次运行横跨两种布局」的中间态）：只补搬缺的文件，
        // 已有的一律不覆盖，也不再写第二份 run.json。
        const existing = findExistingRun(options.to, run.runId);
        const targetDir = existing ?? join(options.to, harnessDir, run.runId);
        if (existing !== null) {
            report.skipped.push(`${run.runId}（目标侧已有，补搬缺的文件）`);
        }

        if (options.dryRun) {
            report.migrated.push(`${harnessDir}/${run.runId}`);
            continue;
        }
        mkdirSync(targetDir, { recursive: true });
        // 先读源文件生成元数据（搬走之后就读不到了），搬完再补 artifacts 的字节数。
        const meta = existing === null ? buildMigratedMeta(run, legacy, options.from, migratedAt) : null;
        for (const [role, fileName] of Object.entries(FILE_ROLES) as [Role, string][]) {
            const source = run.files[role];
            if (source === undefined) continue;
            const target = join(targetDir, fileName);
            if (existsSync(target) && statSync(target).size !== statSync(source).size) {
                // 两侧都有且大小不同：不覆盖、不猜，改名留档。
                const archived = join(targetDir, `${fileName}.conflict-${now()}`);
                transfer(source, archived, true);
                report.conflicts.push(`${run.runId}/${fileName}`);
                continue;
            }
            transfer(source, target, options.copy);
        }
        if (meta !== null) {
            meta.artifacts = artifactsOfDir(targetDir);
            writeJsonAtomic(join(targetDir, "run.json"), meta);
        }
        if (existing === null) report.migrated.push(`${harnessDir}/${run.runId}`);
    }
    return report;
}

function main(): void {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            from: { type: "string" },
            to: { type: "string" },
            "min-age-sec": { type: "string" },
            "dry-run": { type: "boolean" },
            copy: { type: "boolean" },
            force: { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
        strict: true,
    });
    if (values.help === true) {
        console.log(USAGE);
        process.exit(0);
    }

    const from = values.from ?? join(REPO_ROOT, "data/claude-date");
    const to = values.to ?? join(REPO_ROOT, "data/runs");
    if (!existsSync(from)) {
        console.log(`[migrate] 源目录不存在，无需迁移: ${relative(REPO_ROOT, from)}`);
        process.exit(0);
    }
    mkdirSync(to, { recursive: true });
    const report = migrateLayout({
        from,
        to,
        minAgeSec: Number(values["min-age-sec"] ?? "120"),
        dryRun: values["dry-run"] === true,
        copy: values.copy === true,
        force: values.force === true,
    });

    const prefix = values["dry-run"] === true ? "[migrate] （dry-run）" : "[migrate]";
    for (const item of report.migrated) console.log(`${prefix} 迁移 ${item}`);
    for (const item of report.skipped) console.log(`${prefix} 跳过（已迁移）${item}`);
    for (const item of report.tooYoung) console.log(`${prefix} 拒迁（可能正在跑）${item}`);
    for (const item of report.conflicts) console.warn(`${prefix} 冲突：保留为 .conflict-* ${item}`);
    for (const item of report.unknownHarness) {
        console.warn(`${prefix} 归属不明（落到 unknown/）${item}`);
    }
    console.log(
        `${prefix} 完成：迁移 ${report.migrated.length} · 跳过 ${report.skipped.length} · ` +
            `拒迁 ${report.tooYoung.length} · 冲突 ${report.conflicts.length} · ` +
            `归属不明 ${report.unknownHarness.length}`,
    );
    const leftover = existsSync(from) ? readdirSync(from).filter((name) => !name.startsWith(".")) : [];
    if (leftover.length === 0) {
        console.log(
            `${prefix} 源目录已空；确认无误后自行删除：rmdir ${relative(REPO_ROOT, from)}`,
        );
    } else if (values["dry-run"] !== true) {
        console.log(`${prefix} 源目录还剩 ${leftover.length} 个文件（上面列出的拒迁/冲突会留在原地）`);
    }
    process.exit(report.conflicts.length > 0 || report.tooYoung.length > 0 ? 1 : 0);
}

if (import.meta.main) main();
