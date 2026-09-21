import { describe, expect, it } from "bun:test";
import { displayName } from "../../scripts/perf/harness-id";
import { providerConfig } from "./perf-demo";

const entry = `${import.meta.dir}/perf-demo.ts`;

describe("ZCode 压测入口", () => {
    it("显式选择 mock provider，端口变化只影响本地端点", () => {
        const first = providerConfig(3457);
        const second = providerConfig(4567);
        const rule = second.config.providerConfigRules.providerRules[0]!;
        expect(first.schemaVersion).toBe(1);
        expect(rule.config.api).toEqual({
            type: "openai-chat-completions",
            baseUrl: "http://127.0.0.1:4567/v1",
        });
        expect(rule.config.access).toEqual({ type: "api-key", apiKey: "mock-key" });
        expect(rule.config.personalModelIds).toEqual(["llm-mock"]);
        expect(second.config.defaultModelSelection).toEqual({
            providerId: rule.providerId,
            modelId: "llm-mock",
        });
        expect(second.config.modelConfigRules).toEqual({
            providerModelRules: [], manualProviderModelRules: [],
        });
        expect(first.config.providerConfigRules.providerRules[0]!.config.api.baseUrl)
            .toBe("http://127.0.0.1:3457/v1");
        expect(displayName("zcode")).toBe("ZCode");
    });

    it("查看帮助不需要本机安装 ZCode", async () => {
        const result = Bun.spawn([process.execPath, entry, "--help"], {
            env: { ...process.env, ZCODE_RESOURCES: "/nonexistent/llm-mock-zcode" },
            stdout: "pipe", stderr: "pipe",
        });
        const output = await new Response(result.stdout).text();
        expect(await result.exited).toBe(0);
        expect(output).toContain("ZCODE_RESOURCES");
        expect(output).toContain("long-run-zcode.json");
    });

    it("缺少程序包时明确失败，不退回用户默认模型", async () => {
        const result = Bun.spawn([process.execPath, entry], {
            env: { ...process.env, ZCODE_RESOURCES: "/nonexistent/llm-mock-zcode" },
            stdout: "pipe", stderr: "pipe",
        });
        const errors = await new Response(result.stderr).text();
        expect(await result.exited).toBe(1);
        expect(errors).toContain("缺少 ZCode 程序文件");
    });
});
