/**
 * 运行配置：命令行参数优先于环境变量，环境变量优先于内置默认值。
 *
 *   bun run src/server.ts --script ./script.json --port 3457
 *
 * 环境变量：SCRIPT_PATH / PORT / MOCK_EXHAUSTED / MOCK_MODEL
 *           MOCK_DELAY_MS / MOCK_CHUNK_DELAY_MS / MOCK_CHUNK_SIZE
 *
 * 脚本文件必须显式指定（--script 或 SCRIPT_PATH）：mock 的行为完全由脚本决定，
 * 不提供隐式默认路径，避免加载了非预期的剧本。节奏项未显式配置时留空，
 * 交由脚本 defaults 决定（脚本的节奏更贴近其内容）。
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

/** 脚本耗尽后的行为：报错 / 重复最后一条 / 从头循环 / 返回收尾响应。 */
export type ExhaustedPolicy = "error" | "hold" | "loop" | "stop";

export interface MockConfig {
    port: number;
    scriptPath: string;
    exhausted: ExhaustedPolicy;
    /** 响应中回显与补全用的默认模型名。 */
    model: string;
    delayMs?: number;
    chunkDelayMs?: number;
    chunkSize?: number;
}

const DEFAULT_PORT = 3457;

function optionalNum(value: string | undefined, label: string): number | undefined {
    if (value === undefined || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${label} 必须是非负数字，收到: ${JSON.stringify(value)}`);
    }
    return parsed;
}

function port(value: string | undefined): number {
    if (value === undefined || value === "") return DEFAULT_PORT;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`port 必须是 1..65535 的整数，收到: ${JSON.stringify(value)}`);
    }
    return parsed;
}

function policy(value: string | undefined): ExhaustedPolicy {
    if (value === undefined || value === "") return "error";
    if (value === "error" || value === "hold" || value === "loop" || value === "stop") {
        return value;
    }
    throw new Error(
        `exhausted 必须是 error | hold | loop | stop，收到: ${JSON.stringify(value)}`,
    );
}

/** 脚本路径必填：相对路径按启动时的工作目录解析。 */
function scriptPath(value: string | undefined): string {
    if (value === undefined || value === "") {
        throw new Error("必须指定脚本文件：--script <path>（或环境变量 SCRIPT_PATH）");
    }
    return resolve(process.cwd(), value);
}

export function loadConfig(
    argv: string[] = process.argv.slice(2),
    env: Record<string, string | undefined> = process.env,
): MockConfig {
    const { values } = parseArgs({
        args: argv,
        options: {
            port: { type: "string" },
            script: { type: "string" },
            exhausted: { type: "string" },
            model: { type: "string" },
            "delay-ms": { type: "string" },
            "chunk-delay-ms": { type: "string" },
            "chunk-size": { type: "string" },
        },
        allowPositionals: false,
        strict: true,
    });

    const script = values.script ?? env.SCRIPT_PATH;
    const chunkSize = optionalNum(
        values["chunk-size"] ?? env.MOCK_CHUNK_SIZE,
        "chunk-size",
    );
    if (chunkSize !== undefined && chunkSize < 1) {
        throw new Error("chunk-size 必须 >= 1");
    }

    return {
        port: port(values.port ?? env.PORT),
        scriptPath: scriptPath(script),
        exhausted: policy(values.exhausted ?? env.MOCK_EXHAUSTED),
        model: values.model ?? env.MOCK_MODEL ?? "llm-mock",
        delayMs: optionalNum(values["delay-ms"] ?? env.MOCK_DELAY_MS, "delay-ms"),
        chunkDelayMs: optionalNum(
            values["chunk-delay-ms"] ?? env.MOCK_CHUNK_DELAY_MS,
            "chunk-delay-ms",
        ),
        chunkSize: chunkSize === undefined ? undefined : Math.floor(chunkSize),
    };
}
