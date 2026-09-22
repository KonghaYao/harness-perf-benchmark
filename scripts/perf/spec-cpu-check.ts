#!/usr/bin/env bun
/**
 * SPEC CPU 2017 检查：借鉴阿里云的 intrate、copies=vCPU、10 次评测方法。
 * https://help.aliyun.com/zh/ecs/user-guide/computing-performance-benchmark-scores-for-major-instance-families
 * https://help.aliyun.com/zh/ecs/user-guide/computing-performance-stress-testing-for-instances
 * 仅生成命令、校验真实 CSV 和对照参考结果；不安装套件、不执行压测、不修改 CU。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkSpecResults } from "./spec-cpu";

const USAGE = `SPEC CPU 2017 检查（需要自行取得授权、安装套件并准备适配本机的编译配置）

用法:
  bun run scripts/perf/spec-cpu-check.ts --plan --spec-root /opt/cpu2017 --config /opt/cpu2017/config/local.cfg --vcpus 4
  bun run scripts/perf/spec-cpu-check.ts --result run1.csv --result run2.csv --vcpus 4 --repeats 2

模式:
  --plan                  只打印 POSIX shell 测试命令，不执行、不下载
  --result <csv>          检查官方格式 CSV，可重复；需显式列出同一机器/配置的结果
  --reference <csv>       参考机器 CSV，可重复；需同时提供 --reference-vcpus
  --reference-vcpus <n>   参考机器本次测试分配的逻辑 CPU 数
  --vcpus <n>             本次测试分配的逻辑 CPU 数（必填，不猜容器配额）
  --repeats <n>           独立完整评测次数，默认 10，至少 2（不是 runcpu 的 iterations）
  --spec-root <path>      已授权安装的 SPEC CPU 2017 目录（plan 必填）
  --config <path>         本机可用的 SPEC 配置文件（plan 必填）
  --out <path>            校验成功后保存 JSON；拒绝覆盖已有文件
  -h, --help             显示帮助

检查固定采用 intrate / base / ref：每份 CSV 是一轮完整结果，copies 必须等于 vcpus。
配置需正确设置 flagsurl，消除 unknown/forbidden flags；valid=0 的结果不会进入统计。
参考结果必须使用相同套件版本和同样次数；不同 CPU 需要适配编译器和配置。
只计算吞吐等效 vCPU，不把全核均摊值冒充单线程性能，不修改 CU。
本地检查不等于 SPEC 官方认证；完整 SPEC 可能耗时数小时并占用大量内存。
`;

function positiveInt(value: string | undefined, name: string, minimum = 1): number {
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
        throw new Error(`${name} 必须是至少 ${minimum} 的整数`);
    }
    return Number(value);
}

function quote(value: string): string {
    if (/[\r\n\0]/.test(value)) throw new Error("路径不能包含换行或 NUL");
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function printPlan(root: string, config: string, vcpus: number, repeats: number): void {
    const configPath = resolve(config);
    if (dirname(configPath) !== resolve(root, "config") || !configPath.endsWith(".cfg")) {
        throw new Error("--config 必须指向 --spec-root/config/ 下的 .cfg 文件；请先自行准备，不自动复制配置");
    }
    console.log("# 需先取得 SPEC CPU 2017 授权并安装；只生成命令，未检查工具链兼容性。");
    console.log("# 不要与 harness 压测并发。--loose 结果仅供内部检查，不是官方认证成绩。");
    console.log("# config 必须正确设置 flagsurl；若 valid=0，先检查报告 Errors/Unknown Flags，再用 rawformat 重导出。");
    console.log("(");
    console.log(`  cd ${quote(resolve(root))} || exit 1`);
    console.log("  . ./shrc || exit 1");
    for (let i = 1; i <= repeats; i++) {
        console.log(`  # 独立评测 ${i}/${repeats}；记录本次生成的 CSV 路径，不要重复导入副本。`);
        console.log(`  runcpu --config=${quote(basename(configPath))} --copies=${vcpus} --tune=base --size=ref --iterations=3 --loose --output_format=csv intrate || exit 1`);
    }
    console.log(")");
}

export async function main(args = process.argv.slice(2)): Promise<void> {
    const { values } = parseArgs({ args, strict: true, options: {
        help: { type: "boolean", short: "h" }, plan: { type: "boolean" },
        "spec-root": { type: "string" }, config: { type: "string" },
        vcpus: { type: "string" }, repeats: { type: "string", default: "10" },
        result: { type: "string", multiple: true }, reference: { type: "string", multiple: true },
        "reference-vcpus": { type: "string" }, out: { type: "string" },
    } });
    if (values.help) { console.log(USAGE); return; }
    const vcpus = positiveInt(values.vcpus, "--vcpus");
    const repeats = positiveInt(values.repeats, "--repeats", 2);
    if (values.plan) {
        if (values.result || values.reference || values["reference-vcpus"] || values.out) {
            throw new Error("--plan 不能与结果检查选项混用");
        }
        if (!values["spec-root"] || !values.config) throw new Error("--plan 需要 --spec-root 和 --config");
        printPlan(values["spec-root"], values.config, vcpus, repeats);
        return;
    }
    if (values["spec-root"] || values.config) throw new Error("--spec-root/--config 仅用于 --plan");
    if (!values.result) throw new Error("请提供 --result，或使用 --plan 生成命令");
    if (Boolean(values.reference) !== Boolean(values["reference-vcpus"])) {
        throw new Error("--reference 与 --reference-vcpus 必须一起提供");
    }
    const measured = checkSpecResults(values.result, vcpus, repeats);
    const reference = values.reference ? checkSpecResults(values.reference,
        positiveInt(values["reference-vcpus"], "--reference-vcpus"), repeats) : null;
    if (reference && reference.suiteVersion !== measured.suiteVersion) {
        throw new Error("参考机器与受测机器的 SPEC 套件版本必须一致");
    }
    const report = {
        schemaVersion: 1, method: "spec2017-intrate-base-ref-v1", checkedAt: new Date().toISOString(),
        measured, reference,
        equivalence: reference ? {
            basis: "本批参考 CSV 的每 vCPU 平均吞吐，仅适用于该并发负载",
            throughputEquivalentVcpus: measured.mean / reference.scorePerVcpu,
            perVcpuThroughputRatio: measured.scorePerVcpu / reference.scorePerVcpu,
        } : null,
        appliedToCu: false,
        warnings: [
            "本地 CSV 检查不等于 SPEC 官方认证；请保留原始结果和实际编译配置供审计。",
            "scorePerVcpu 是并发负载下的均摊吞吐，不是单线程速度，也不是进程 CPU 时间的校准系数。",
            "内存、编译器、OS、SMT、调度与负载都会影响结果；不能保证任意 harness 跨设备绝对一致。",
            ...(reference && reference.vcpus !== vcpus
                ? ["受测与参考的 copies 不同：换算仅描述各自并发度下的吞吐，不代表扩容到该 vCPU 数后性能相同。"] : []),
            ...(reference && (reference.runs[0]!.compiler !== measured.runs[0]!.compiler
                || reference.runs[0]!.os !== measured.runs[0]!.os
                || reference.runs[0]!.baseSettingsSha256 !== measured.runs[0]!.baseSettingsSha256)
                ? ["受测与参考的软件环境/编译配置不同：吞吐差异包含软件影响，不是纯硬件倍率。"] : []),
            ...(repeats !== 10 ? ["本批不是阿里云示例的 10 次独立评测。"] : []),
        ],
    };
    if (report.equivalence && ![report.equivalence.throughputEquivalentVcpus,
        report.equivalence.perVcpuThroughputRatio].every(value => Number.isFinite(value) && value > 0)) {
        throw new Error("参考换算超出可表示的数值范围，拒绝输出失真分数");
    }
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) {
        const out = resolve(values.out);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, json, { flag: "wx" });
    }
    console.log(json.trimEnd());
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "SPEC 检查失败");
        process.exitCode = 1;
    });
}
