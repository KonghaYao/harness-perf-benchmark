/**
 * 官方 CSV 格式的 intrate/base/ref 结果检查，不重跑或仿造 SPEC 工作负载。
 * 格式与选中规则：https://www.spec.org/cpu2017/Docs/result-fields.html
 * 原始 CSV 仍是审计依据；结构校验不是签名验证，也不代表 SPEC 官方认证。
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

export const SPEC_METRIC = "SPECrate2017_int_base";
const BENCHMARKS = [
    "500.perlbench_r", "502.gcc_r", "505.mcf_r", "520.omnetpp_r", "523.xalancbmk_r",
    "525.x264_r", "531.deepsjeng_r", "541.leela_r", "548.exchange2_r", "557.xz_r",
];

function hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** 支持引号内逗号、换行、双引号转义及 CRLF，不能用 split(',') 读 SPEC 报告。 */
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], field = "", quoted = false, closed = false;
    const input = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < input.length; i++) {
        const char = input[i]!;
        if (quoted) {
            if (char !== '"') field += char;
            else if (input[i + 1] === '"') { field += '"'; i++; }
            else { quoted = false; closed = true; }
        } else if (char === "," || char === "\n" || char === "\r") {
            row.push(field.trim());
            field = ""; closed = false;
            if (char !== ",") {
                if (row.some(Boolean)) rows.push(row);
                row = [];
                if (char === "\r" && input[i + 1] === "\n") i++;
            }
        } else if (char === '"' && !field && !closed) quoted = true;
        else {
            if (closed || char === '"') throw new Error("CSV 引号格式不合法");
            field += char;
        }
    }
    if (quoted) throw new Error("CSV 引号未闭合");
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
}

function fieldValue(rows: string[][], key: string): string {
    const matches = rows.map((row, index) => row[0] === key ? index : -1).filter(index => index >= 0);
    if (matches.length !== 1) throw new Error(`CSV 缺少或重复字段 ${key}`);
    const index = matches[0]!;
    const parts = [rows[index]!.slice(1).join(",")];
    for (let i = index + 1; rows[i]?.[0] === ""; i++) parts.push(rows[i]!.slice(1).join(","));
    const value = parts.join("\n").trim();
    if (!value) throw new Error(`CSV 字段 ${key} 为空`);
    return value;
}

function positive(value: string | undefined, name: string): number {
    if (!value || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
        throw new Error(`${name} 必须是有限正数`);
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} 必须是有限正数`);
    return number;
}

interface BenchmarkRun {
    rate: number;
    seconds: number;
    selected: boolean;
    iteration: number;
}

function baseRuns(rows: string[][], vcpus: number): Map<string, BenchmarkRun[]> {
    const start = rows.findIndex(row => row[0] === "Full Results Table");
    const end = rows.findIndex(row => row[0] === "Selected Results Table");
    if (start < 0 || end <= start + 1) throw new Error("缺少完整或选中结果表");
    const header = rows[start + 1]!;
    const columns = ["Benchmark", "Base # Copies", "Base Run Time", "Base Rate", "Base Selected", "Base Status", "Description"];
    const indices = columns.map(name => {
        const index = header.indexOf(name);
        if (index < 0 || header.lastIndexOf(name) !== index) throw new Error(`缺少或重复列 ${name}`);
        return index;
    });
    const runs = new Map<string, BenchmarkRun[]>();
    for (const row of rows.slice(start + 2, end)) {
        const [name, copies, seconds, rate, selected, status, description] = indices.map(index => row[index]);
        if (!name || !BENCHMARKS.includes(name)) throw new Error("完整结果表包含非 intrate 基准");
        if (positive(copies, "copies") !== vcpus) throw new Error("copies 必须等于显式指定的 vCPU 数");
        if (status !== "S") throw new Error(`${name} 的 Base Status 不是成功 S`);
        if (selected !== "0" && selected !== "1") throw new Error("Base Selected 必须是 0 或 1");
        const match = /^refrate\(ref\) iteration #(\d+)$/.exec(description ?? "");
        if (!match) throw new Error("只接收 refrate(ref) 正式输入规模，拒绝 test/train");
        const group = runs.get(name) ?? [];
        group.push({ rate: positive(rate, "Base Rate"), seconds: positive(seconds, "Base Run Time"),
            selected: selected === "1", iteration: Number(match[1]) });
        runs.set(name, group);
    }
    return runs;
}

function selectedRates(runs: Map<string, BenchmarkRun[]>): number[] {
    const rates: number[] = [];
    let iterations: number | undefined;
    for (const name of BENCHMARKS) {
        const group = runs.get(name);
        if (!group || (group.length !== 2 && group.length !== 3)) {
            throw new Error(`基准 ${name} 必须完整运行 2 或 3 次`);
        }
        iterations ??= group.length;
        if (group.length !== iterations || new Set(group.map(run => run.iteration)).size !== iterations
            || group.some(run => run.iteration < 1 || run.iteration > iterations!)) {
            throw new Error("基准迭代次数不一致或重复");
        }
        const selected = group.filter(run => run.selected);
        const sorted = group.map(run => run.seconds).sort((a, b) => a - b);
        // 3 次取中位数，2 次取较慢者；不把内层迭代当成独立评测。
        if (selected.length !== 1 || selected[0]!.seconds !== sorted[1]) {
            throw new Error(`${name} 未按中位数/较慢值选择结果`);
        }
        rates.push(selected[0]!.rate);
    }
    return rates;
}

function checkSelectedTable(rows: string[][], runs: Map<string, BenchmarkRun[]>, vcpus: number): void {
    const start = rows.findIndex(row => row[0] === "Selected Results Table");
    const header = rows[start + 1]!;
    const indices = ["Benchmark", "Base # Copies", "Base Run Time", "Base Rate", "Base Selected", "Base Status"]
        .map(name => header.indexOf(name));
    if (indices.some(index => index < 0)) throw new Error("选中结果表缺少必要列");
    const seen = new Set<string>();
    let index = start + 2;
    while (rows[index]?.[0] && /^\d{3}\./.test(rows[index]![0]!)) {
        const row = rows[index++]!;
        const [name, copies, seconds, rate, selected, status] = indices.map(column => row[column]);
        const expected = runs.get(name ?? "")?.find(run => run.selected);
        if (!name || seen.has(name) || !expected || Number(copies) !== vcpus || status !== "S"
            || selected !== "1" || Number(seconds) !== expected.seconds || Number(rate) !== expected.rate) {
            throw new Error("选中结果表与完整结果表不一致或包含重复基准");
        }
        seen.add(name);
    }
    if (seen.size !== BENCHMARKS.length) throw new Error("选中结果表必须包含全部 10 个基准");
}

/** 记录报告中披露的 base 编译/运行选项；不声称等于完整配置文件的哈希。 */
function baseSettingsHash(rows: string[][]): string {
    const settings: string[][] = [];
    let inSection = false;
    for (const row of rows) {
        if (row.length === 1 && !BENCHMARKS.includes(row[0]!)) {
            inSection = /^Base (?:Runtime Environment|Compiler Invocation|.*Flags)$/.test(row[0]!);
        }
        if (inSection) settings.push(row);
    }
    if (!settings.length) throw new Error("缺少 base 编译配置披露");
    return hash(JSON.stringify(settings));
}

function readResult(path: string, vcpus: number) {
    const realPath = realpathSync(path);
    const text = readFileSync(realPath, "utf8");
    const rows = parseCsv(text);
    if (fieldValue(rows, "valid") !== "1") {
        throw new Error("CSV 标记为无效结果；请检查报告 Errors/Unknown Flags，修正 flagsurl 后可用 rawformat 重导出");
    }
    if (!rows.some(row => row[0] === "SPEC CPU2017 Integer Rate Result")) {
        throw new Error("只接收 SPEC CPU2017 Integer Rate Result");
    }
    // 总分在多个列重复出现；只读取官方汇总行的第一数值，不混入 peak 或 energy。
    const metrics = rows.filter(row => row[0] === SPEC_METRIC);
    if (metrics.length !== 1) throw new Error(`缺少或重复 ${SPEC_METRIC}`);
    const score = positive(metrics[0]![1], SPEC_METRIC);
    const runs = baseRuns(rows, vcpus);
    const rates = selectedRates(runs);
    checkSelectedTable(rows, runs, vcpus);
    const computed = Math.exp(rates.reduce((sum, rate) => sum + Math.log(rate), 0) / rates.length);
    if (Math.abs(score - computed) > Math.max(0.000002, score * 0.00001)) {
        throw new Error("base 总分与各基准选中结果的几何平均不一致");
    }
    return {
        path: realPath, sha256: hash(text), score, baseSettingsSha256: baseSettingsHash(rows),
        suiteVersion: fieldValue(rows, "Tested with SPEC CPU2017").replace(/^v/, "").replace(/\.$/, ""),
        cpu: fieldValue(rows, "CPU Name"), os: fieldValue(rows, "OS"), compiler: fieldValue(rows, "Compiler"),
        runNumber: fieldValue(rows, "Run number:"), runAt: fieldValue(rows, "Result run on"),
    };
}

export function checkSpecResults(paths: string[], vcpus: number, repeats: number) {
    if (paths.length !== repeats) throw new Error(`必须提供 ${repeats} 份独立完整 CSV，实际 ${paths.length} 份`);
    const runs = paths.map(path => {
        try { return readResult(path, vcpus); }
        catch (error) {
            // 仅透出结构诊断，不在错误中回显 CSV 原文或配置内容。
            throw new Error(`${path}: ${error instanceof Error ? error.message : "读取失败"}`);
        }
    });
    const first = runs[0]!;
    for (const key of ["suiteVersion", "cpu", "os", "compiler"] as const) {
        if (runs.some(run => run[key] !== first[key])) throw new Error(`本批 ${key} 不一致，不能混合统计`);
    }
    if (runs.some(run => run.baseSettingsSha256 !== first.baseSettingsSha256)) {
        throw new Error("本批 base 编译/运行配置不一致，不能混合统计");
    }
    if (new Set(runs.map(run => run.sha256)).size !== repeats
        || new Set(runs.map(run => `${run.runNumber}\0${run.runAt}`)).size !== repeats) {
        throw new Error("不能将同一结果文件或同一轮的重导出重复计为独立评测");
    }
    const mean = runs.reduce((sum, run) => sum + run.score / repeats, 0);
    const sampleStddev = Math.sqrt(runs.reduce((sum, run) => sum + (run.score - mean) ** 2, 0) / (repeats - 1));
    const cvPercent = sampleStddev / mean * 100;
    const scorePerVcpu = mean / vcpus;
    if (![mean, sampleStddev, cvPercent, scorePerVcpu].every(Number.isFinite) || scorePerVcpu <= 0) {
        throw new Error("统计量超出可表示的数值范围，拒绝输出失真分数");
    }
    return { metric: SPEC_METRIC, suiteVersion: first.suiteVersion, vcpus, repeats, mean, sampleStddev,
        cvPercent, scorePerVcpu, runs };
}
