/**
 * 压测配置：命令行参数解析。风格与 src/config.ts 一致（node:util 的 parseArgs、
 * 中文报错、非法取值可定位）。相对路径按**启动时的工作目录**解析，内置默认值按仓库根解析。
 *
 *   bun run scripts/perf/run.ts --script data/scenarios/long-run.json --turns 100 --timeout-ms 600000
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ExhaustedPolicy } from "../../src/config";
import { isValidHarnessId } from "./harness-id";
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
    /** mock 剧本（绝对路径）。**必填**：没有隐式默认路径，避免误加载别的剧本。 */
    scriptPath: string;
    /**
     * harness 二进制（绝对路径）。默认**只取 PATH 里的 `peri`**，取不到就是 null——不回退
     * `../perihelion` 的 debug 构建（读数不可比）。各 demo 用自家 harness（Claude Code /
     * Codex / pi / dsh）且没传 `--peri` 时，这里同样是 null。
     */
    periPath: string | null;
    /** harness 的工作目录：`{cwd}/.peri/settings.json` 只在这里生效。 */
    workDir: string;
    /** 产物根目录（绝对路径）：一次运行落在 `<outDir>/<harnessId>/<runId>/`。 */
    outDir: string;
    /**
     * harness 身份（目录名）。null = 由 run.ts 从启动命令推断（见 harness-id.ts）。
     * 各 playground 的 perf-demo.ts 会带上自己的默认值，命令行 `--harness` 优先。
     */
    harnessId: string | null;
    /** 批次/场景标签（自由文本，进 run.json，便于日后按批次筛）。 */
    label: string | null;
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
 * 默认 harness 二进制：**只认 PATH 里的 `peri`**（用户装的发布版）。
 *
 * 不回退同级的本地构建产物（`../perihelion/target/debug/peri`）：debug 构建的读数与发布版
 * 不可比，静默换一个二进制等于偷偷换了被测对象。找不到就返回 null，由真正要用 peri 的路径
 * （run.ts 的默认 harness 命令）给出可操作的报错；各 demo 用自家 harness 时不受影响。
 */
export function defaultHarnessPath(): string | null {
    return Bun.which("peri");
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
    if (value === "error" || value === "hold" || value === "loop" || value === "stop") {
        return value;
    }
    throw new Error(`exhausted 必须是 error | hold | loop | stop，收到: ${JSON.stringify(value)}`);
}

/**
 * 调用方（各 playground 的 perf-demo.ts）补的默认值。**必须在解析时就得拿到**，不能等
 * `loadPerfConfig` 返回后再往 config 上写——那样赶不上 --script 的必填校验（校验在解析里）。
 */
export interface PerfConfigDefaults {
    /**
     * 用户没传 `--script` 时用的剧本（相对路径按 cwd 解析）。各家 demo 填自家工具形状的那份；
     * run.ts 不传，因此 `--script` 对它仍是必填。
     */
    scriptPath?: string;
}

export function loadPerfConfig(
    argv: string[] = process.argv.slice(2),
    cwd: string = process.cwd(),
    defaults: PerfConfigDefaults = {},
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
            harness: { type: "string" },
            label: { type: "string" },
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

    // 剧本必填（与 src/config.ts 同一条约定）：mock 的行为完全由剧本决定，给个隐式默认路径
    // 会让「忘了传 --script」静默跑到别的剧本上。各家 playground 的 perf-demo.ts 通过
    // defaults 参数带自家默认剧本，run.ts 不传 —— 对它而言就是必填。
    const scriptArg = values.script?.trim() ?? "";
    const script = scriptArg !== "" ? scriptArg : (defaults.scriptPath?.trim() ?? "");
    if (script === "") {
        throw new Error(
            "必须用 --script 指定 mock 剧本（例：--script data/scenarios/long-run.json）；" +
                "剧本没有默认路径，避免误加载别的剧本",
        );
    }

    // harness id 要当目录名用：给不合法的值就报错，别让它静默变成一个奇怪的目录。
    const harnessId = values.harness?.trim();
    if (harnessId !== undefined && harnessId !== "" && !isValidHarnessId(harnessId)) {
        throw new Error(
            `harness 只能是小写字母/数字/连字符（例：claude-code），收到: ${JSON.stringify(values.harness)}`,
        );
    }

    return {
        turns: integer(values.turns, "turns", 25, 1, 100_000),
        intervalMs: integer(values["interval-ms"], "interval-ms", 100, 10, 60_000),
        timeoutMs: integer(values["timeout-ms"], "timeout-ms", 60_000, 1_000, 86_400_000),
        readyTimeoutMs: integer(values["ready-timeout-ms"], "ready-timeout-ms", 10_000, 100, 600_000),
        prompt,
        scriptPath: resolve(cwd, script),
        periPath: values.peri === undefined ? defaultHarnessPath() : resolve(cwd, values.peri),
        workDir: resolve(cwd, values["work-dir"] ?? resolve(REPO_ROOT, "playground/peri")),
        outDir: resolve(cwd, values["out-dir"] ?? resolve(REPO_ROOT, "data/runs")),
        harnessId: harnessId === undefined || harnessId === "" ? null : harnessId,
        label: values.label?.trim() === "" ? null : (values.label?.trim() ?? null),
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
