/**
 * 真 7-Zip 对拍：**默认跳过**（它要 spawn 真实基准，一轮几十秒），需要时显式开：
 *
 *   CALIBRATE_REAL=1 bun test scripts/perf/calibrate.real.test.ts
 *
 * 它验的是解析器的核心假设——**真实输出就是 `parseBenchmarkOutput` 认得的那种形状**
 * （banner 版本、`25:` 一行、`|` 两侧各四列）。单元测试里的样例是按真机输出手抄的，
 * 这一条则直接拿本机的 7zz 跑一轮，任何「7-Zip 换了输出格式」都会在这里现形。
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
    SEVEN_ZIP_FALLBACK_PATH,
    SEVEN_ZIP_VERSION,
    benchmarkArgs,
    parseBenchmarkOutput,
    runSevenZipBenchmark,
} from "./calibrate";

const enabled = process.env.CALIBRATE_REAL === "1";
const binary =
    Bun.which("7zz") ?? (existsSync(SEVEN_ZIP_FALLBACK_PATH) ? SEVEN_ZIP_FALLBACK_PATH : null);

describe.skipIf(!enabled || binary === null)("真 7-Zip：一轮基准 → 解析", () => {
    it(
        "`b 1 -mmt1 -md25` 的真实输出能解析出 25: 那一行的八列",
        async () => {
            const exec = await runSevenZipBenchmark(binary as string, benchmarkArgs(1), {
                timeoutS: 900,
            });
            const parsed = parseBenchmarkOutput(exec.merged);
            expect(parsed.version).toBe(SEVEN_ZIP_VERSION);
            for (const metrics of [parsed.compress, parsed.decompress]) {
                expect(metrics.speed).toBeGreaterThan(0);
                expect(metrics.usage).toBeGreaterThan(0);
                expect(metrics.usage).toBeLessThanOrEqual(200);
                expect(metrics.ru).toBeGreaterThan(0);
                expect(metrics.rating).toBeGreaterThan(0);
            }
            // 解压那一行必须真的来自解压（与压缩不是同一组数）
            expect(parsed.decompress.speed).not.toBe(parsed.compress.speed);
            expect(parsed.machine.rating).toBe((parsed.compress.rating + parsed.decompress.rating) / 2);
        },
        900_000,
    );
});
