#!/usr/bin/env bun
/**
 * 本机 CPU 校准 CLI：跑 7-Zip 内置基准，出一份 `calibration.json`。
 *
 *   bun run cpu:calibrate                                  # → data/calibration/<timestamp>/
 *   bun run cpu:calibrate --repeats 3 --threads 8
 *
 * 产物（一个时间戳目录，可整个拷走/回查）：
 *   calibration.json      折算系数 + 宿主快照 + 逐轮读数 + 统计 + 日志 sha256
 *   warmup.log            第 1 轮（单线程），**不计入统计**
 *   single-<n>.log        单线程第 n 轮原始输出
 *   machine-<n>.log       整机（-mmt<threads>）第 n 轮原始输出
 *
 * 它**只读本机已有的 7-Zip**：不下载、不安装、不执行 shell（参数以数组交给 `Bun.spawn`）。
 * 拿不到二进制就报错退出。校准值只在量它的那台机器上成立：`run.ts` / `gen-chart-data.ts`
 * 会拿校准 JSON 里的宿主快照与产物逐项核对，不符就拒绝，不静默用错 host。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    BASELINE_MIPS_PER_CPU_SECOND,
    CALIBRATION_METHOD,
    CALIBRATION_SCHEMA_VERSION,
    DEFAULT_REPEATS,
    DEFAULT_TIMEOUT_S,
    MIN_REPEATS,
    SEVEN_ZIP_VERSION,
    calibrate,
    defaultCalibrationDir,
    resolveSevenZipBinary,
} from "./calibrate";
import { formatCpuScale } from "./score";

const USAGE = `本机 CPU 校准：用固定版本的 7-Zip 内置基准量「本机一秒 = 多少个项目标准 CPU 单位秒」

用法:
  bun run cpu:calibrate [选项]                     # = bun run scripts/perf/calibrate-cli.ts
  bun run scripts/perf/calibrate-cli.ts [选项]

选项:
  --binary <path>     7-Zip 二进制（默认先找 PATH 里的 7zz，再退到 /opt/homebrew/bin/7zz）
  --out-dir <path>    产物目录（默认 data/calibration/<YYYYMMDD-HHMMSS>，一次校准一套，不覆盖）
  --repeats <n>       测量轮次（默认 ${DEFAULT_REPEATS}，至少 ${MIN_REPEATS}）；另跑 1 轮 warmup 且不计入
  --threads <n>       整机吞吐那一路的线程数（默认 availableParallelism）
  --timeout-s <n>     单次基准的超时秒数（默认 ${DEFAULT_TIMEOUT_S}）
  -h, --help          显示本帮助

口径:
  - 固定 7-Zip ${SEVEN_ZIP_VERSION}、固定参数 b 1 -mmt1 -md25，只取输出里 "25:"（32MiB 字典）那一行；
  - cpuScale = mean(单线程 R/U) / ${BASELINE_MIPS_PER_CPU_SECOND}（**乘**进 core·秒）；
    baseline ${BASELINE_MIPS_PER_CPU_SECOND} 是 7-Zip 历史 normalized rating 的项目单位，
    **本项目自定、没有真实参考机器**（不是「本机等于某台机器的几秒」），
    不是真实机器指令数，也不是 SPEC / 云商的 vCPU 数；
  - 整机那一路给的是「原始 Rating 均值 / ${BASELINE_MIPS_PER_CPU_SECOND}」的**本次观察吞吐**，
    不是「单线程读数 × 逻辑核数」；
  - 只乘 CPU 项：内存项是本机实测的 GB·秒，不折算。
`;

function integer(value: string | undefined, label: string, fallback: number, min: number): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
        throw new Error(`${label} 必须是 >= ${min} 的整数，收到: ${JSON.stringify(value)}`);
    }
    return parsed;
}

/**
 * 选一个**空的**输出目录：显式给的目录若已存在且非空就拒绝（绝不往已有校准目录里塞第二份）；
 * 默认的时间戳目录撞上同一秒（连跑两次）就往后挪一位，仍然不覆盖。
 */
export function pickOutDir(dir: string | undefined, explicit: boolean): string {
    const target = dir === undefined || dir === "" ? defaultCalibrationDir() : resolve(dir);
    if (existsSync(target) && readdirSync(target).length > 0) {
        if (explicit) {
            throw new Error(`${target} 非空：不给已有校准目录里塞第二份产物，换个 --out-dir`);
        }
        for (let n = 2; ; n += 1) {
            const candidate = `${target}-${n}`;
            if (!existsSync(candidate)) {
                mkdirSync(candidate, { recursive: true });
                return candidate;
            }
        }
    }
    mkdirSync(target, { recursive: true });
    return target;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
    const { values } = parseArgs({
        args,
        options: {
            binary: { type: "string" },
            "out-dir": { type: "string" },
            repeats: { type: "string" },
            threads: { type: "string" },
            "timeout-s": { type: "string" },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
        strict: true,
    });
    if (values.help === true) {
        console.log(USAGE);
        return;
    }
    // 参数与二进制先全部校验完再建目录：`--repeats 1` / `--binary` 指错这类错，
    // 不该在磁盘上留下一个空的时间戳目录（那会让人以为「这里跑过一次校准」）。
    const repeats = integer(values.repeats, "--repeats", DEFAULT_REPEATS, MIN_REPEATS);
    const threads = values.threads === undefined ? undefined : integer(values.threads, "--threads", 0, 1);
    const timeoutS = integer(values["timeout-s"], "--timeout-s", DEFAULT_TIMEOUT_S, 1);
    const binary = resolveSevenZipBinary(values.binary);
    const outDir = pickOutDir(values["out-dir"], values["out-dir"] !== undefined);
    const calibration = await calibrate({
        binary,
        repeats,
        threads,
        timeoutS,
        logDir: outDir,
        log: (line) => console.log(line),
    });
    const json = `${JSON.stringify(calibration, null, 2)}\n`;
    writeFileSync(resolve(outDir, "calibration.json"), json);

    const single = calibration.singleThread.stats.rating;
    const machine = calibration.machine.stats.rating;
    console.log(
        `[calibrate] cpuScale ${formatCpuScale(calibration.scale.cpuScale)} ` +
            `= ${calibration.scale.cpuScaleValue} / ${calibration.scale.baselineMips}` +
            `（单线程 Rating ${single.mean.toFixed(0)}，CV ${single.cvPercent.toFixed(2)}%，` +
            `${single.count} 轮 + 1 轮 warmup 不计入）`,
    );
    console.log(
        `[calibrate] 整机 ${calibration.machine.threads} 线程：Rating 均值 ${machine.mean.toFixed(0)}` +
            `（CV ${machine.cvPercent.toFixed(2)}%）= 标准单位 ${calibration.machine.standardUnits.throughput.toFixed(3)}` +
            `（本次观察吞吐，非「单线程 × 核数」）`,
    );
    for (const warning of calibration.warnings) {
        console.log(`[calibrate] ⚠ ${warning.code}: ${warning.message}`);
    }
    console.log(
        `[calibrate] 已写入 ${resolve(outDir, "calibration.json")}` +
            `（schemaVersion ${CALIBRATION_SCHEMA_VERSION} · method ${CALIBRATION_METHOD}）；` +
            "下一步：run.ts / gen-chart-data.ts 加 --cpu-calibration <该文件>",
    );
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "校准失败");
        process.exitCode = 1;
    });
}
