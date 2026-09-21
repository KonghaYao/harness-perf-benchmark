import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayName } from "../../scripts/perf/harness-id";
import { sandboxConfig } from "./perf-demo";

const entry = `${import.meta.dir}/perf-demo.ts`;

describe("Kimi Code 压测入口", () => {
    it("provider 指向 mock，端口变化只影响本地端点", () => {
        const first = sandboxConfig(3457);
        const second = sandboxConfig(4567);
        // 端口只进 base_url 一处；其余字段（类型 / 凭据 / 模型别名 / 窗口）与端口无关。
        expect(first).toContain('base_url = "http://127.0.0.1:3457/v1"');
        expect(second).toContain('base_url = "http://127.0.0.1:4567/v1"');
        expect(first.replace("3457", "4567")).toBe(second);
        // openai 协议 + 假 key（mock 不校验鉴权）+ 模型别名与 default_model 一致。
        expect(second).toContain('type = "openai"');
        expect(second).toContain('api_key = "mock-key"');
        expect(second).toContain('default_model = "llm-mock"');
        expect(second).toContain("[models.\"llm-mock\"]");
        expect(second).toContain("max_context_size = 262144");
        expect(displayName("kimi")).toBe("Kimi Code");
    });

    it("查看帮助不需要本机安装 kimi", async () => {
        const result = Bun.spawn([process.execPath, entry, "--help"], {
            env: { ...process.env, PATH: "/nonexistent-kimi-bin" },
            stdout: "pipe", stderr: "pipe",
        });
        const output = await new Response(result.stdout).text();
        expect(await result.exited).toBe(0);
        expect(output).toContain("long-run-kimi.json");
        expect(output).toContain("KIMI_CODE_HOME");
    });

    it("PATH 里没有 kimi 时明确失败，不静默换被测对象", async () => {
        const result = Bun.spawn([process.execPath, entry], {
            env: { ...process.env, PATH: "/nonexistent-kimi-bin" },
            stdout: "pipe", stderr: "pipe",
        });
        const errors = await new Response(result.stderr).text();
        expect(await result.exited).toBe(1);
        expect(errors).toContain("PATH 里找不到 kimi");
        expect(errors).toContain("install.sh");
    });

    it("--version 形状不对（老 kimi-cli 的 bin）时明确失败", async () => {
        // 老 kimi-cli（另一个产品）也提供 kimi 这个 bin 名：它的 --version 不打裸语义版本号，
        // demo 的启动自查要把这种顶名挡住，别拿错二进制出读数。
        const fakeBin = mkdtempSync(join(tmpdir(), "kimi-fake-bin-"));
        const fakeKimi = join(fakeBin, "kimi");
        writeFileSync(fakeKimi, "#!/bin/sh\necho 'kimi-cli 0.14.2'\n");
        chmodSync(fakeKimi, 0o755);
        const run = Bun.spawn([process.execPath, entry], {
            env: { ...process.env, PATH: fakeBin },
            stdout: "pipe", stderr: "pipe",
        });
        const errors = await new Response(run.stderr).text();
        expect(await run.exited).toBe(1);
        expect(errors).toContain("--version");
    });
});
