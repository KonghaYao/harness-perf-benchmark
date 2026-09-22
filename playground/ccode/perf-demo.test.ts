import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { PerfConfig } from "../../scripts/perf/config";
import { displayName, harnessIdOfBinary } from "../../scripts/perf/harness-id";
import { MODEL, SESSION_DIR, harnessCommand, resolveBinary, sandboxEnv } from "./perf-demo";

const entry = `${import.meta.dir}/perf-demo.ts`;

/** 造一个假 PATH，里面只放给出的 bin 名（都是能跑的空壳，只为让 Bun.which 找得到）。 */
function fakeBinDir(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "ccode-fake-bin-"));
    for (const name of names) {
        const file = join(dir, name);
        writeFileSync(file, "#!/bin/sh\nexit 0\n");
        chmodSync(file, 0o755);
    }
    return dir;
}

describe("ccode 压测入口", () => {
    it("provider 指向 mock：端口只进 CCODE_API_BASE，会话目录在沙盒里", () => {
        const first = sandboxEnv(3457);
        const second = sandboxEnv(4567);
        expect(first.CCODE_API_BASE).toBe("http://127.0.0.1:3457/v1");
        expect(second.CCODE_API_BASE).toBe("http://127.0.0.1:4567/v1");
        // 其余字段与端口无关。
        expect(second.CCODE_API_BASE.replace("4567", "3457")).toBe(first.CCODE_API_BASE);
        expect(first.CCODE_API_KEY).toBe("mock-key");
        expect(first.CCODE_MODEL).toBe(MODEL);
        // 会话目录必须落在 playground/ccode 沙盒里，不能是用户的 ~/.ccode。
        expect(first.CCODE_SESSION_DIR).toBe(SESSION_DIR);
        expect(SESSION_DIR.startsWith(import.meta.dir + sep)).toBe(true);
    });

    it("身份：ccode-cli 这个 bin 名归到 ccode 这个 harness id", () => {
        expect(harnessIdOfBinary("ccode-cli")).toBe("ccode");
        expect(harnessIdOfBinary("/usr/local/bin/ccode-cli")).toBe("ccode");
        expect(displayName("ccode")).toBe("ccode");
    });

    it("二进制解析：PATH 里同时有 ccode-cli 和 ccode 时先认 ccode-cli", () => {
        const both = fakeBinDir(["ccode-cli", "ccode"]);
        expect(resolveBinary([], both)).toBe(join(both, "ccode-cli"));
        // 只有单体 ccode 时退到它（能跑，但读数口径与默认构建的 ccode-cli 不同）。
        const onlyCombined = fakeBinDir(["ccode"]);
        expect(resolveBinary([], onlyCombined)).toBe(join(onlyCombined, "ccode"));
        // 都没有 → null，让调用方明确报错（不猜本地构建产物）。
        expect(resolveBinary([], fakeBinDir([]))).toBeNull();
        // 显式 --peri 时不做 PATH 查找。
        expect(resolveBinary(["--peri", "/opt/ccode-cli"], both)).toBeNull();
    });

    it("--max-turns 永远显式传：没给 --turns 时传 0（不限），绝不落回 ccode 自己的 50", () => {
        const cfg = { turns: 100, prompt: "压测", periArgs: [] } as unknown as PerfConfig;
        expect(harnessCommand("/opt/ccode-cli", cfg, true)).toEqual([
            "/opt/ccode-cli", "--write", "--auto-approve", "--max-turns", "100", "-p", "压测",
        ]);
        // 上游 CI 调 demo 时不带 --turns：这时必须是 0（不限），否则 100 轮剧本只跑 50 轮。
        expect(harnessCommand("/opt/ccode-cli", cfg, false)).toEqual([
            "/opt/ccode-cli", "--write", "--auto-approve", "--max-turns", "0", "-p", "压测",
        ]);
    });

    it("查看帮助不需要本机安装 ccode", async () => {
        const result = Bun.spawn([process.execPath, entry, "--help"], {
            env: { ...process.env, PATH: "/nonexistent-ccode-bin" },
            stdout: "pipe", stderr: "pipe",
        });
        const output = await new Response(result.stdout).text();
        expect(await result.exited).toBe(0);
        expect(output).toContain("long-run-ccode.json");
        expect(output).toContain("CCODE_SESSION_DIR");
    });

    it("PATH 里没有 ccode 时明确失败，不静默换被测对象", async () => {
        const result = Bun.spawn([process.execPath, entry], {
            env: { ...process.env, PATH: "/nonexistent-ccode-bin" },
            stdout: "pipe", stderr: "pipe",
        });
        const errors = await new Response(result.stderr).text();
        expect(await result.exited).toBe(1);
        expect(errors).toContain("PATH 里找不到 ccode-cli");
        expect(errors).toContain("make ccode-cli");
    });
});
