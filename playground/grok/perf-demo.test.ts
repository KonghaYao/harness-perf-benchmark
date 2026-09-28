import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayName } from "../../scripts/perf/harness-id";
import { harnessCommand, sandboxConfig } from "./perf-demo";

const entry = `${import.meta.dir}/perf-demo.ts`;

describe("Grok Build 压测入口", () => {
    it("provider 指向 mock，端口变化只影响本地端点", () => {
        const first = sandboxConfig(3457);
        const second = sandboxConfig(4567);
        expect(first).toContain('base_url = "http://127.0.0.1:3457/v1"');
        expect(second).toContain('base_url = "http://127.0.0.1:4567/v1"');
        expect(first.replaceAll("3457", "4567")).toBe(second);
        expect(second).toContain('api_backend = "chat_completions"');
        expect(second).toContain('api_key = "mock-key"');
        expect(second).toContain('default = "llm-mock"');
        expect(second).toContain("[model.llm-mock]");
        expect(second).toContain("context_window = 1000000");
        expect(second).toContain("title_refresh = false");
        expect(second).toContain("max_retries = 0");
        expect(displayName("grok")).toBe("Grok Build");
    });

    it("无头命令只放开 shell，并点名 mock 模型", () => {
        const command = harnessCommand("/usr/bin/grok", {
            prompt: "压测：请持续用只读命令检查当前目录状态",
            periArgs: [],
        });
        expect(command.slice(0, 4)).toEqual([
            "/usr/bin/grok",
            "-p",
            "压测：请持续用只读命令检查当前目录状态",
            "-m",
        ]);
        expect(command).toContain("llm-mock");
        expect(command).toContain("--yolo");
        expect(command).toContain("run_terminal_cmd");
        expect(command).toContain("--disable-web-search");
        expect(command).toContain("--no-subagents");
    });

    it.each([[], ["--help"]])("导入配置函数不执行 CLI 或修改进程退出码：%j", async (...args: string[]) => {
        const result = Bun.spawn([process.execPath, "-e", `
            process.argv = [process.execPath, "import-check", ...${JSON.stringify(args)}];
            await import(${JSON.stringify(entry)});
            console.log("导入完成");
        `], {
            env: { ...process.env, PATH: "/nonexistent-grok-bin" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [output, errors, code] = await Promise.all([
            new Response(result.stdout).text(),
            new Response(result.stderr).text(),
            result.exited,
        ]);
        expect(code).toBe(0);
        expect(output).toBe("导入完成\n");
        expect(errors).toBe("");
    });

    it("查看帮助不需要本机安装 grok", async () => {
        const result = Bun.spawn([process.execPath, entry, "--help"], {
            env: { ...process.env, PATH: "/nonexistent-grok-bin" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const output = await new Response(result.stdout).text();
        expect(await result.exited).toBe(0);
        expect(output).toContain("long-run-grok.json");
        expect(output).toContain("GROK_HOME");
    });

    it("PATH 里没有 grok 时明确失败，不静默换被测对象", async () => {
        const result = Bun.spawn([process.execPath, entry], {
            env: { ...process.env, PATH: "/nonexistent-grok-bin" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const errors = await new Response(result.stderr).text();
        expect(await result.exited).toBe(1);
        expect(errors).toContain("PATH 里找不到 grok");
        expect(errors).toContain("https://x.ai/cli/install.sh");
    });

    it("--version 形状不对时明确失败", async () => {
        const fakeBin = mkdtempSync(join(tmpdir(), "grok-fake-bin-"));
        const fakeGrok = join(fakeBin, "grok");
        writeFileSync(fakeGrok, "#!/bin/sh\necho 'not-grok'\n");
        chmodSync(fakeGrok, 0o755);
        const run = Bun.spawn([process.execPath, entry], {
            env: { ...process.env, PATH: fakeBin },
            stdout: "pipe",
            stderr: "pipe",
        });
        const errors = await new Response(run.stderr).text();
        expect(await run.exited).toBe(1);
        expect(errors).toContain("--version");
    });
});
