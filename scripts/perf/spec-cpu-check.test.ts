import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), "spec-check-"));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cli = join(import.meta.dir, "spec-cpu-check.ts");

async function run(...args: string[]) {
    const proc = Bun.spawn([process.execPath, cli, ...args], {
        stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { stdout, stderr, code };
}

// 人工构造的公开 CSV 格式样例，不包含 SPEC 源码、输入数据或真实成绩。
const benchmarks = ["500.perlbench_r", "502.gcc_r", "505.mcf_r", "520.omnetpp_r", "523.xalancbmk_r",
    "525.x264_r", "531.deepsjeng_r", "541.leela_r", "548.exchange2_r", "557.xz_r"];
function csv(score: number, copies: number, runId: string) {
    const header = 'Benchmark,"Base # Copies","Base Run Time","Base Rate","Base Selected","Base Status",Description';
    const row = (name: string, selected: number, description: string) =>
        `${name},${copies},100,${score},${selected},S,"${description}"`;
    return ["valid,1", '"SPEC CPU2017 Integer Rate Result"', '"Full Results Table"', header,
        ...benchmarks.flatMap(name => [row(name, 0, "refrate(ref) iteration #1"), row(name, 1, "refrate(ref) iteration #2")]),
        '"Selected Results Table"', header,
        ...benchmarks.map(name => row(name, 1, "SelectedIteration (base #2; peak NR)")),
        `SPECrate2017_int_base,${score}`,
        '"CPU Name","测试 CPU"', 'OS,"测试 OS"', 'Compiler,"测试编译器, C/C++"', ',"第二行"',
        '"Base Optimization Flags"', '500.perlbench_r,"-O2"',
        '"Peak Optimization Flags"', '500.perlbench_r',
        '"Tested with SPEC CPU2017",v1.1.9.', `"Run number:",${runId}`, `"Result run on","测试时刻 ${runId}"`, "",
    ].join("\n");
}
function results(dir: string, scores: number[], copies: number) {
    return scores.map((score, i) => {
        const path = join(dir, `run${i}.csv`);
        writeFileSync(path, csv(score, copies, String(i)));
        return path;
    });
}
function flags(name: string, paths: string[]) { return paths.flatMap(path => [name, path]); }

describe("SPEC CPU 检查 CLI", () => {
    test("校验真实格式结果并统计独立轮次的均值和样本标准差", async () => {
        const dir = tempDir();
        const paths = results(dir, [6, 8], 4);
        const out = join(dir, "report.json");
        const result = await run(...flags("--result", paths), "--vcpus", "4", "--repeats", "2", "--out", out);
        expect(result.code).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.measured.mean).toBe(7);
        expect(report.measured.sampleStddev).toBeCloseTo(1.41421356237);
        expect(report.measured.scorePerVcpu).toBe(1.75);
        expect(report.measured.runs[0].compiler).toBe("测试编译器, C/C++\n第二行");
        expect(report.measured.runs[0].sha256).toHaveLength(64);
        expect(report.equivalence).toBeNull();
        expect(report.appliedToCu).toBe(false);
        expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(report);
    });
    test("对照参考机器换算吞吐等效 vCPU，不把整机倍率当成每核倍率", async () => {
        const measured = results(tempDir(), [12, 12], 4);
        const reference = results(tempDir(), [4, 4], 2);
        const result = await run(...flags("--result", measured), "--vcpus", "4", "--repeats", "2",
            ...flags("--reference", reference), "--reference-vcpus", "2");
        expect(result.code).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.equivalence.throughputEquivalentVcpus).toBe(6);
        expect(report.equivalence.perVcpuThroughputRatio).toBe(1.5);
        expect(report.reference.mean).toBe(4);
        expect(report.warnings.join("\n")).toContain("不是单线程速度");
    });
    test("统计量或参考换算溢出时拒绝输出 null 分数", async () => {
        const paths = results(tempDir(), [1e200, 2e200], 4);
        const overflow = await run(...flags("--result", paths), "--vcpus", "4", "--repeats", "2");
        expect(overflow.code).toBe(1);
        expect(overflow.stdout).toBe("");
        expect(overflow.stderr).toContain("数值范围");
        const measured = results(tempDir(), [1e200, 1e200], 4);
        const reference = results(tempDir(), [1e-200, 1e-200], 4);
        const ratio = await run(...flags("--result", measured), "--vcpus", "4", "--repeats", "2",
            ...flags("--reference", reference), "--reference-vcpus", "4");
        expect(ratio.code).toBe(1);
        expect(ratio.stdout).toBe("");
        expect(ratio.stderr).toContain("数值范围");
    });
    test("同批编译选项不同不能只因为编译器名称相同而合并", async () => {
        const paths = results(tempDir(), [6, 8], 4);
        writeFileSync(paths[1]!, readFileSync(paths[1]!, "utf8").replace("-O2", "-O3"));
        const result = await run(...flags("--result", paths), "--vcpus", "4", "--repeats", "2");
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("配置");
    });
    test.each([
        ["无效标记", (s: string) => s.replace("valid,1", "valid,0"), "无效"],
        ["错误套件", (s: string) => s.replace("Integer Rate Result", "Floating Point Rate Result"), "Integer Rate"],
        ["缺失基准", (s: string) => s.split("\n").filter(line => !line.startsWith("557.xz_r,")).join("\n"), "557.xz_r"],
        ["错误 copies", (s: string) => s.replace("500.perlbench_r,4,", "500.perlbench_r,2,"), "copies"],
        ["执行失败", (s: string) => s.replace(",0,S,", ",0,RE,"), "Base Status"],
        ["测试规模", (s: string) => s.replace("refrate(ref)", "test(test)"), "test/train"],
        ["总分不符", (s: string) => s.replace("SPECrate2017_int_base,6", "SPECrate2017_int_base,99"), "几何平均"],
        ["非法数值", (s: string) => s.replace("SPECrate2017_int_base,6", "SPECrate2017_int_base,Infinity"), "有限正数"],
        ["缺少汇总", (s: string) => s.replace("SPECrate2017_int_base", "SPECrate2017_int_peak"), "SPECrate2017_int_base"],
        ["引号未闭合", (s: string) => `${s}\"`, "引号"],
        ["重复选中", (s: string) => s.replace(",0,S,", ",1,S,"), "选择结果"],
        ["同批版本混用", (s: string) => s.replace("v1.1.9.", "v1.1.8."), "suiteVersion"],
    ] as const)("拒绝 %s，不生成成功产物", async (_name, mutate, diagnostic) => {
        const dir = tempDir();
        const paths = results(dir, [6, 8], 4);
        writeFileSync(paths[0]!, mutate(readFileSync(paths[0]!, "utf8")));
        const out = join(dir, "invalid.json");
        const result = await run(...flags("--result", paths), "--vcpus", "4", "--repeats", "2", "--out", out);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(diagnostic);
        expect(result.stdout).toBe("");
        expect(existsSync(out)).toBe(false);
    });
    test("支持每轮三次迭代取中位数，并默认汇总十轮", async () => {
        const paths = results(tempDir(), Array(10).fill(6), 4);
        for (const path of paths) {
            let text = readFileSync(path, "utf8");
            for (const name of benchmarks) {
                text = text.replace(`${name},4,100,6,0,S`, `${name},4,90,6.666667,0,S`)
                    .replace(`${name},4,100,6,1,S,"refrate(ref) iteration #2"`,
                        `${name},4,100,6,1,S,"refrate(ref) iteration #2"\n${name},4,110,5.454545,0,S,"refrate(ref) iteration #3"`);
            }
            writeFileSync(path, text);
        }
        const result = await run(...flags("--result", paths), "--vcpus", "4");
        expect(result.code).toBe(0);
        const measured = JSON.parse(result.stdout).measured;
        expect(measured.repeats).toBe(10);
        expect(measured.mean).toBeCloseTo(6);
        expect(measured.sampleStddev).toBeCloseTo(0);
    });
    test("选中结果表与完整结果表互相矛盾时拒绝", async () => {
        const paths = results(tempDir(), [6, 8], 4);
        const text = readFileSync(paths[0]!, "utf8");
        const marker = text.indexOf('"Selected Results Table"');
        writeFileSync(paths[0]!, text.slice(0, marker) + text.slice(marker).replace("500.perlbench_r,4,100,6", "500.perlbench_r,4,100,9"));
        const result = await run(...flags("--result", paths), "--vcpus", "4", "--repeats", "2");
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("选中结果表");
    });
    test("默认要求十轮且拒绝相同结果的重复文件", async () => {
        const paths = results(tempDir(), [6, 8], 4);
        const missing = await run(...flags("--result", paths), "--vcpus", "4");
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("10 份");
        writeFileSync(paths[1]!, readFileSync(paths[0]!, "utf8"));
        const duplicate = await run(...flags("--result", paths), "--vcpus", "4", "--repeats", "2");
        expect(duplicate.code).toBe(1);
        expect(duplicate.stderr).toContain("重复");
    });
    test("保留已有输出；参考参数和版本必须完整一致", async () => {
        const dir = tempDir();
        const paths = results(dir, [6, 8], 4);
        const base = [...flags("--result", paths), "--vcpus", "4", "--repeats", "2"];
        const out = join(dir, "report.json");
        writeFileSync(out, "保留原文件");
        expect((await run(...base, "--out", out)).code).toBe(1);
        expect(readFileSync(out, "utf8")).toBe("保留原文件");
        expect((await run(...base, "--reference-vcpus", "4")).code).toBe(1);
        const refs = results(tempDir(), [6, 8], 4);
        for (const path of refs) writeFileSync(path, readFileSync(path, "utf8").replace("v1.1.9.", "v1.1.8."));
        const mismatch = await run(...base, ...flags("--reference", refs), "--reference-vcpus", "4");
        expect(mismatch.code).toBe(1);
        expect(mismatch.stderr).toContain("版本必须一致");
    });
    test("CSV 接受 BOM、CRLF、引号内换行和双引号转义", async () => {
        const paths = results(tempDir(), [6, 8], 4);
        for (const path of paths) {
            writeFileSync(path, "\uFEFF" + readFileSync(path, "utf8").replace('"测试 CPU"', '"测试 ""CPU""\n第二行"').replaceAll("\n", "\r\n"));
        }
        const result = await run(...flags("--result", paths), "--vcpus", "4", "--repeats", "2");
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).measured.runs[0].cpu).toBe('测试 "CPU"\r\n第二行');
    });
    test.each([[], ["--vcpus", "0"], ["--vcpus", "1.5"], ["--vcpus", "4", "--repeats", "1"],
        ["--plan", "--vcpus", "4"], ["--plan", "--vcpus", "4", "--result", "unused.csv"]])(
        "错误参数失败且不输出分数：%j", async (...args: string[]) => {
            const result = await run(...args);
            expect(result.code).toBe(1);
            expect(result.stdout).toBe("");
        },
    );
    test("plan 生成十轮独立的 base/ref 命令，安全引用路径且不执行", async () => {
        const root = tempDir();
        const spec = join(root, "SPEC ' suite");
        const config = join(spec, "config", "local.cfg");
        mkdirSync(join(spec, "config"), { recursive: true });
        writeFileSync(config, "# 仅供生成命令的测试配置\n");
        const result = await run("--plan", "--spec-root", spec, "--config", config, "--vcpus", "4");
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(". ./shrc");
        expect(result.stdout).toContain("--copies=4");
        expect(result.stdout).toContain("--tune=base");
        expect(result.stdout).toContain("--size=ref");
        expect(result.stdout).toContain("--iterations=3");
        expect(result.stdout).toContain("--loose");
        expect(result.stdout.match(/ intrate/g)).toHaveLength(10);
        expect(result.stdout).toContain("'\\''");
        expect(result.stdout).toContain("--config='local.cfg'");
        expect(readdirSync(spec)).toEqual(["config"]);
    });
    test("帮助说明授权前提、两个模式与不修改 CU 的边界", async () => {
        const result = await run("--help");
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("SPEC CPU 2017");
        expect(result.stdout).toContain("授权");
        expect(result.stdout).toContain("--plan");
        expect(result.stdout).toContain("--result");
        expect(result.stdout).toContain("不修改 CU");
    });
});
