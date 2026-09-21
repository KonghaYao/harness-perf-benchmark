#!/usr/bin/env bun
/**
 * ZCode 包内 headless CLI 压测：不启动 Electron，不读用户登录态。
 * 实测桌面版 3.14.1 / CLI 0.16.9；安装包内 glm/zcode.cjs 由 Node 运行。
 * 默认从 /Applications/ZCode.app 定位；CI 用 ZCODE_RESOURCES 指向解包后的 Resources。
 * HOME 与 ZCODE_DATA_BASE_DIR 同时隔离；provider 使用新版本的独立配置文件。
 * Bash + {command}；100 轮实测 101 请求、100 个成功工具结果，不需要额外补条。
 * 每 10 轮会追加 TodoWrite 提醒，所以 last=tool 仅 90 条，不能据此少算工具轮。
 * 剧本仅允许只读命令；测量的是包内 Node CLI，不包含 Electron 桌面的开销。
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, loadPerfConfig } from "../../scripts/perf/config";
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from "../../scripts/perf/run";

const argv = process.argv.slice(2);
const SANDBOX = join(import.meta.dir, ".home");
const PROVIDER = "llm-mock";
const MODEL = "llm-mock";

export function providerConfig(port: number) {
    return {
        schemaVersion: 1,
        config: {
            providerOrder: [PROVIDER],
            providerConfigRules: {
                providerRules: [{
                    providerId: PROVIDER,
                    providerName: "llm-mock",
                    enabled: true,
                    config: {
                        group: "standard-personal",
                        access: { type: "api-key", apiKey: "mock-key" },
                        api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
                        personalModelIds: [MODEL],
                    },
                }],
            },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
            defaultModelSelection: { providerId: PROVIDER, modelId: MODEL },
        },
    };
}

if (import.meta.main) {
    if (argv.includes("-h") || argv.includes("--help")) {
        console.log(USAGE);
        console.log("ZCode：Node 运行官方安装包内的 glm/zcode.cjs --prompt <prompt> --cwd <work-dir>。");
        console.log("ZCODE_RESOURCES 指定安装包 Resources；--peri 可显式指定 Node 二进制。");
        console.log("默认剧本 data/scenarios/long-run-zcode.json，默认 --exhausted stop。");
        process.exit(EXIT_OK);
    }
    try {
        const config = loadPerfConfig(argv, REPO_ROOT, {
            scriptPath: "data/scenarios/long-run-zcode.json",
        });
        if (!argv.some((arg) => arg === "--work-dir" || arg.startsWith("--work-dir="))) {
            config.workDir = import.meta.dir;
        }
        if (!argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
            config.harnessId = "zcode";
        }
        if (!argv.some((arg) => arg === "--exhausted" || arg.startsWith("--exhausted="))) {
            config.exhausted = "stop";
        }
        const resources = resolve(process.env.ZCODE_RESOURCES ?? "/Applications/ZCode.app/Contents/Resources");
        const entry = join(resources, "glm", "zcode.cjs");
        const builtin = join(resources, "config", "provider", "zcode-builtin.json");
        for (const path of [entry, builtin]) {
            if (!existsSync(path)) throw new Error(`缺少 ZCode 程序文件: ${path}；请设置 ZCODE_RESOURCES`);
        }
        const explicitBin = argv.some((arg) => arg === "--peri" || arg.startsWith("--peri="));
        const node = explicitBin ? config.periPath : Bun.which("node");
        if (node === null) throw new Error("PATH 里找不到 node，ZCode 的包内 CLI 需要 Node 运行时");
        mkdirSync(SANDBOX, { recursive: true });
        const personal = join(SANDBOX, "provider-config.json");
        // 运行期 provider 刷新只能写沙盒副本，不允许修改已安装的应用文件。
        const sandboxBuiltin = join(SANDBOX, "zcode-builtin.json");
        copyFileSync(builtin, sandboxBuiltin);
        writeFileSync(personal, `${JSON.stringify(providerConfig(config.port), null, 2)}\n`);
        process.exitCode = await runPerf(config, {
            harnessEnv: () => ({
                HOME: SANDBOX,
                ZDOTDIR: SANDBOX,
                SHELL: "/bin/bash",
                ZCODE_DATA_BASE_DIR: SANDBOX,
                ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: sandboxBuiltin,
                ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
                ZCODE_MODEL_TELEMETRY_ENABLED: "false",
                NO_PROXY: "127.0.0.1,localhost,::1",
                no_proxy: "127.0.0.1,localhost,::1",
            }),
            harnessCommand: (cfg) => [
                node, entry, "--prompt", cfg.prompt, "--cwd", cfg.workDir,
                "--mode", "yolo", "--no-color", ...cfg.periArgs,
            ],
        });
    } catch (error) {
        console.error(`[perf] 启动失败: ${(error as Error).message}`);
        process.exitCode = EXIT_SETUP;
    }
}
