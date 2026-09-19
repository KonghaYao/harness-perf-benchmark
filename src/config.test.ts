import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "./config";

describe("loadConfig", () => {
    it("必须显式指定脚本文件", () => {
        expect(() => loadConfig([], {})).toThrow(/必须指定脚本文件/);
        expect(() => loadConfig([], { SCRIPT_PATH: "" })).toThrow(/必须指定脚本文件/);
        // 只给了别的参数、没给脚本，同样拒绝启动
        expect(() => loadConfig(["--port", "4000"], {})).toThrow(/必须指定脚本文件/);
    });

    it("--script 优先于 SCRIPT_PATH，并解析为绝对路径", () => {
        expect(loadConfig(["--script", "a.json"], { SCRIPT_PATH: "b.json" }).scriptPath).toBe(
            resolve(process.cwd(), "a.json"),
        );
        expect(loadConfig([], { SCRIPT_PATH: "b.json" }).scriptPath).toBe(
            resolve(process.cwd(), "b.json"),
        );
    });

    it("解析端口、耗尽策略与节奏项", () => {
        const config = loadConfig(
            [
                "--script",
                "s.json",
                "--port",
                "4000",
                "--exhausted",
                "loop",
                "--delay-ms",
                "50",
                "--chunk-size",
                "3",
            ],
            {},
        );
        expect(config).toMatchObject({
            port: 4000,
            exhausted: "loop",
            delayMs: 50,
            chunkSize: 3,
            model: "llm-mock",
        });
        // 未显式配置的节奏项留空，交由脚本 defaults 决定
        expect(config.chunkDelayMs).toBeUndefined();
    });

    it("环境变量作为默认来源，命令行优先", () => {
        const fromEnv = loadConfig(["--script", "s.json"], {
            PORT: "5555",
            MOCK_EXHAUSTED: "hold",
            MOCK_MODEL: "gpt-mock",
            MOCK_CHUNK_DELAY_MS: "7",
        });
        expect(fromEnv).toMatchObject({
            port: 5555,
            exhausted: "hold",
            model: "gpt-mock",
            chunkDelayMs: 7,
        });

        const fromArgs = loadConfig(
            ["--script", "s.json", "--port", "6666", "--exhausted", "error"],
            { PORT: "5555", MOCK_EXHAUSTED: "hold" },
        );
        expect(fromArgs).toMatchObject({ port: 6666, exhausted: "error" });
    });

    it("非法取值给出可定位的错误", () => {
        expect(() => loadConfig(["--script", "s.json", "--port", "0"], {})).toThrow(/port/);
        expect(() => loadConfig(["--script", "s.json", "--port", "abc"], {})).toThrow(/port/);
        expect(() => loadConfig(["--script", "s.json", "--exhausted", "nope"], {})).toThrow(
            /exhausted/,
        );
        expect(() => loadConfig(["--script", "s.json", "--chunk-size", "0"], {})).toThrow(
            /chunk-size/,
        );
        expect(() => loadConfig(["--script", "s.json", "--delay-ms", "-1"], {})).toThrow(
            /delay-ms/,
        );
    });

    it("拒绝未知参数", () => {
        expect(() => loadConfig(["--script", "s.json", "--nope"], {})).toThrow();
    });
});
