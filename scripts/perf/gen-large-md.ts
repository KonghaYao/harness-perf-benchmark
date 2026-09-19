#!/usr/bin/env bun
/**
 * 生成「超大 markdown 输出」压测剧本 —— 覆盖短响应剧本压不到的路径：
 * 大流量 SSE 解析、markdown 渲染（标题/列表/代码块/表格/中英混排）、
 * 以及上下文随轮次累积（每轮把历史大文本随 messages 回传）。
 *
 *   bun run scripts/perf/gen-large-md.ts                    # 默认：4 条 × 64KB
 *   bun run scripts/perf/gen-large-md.ts --size-kb 256 --responses 2
 *
 * 每条响应 = 大 markdown 正文 + 一个工具调用（让 harness 持续多轮、不回 stop），
 * 配 `--exhausted loop` 使用。默认节奏 chunkSize=64 / chunkDelayMs=0：mock 尽快吐完，
 * 测到的 CPU 主要来自 harness 的流解析与渲染，而不是 mock 的等待。
 *
 * 工具名用 `--tool` 指定：默认 `Bash`（peri / opencode / Claude Code 都认），
 * codex 没有这个工具、要用它自己的 `exec`（custom 形状，参数是裸 JS 源码不是 JSON），
 * 所以 codex 跑大输出剧本时生成一份 `--tool exec --out …/large-md-codex.json`。
 *
 * 输出默认写到 data/scenarios/large-md.json（data/ 已 gitignore，生成物不占仓库）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "./config";

const USAGE = `生成超大 markdown 输出的压测剧本

用法:
  bun run scripts/perf/gen-large-md.ts [选项]

选项:
  --size-kb <n>        每条响应的 markdown 目标大小（默认 64）
  --responses <n>      剧本条数（默认 4）
  --chunk-size <n>     流式 chunk 字符数（默认 64）
  --chunk-delay-ms <n> chunk 间隔毫秒（默认 0）
  --delay-ms <n>       首包前延迟毫秒（默认 0）
  --tool <name>        工具调用的工具名（默认 Bash；exec 按 codex 的 custom 工具写成裸 JS）
  --out <path>         输出路径（默认 data/scenarios/large-md.json，相对仓库根）
  -h, --help           显示本帮助
`;

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        "size-kb": { type: "string" },
        responses: { type: "string" },
        "chunk-size": { type: "string" },
        "chunk-delay-ms": { type: "string" },
        "delay-ms": { type: "string" },
        tool: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
});

if (values.help === true) {
    console.log(USAGE);
    process.exit(0);
}

function positiveInt(raw: string | undefined, label: string, fallback: number): number {
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${label} 必须是非负整数，收到 ${JSON.stringify(raw)}`);
    }
    return parsed;
}

const sizeKb = positiveInt(values["size-kb"], "--size-kb", 64);
const responseCount = positiveInt(values.responses, "--responses", 4);
const chunkSize = positiveInt(values["chunk-size"], "--chunk-size", 64);
const chunkDelayMs = positiveInt(values["chunk-delay-ms"], "--chunk-delay-ms", 0);
const delayMs = positiveInt(values["delay-ms"], "--delay-ms", 0);
const toolName = values.tool ?? "Bash";
const outPath = resolve(REPO_ROOT, values.out ?? "data/scenarios/large-md.json");

/** 一段有代表性的 markdown：标题 / 中英混排段落 / 列表 / 代码块 / 表格 / 引用 / 强调。 */
function block(index: number): string {
    return [
        `## 片段 ${index} — Perf Block`,
        "",
        `这一段用于压测渲染与流式解析：中文与 English words 混排，内含 \`inline code\`、`,
        `数字 ${index * 1234567}、以及全角标点（，。！）与 emoji 🚀 之类的高位字符。`,
        "重复的段落文本用来把单条响应撑到目标体积，模拟真实长报告的输出形态。",
        "",
        "- 列表项 A：覆盖无序列表的行内样式与缩进计算；",
        "- 列表项 B：覆盖 `code`、**粗体**、*斜体* 混排；",
        "- 列表项 C：覆盖较长的一行文本，用来触发折行与宽度计算，让渲染路径有稳定负载。",
        "",
        "1. 有序项一：编号渲染；",
        "2. 有序项二：与无序列表交替出现；",
        "",
        "> 引用块：把一段说明放进 blockquote，检查前缀符号与折行缩进的处理。",
        "",
        "```ts",
        `// 片段 ${index}：代码块要高亮、要折行，也要参与流式解析`,
        `export function tick${index}(i: number): number {`,
        "    return i * 2;",
        "}",
        "```",
        "",
        "| 指标 | 数值 | 说明 |",
        "| --- | ---: | --- |",
        `| tick | ${index} | 采样序号 |`,
        `| cpu | ${(index * 7) % 100}% | 单核口径 |`,
        `| rss | ${(index * 13) % 512}MB | 常驻内存 |`,
        "",
        "[链接](https://example.com/perf) 与 **粗体**、*斜体*、~~删除线~~ 收尾。",
        "",
    ].join("\n");
}

function largeMarkdown(index: number, targetBytes: number): string {
    const parts: string[] = [`# 压测用超大 markdown（第 ${index} 条）`, ""];
    let bytes = Buffer.byteLength(parts[0] ?? "", "utf8");
    let n = 0;
    while (bytes < targetBytes) {
        n += 1;
        const piece = block(index * 1000 + n);
        parts.push(piece);
        bytes += Buffer.byteLength(piece, "utf8");
    }
    return parts.join("\n");
}

/**
 * 一条工具调用。默认 Bash 形状（arguments 是 JSON 对象）；
 * `--tool exec` 时按 codex 的 custom 工具写：参数是**裸 JavaScript 源码**（不是 JSON，
 * 也不是被引号包起来的字符串），见 src/responses.ts 头注释里 exec 的声明形状。
 */
function toolCall(index: number): {
    id: string;
    type: "function";
    function: { name: string; arguments: unknown };
} {
    const callId = `call_large_md_${index}`;
    if (toolName === "exec") {
        return {
            id: callId,
            type: "function",
            function: {
                name: "exec",
                arguments: `const r = await tools.exec_command({ cmd: "echo large-md-tick-${index}" });\ntext(r.output);`,
            },
        };
    }
    return {
        id: callId,
        type: "function",
        function: { name: toolName, arguments: { command: `echo large-md-tick-${index}` } },
    };
}

const targetBytes = sizeKb * 1024;
const responses = Array.from({ length: responseCount }, (_, i) => {
    const index = i + 1;
    return {
        message: {
            role: "assistant",
            content: largeMarkdown(index, targetBytes),
            tool_calls: [toolCall(index)],
        },
        finish_reason: "tool_calls",
    };
});

const script = {
    note:
        `由 scripts/perf/gen-large-md.ts 生成：每条响应约 ${sizeKb}KB markdown + 一个 ${toolName} 工具调用；` +
        "配 --exhausted loop 持续供压。目标是压 markdown 渲染与大流量 SSE 解析，以及上下文随轮次的累积。",
    defaults: { delayMs, chunkDelayMs, chunkSize },
    responses,
};

mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(script, null, 2);
writeFileSync(outPath, json + "\n");

const actual = responses.map((r) => Buffer.byteLength(r.message.content, "utf8"));
console.log(`[gen-large-md] 已写入 ${outPath}`);
console.log(
    `[gen-large-md] ${responseCount} 条 × 约 ${sizeKb}KB（实际 ${actual.map((b) => `${(b / 1024).toFixed(0)}KB`).join(" / ")}），` +
        `文件 ${(Buffer.byteLength(json, "utf8") / 1024).toFixed(0)}KB；` +
        `工具 ${toolName}；` +
        `节奏 chunkSize=${chunkSize} chunkDelayMs=${chunkDelayMs} delayMs=${delayMs}`,
);
