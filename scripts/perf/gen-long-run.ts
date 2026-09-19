#!/usr/bin/env bun
/**
 * 生成「长剧本」压测剧本 —— 一个有限长、能跑到自然结束的多轮任务：
 * N 轮「中等正文 + 一次工具调用」，配 `--exhausted stop` 使用：剧本走完后 mock 返回
 * 一条「任务结束」纯文本，harness 自行收尾退出，于是能测到**端到端时长**（跑完整个
 * 剧本要多久）与整段的资源消耗。
 *
 * 每轮把历史随 messages 回传，上下文逐轮累积（第 N 轮的请求体里躺着前 N-1 轮的正文），
 * 时长与内存曲线都由此产生。
 *
 *   bun run scripts/perf/gen-long-run.ts                            # 50 轮 × 约 4KB
 *   bun run scripts/perf/gen-long-run.ts --turns 100 --body-kb 8
 *   bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
 *
 * 工具形状用 `--tool`（工具名）+ `--args`（参数形状）指定，六家各一份的生成命令见 USAGE。
 *
 * 剧本**不带**收尾条：收尾是 mock 的 stop 策略负责的（这样各 harness 多发的那几个
 * 辅助请求——peri 的「预测下一步输入」、dsh 的「会话标题生成」——也会拿到收尾响应，
 * 不会被卡住）。输出默认写到 data/scenarios/long-run.json（data/ 已 gitignore）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "./config";
import { largeMarkdown } from "./markdown";

const USAGE = `生成长剧本（多轮工具调用，跑到自然结束）

用法:
  bun run scripts/perf/gen-long-run.ts [选项]

选项:
  --turns <n>           轮数：每轮 = 一段正文 + 一次工具调用（默认 50）
  --body-kb <n>         每轮正文目标大小，单位 KB（默认 4；0 = 只留一行标题）
  --chunk-size <n>      流式 chunk 字符数（默认 64）
  --chunk-delay-ms <n>  chunk 间隔毫秒（默认 0）
  --delay-ms <n>        首包前延迟毫秒（默认 0）
  --tool <name>         工具名（默认 Bash；--args exec 时固定为 exec，本项被忽略）
  --args <shape>        工具参数形状（默认 command）:
                          command              {command}                peri / opencode / Claude Code
                          command+description  {command, description}   pi / dsh
                          exec                 裸 JavaScript 源码        codex（custom 工具）
  --out <path>          输出路径（默认 data/scenarios/long-run.json，相对仓库根）
  -h, --help            显示本帮助

六家的生成命令（统一 100 轮主循环；正文大小用 --body-kb 调，默认 4KB）:
  bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json
    # peri / opencode / Claude Code：工具名 Bash，参数 {command}，三家共用这一份
  bun run scripts/perf/gen-long-run.ts --turns 100 --args exec \\
    --out data/scenarios/long-run-codex.json
  bun run scripts/perf/gen-long-run.ts --turns 130 --tool bash \\
    --out data/scenarios/long-run-pi.json
    # pi 要 130 条：它从约 140 条消息起自动压缩，压缩期每轮追加一条 messages=2 的总结请求，
    # 同样取号——100 条下主循环只能跑到 84 轮（实测）
  bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --args command+description \\
    --out data/scenarios/long-run-dsh.json

  各家自己的辅助请求都会消费条目（opencode / dsh 的标题生成、pi 的压缩摘要），
  所以「脚本轮数」≥「主循环实际轮数」是常态；脚本不够用时看 mock.log 里是谁在取号。

配套运行（各 playground 的 perf-demo.ts 默认剧本已指向自家那份；timeout 只作兜底，
正常应看到 harness 自行退出。--script 的相对路径按**进程 cwd** 解析，别照抄仓库根的写法）:
  cd playground/peri  && bun perf-demo.ts --script ../../data/scenarios/long-run.json \\
    --exhausted stop --timeout-ms 1800000 --turns 100
  cd playground/pi    && bun perf-demo.ts --script ../../data/scenarios/long-run-pi.json \\
    --exhausted stop --timeout-ms 1800000
  cd playground/codex && bun perf-demo.ts --script ../../data/scenarios/long-run-codex.json \\
    --exhausted stop --timeout-ms 1800000
`;

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        turns: { type: "string" },
        "body-kb": { type: "string" },
        "chunk-size": { type: "string" },
        "chunk-delay-ms": { type: "string" },
        "delay-ms": { type: "string" },
        tool: { type: "string" },
        args: { type: "string" },
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

const turns = positiveInt(values.turns, "--turns", 50);
if (turns < 1) throw new Error("--turns 至少为 1：剧本没有轮次就无从跑起");
const bodyKb = positiveInt(values["body-kb"], "--body-kb", 4);
const chunkSize = positiveInt(values["chunk-size"], "--chunk-size", 64);
const chunkDelayMs = positiveInt(values["chunk-delay-ms"], "--chunk-delay-ms", 0);
const delayMs = positiveInt(values["delay-ms"], "--delay-ms", 0);

/**
 * 各 harness 的工具形状（重测六家时逐个核过，原先记在各自的 scenario 文件 note 里，
 * 文件删掉后固化在这里）：
 *   peri 3.17 / opencode 1.17 / Claude Code 2.1   Bash                   {command}
 *   codex 0.155                                   exec                    裸 JS 源码（custom 工具）
 *   pi 0.85.1                                     bash                    {command}
 *   dsh 0.1.5-rc.2                                bash                    {command, description}
 * dsh 的 description 是**必填**：缺了会被工具自己拒掉
 * （tool result: invalid arguments: missing required property "description"），
 * 所以生成器必须能把这一项补上，不能只写 command。
 */
type ArgShape = "command" | "command+description" | "exec";

function argShapeOf(raw: string | undefined, tool: string): ArgShape {
    // `--tool exec` 是 codex 那条老用法，保持兼容：没给 --args 时按 exec 形状走。
    if (raw === undefined || raw === "") return tool === "exec" ? "exec" : "command";
    if (raw === "command" || raw === "command+description" || raw === "exec") return raw;
    throw new Error(`--args 必须是 command | command+description | exec，收到 ${JSON.stringify(raw)}`);
}

const argShape = argShapeOf(values.args, values.tool ?? "Bash");
// exec 是 codex 的 custom 工具名，形状定了名字就没有第二个选择。
const toolName = argShape === "exec" ? "exec" : (values.tool ?? "Bash");
const outPath = resolve(REPO_ROOT, values.out ?? "data/scenarios/long-run.json");

/**
 * command+description 形状里那句 description：harness 只拿它当展示文案，内容不参与测量，
 * 用固定串是为了让两份剧本除了轮号以外逐字可比（每次生成都换文案的话，diff 里全是噪声）。
 */
const TOOL_DESCRIPTION = "长剧本压测：只读检查当前目录（llm-mock perf）";

/**
 * 轮转的只读轻量命令：四条一循环，带上轮号便于在 harness.log / mock.log 里数到第几轮
 * （命令本身不做任何写操作，沙盒里不会留副作用）。
 */
function commandFor(round: number): string {
    const probe = `long-run-tick-${round}`;
    switch ((round - 1) % 4) {
        case 1:
            return `echo ${probe}`;
        case 2:
            return "pwd";
        case 3:
            return "ls -la";
        default:
            return "ls";
    }
}

/**
 * 一条工具调用，按 `--args` 选形状：
 * - `command`：arguments 是 `{command}` 的 JSON 对象（peri / opencode / Claude Code / pi）；
 * - `command+description`：再多一项必填的 description（dsh）；
 * - `exec`：按 codex 的 custom 工具写，参数是**裸 JavaScript 源码**（不是 JSON，也不是被引号
 *   包起来的字符串），见 src/responses.ts 头注释里 exec 的声明形状。
 */
function toolCall(round: number): {
    id: string;
    type: "function";
    function: { name: string; arguments: unknown };
} {
    const callId = `call_long_run_${round}`;
    const command = commandFor(round);
    if (argShape === "exec") {
        return {
            id: callId,
            type: "function",
            function: {
                name: "exec",
                arguments: `const r = await tools.exec_command({ cmd: ${JSON.stringify(command)} });\ntext(r.output);`,
            },
        };
    }
    // 字段顺序与各家实测请求一致：command 在前、description 在后，便于肉眼比对抓包。
    const args: Record<string, string> = { command };
    if (argShape === "command+description") args.description = TOOL_DESCRIPTION;
    return {
        id: callId,
        type: "function",
        function: { name: toolName, arguments: args },
    };
}

const targetBytes = bodyKb * 1024;
const responses = Array.from({ length: turns }, (_, i) => {
    const round = i + 1;
    return {
        message: {
            role: "assistant",
            content: largeMarkdown(
                `## 第 ${round} 轮工作记录`,
                targetBytes,
                round * 1000,
            ),
            tool_calls: [toolCall(round)],
        },
        finish_reason: "tool_calls",
    };
});

const script = {
    note:
        `由 scripts/perf/gen-long-run.ts 生成：${turns} 轮，每轮约 ${bodyKb}KB 正文 + 一个 ` +
        `${toolName} 工具调用（参数形状 ${argShape}）；配 --exhausted stop 使用——剧本走完后 mock 返回` +
        "「任务结束」纯文本，harness 自行收尾退出，从而测到端到端时长与整段资源消耗。" +
        "注：每轮把历史随 messages 回传，第 N 轮的请求体里含前 N-1 轮正文，上下文逐轮累积。",
    defaults: { delayMs, chunkDelayMs, chunkSize },
    responses,
};

mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(script, null, 2);
writeFileSync(outPath, json + "\n");

const bodyBytes = responses.reduce(
    (total, entry) => total + Buffer.byteLength(entry.message.content, "utf8"),
    0,
);
console.log(`[gen-long-run] 已写入 ${outPath}`);
console.log(
    `[gen-long-run] ${turns} 轮 × 约 ${bodyKb}KB 正文（正文合计 ${(bodyBytes / 1024).toFixed(0)}KB，` +
        `文件 ${(Buffer.byteLength(json, "utf8") / 1024).toFixed(0)}KB）；工具 ${toolName}（${argShape}）；` +
        `节奏 chunkSize=${chunkSize} chunkDelayMs=${chunkDelayMs} delayMs=${delayMs}`,
);
console.log(
    `[gen-long-run] 上下文累积估算：最后一轮请求体 ≈ ${((bodyBytes * (turns - 1)) / turns / 1024).toFixed(0)}KB` +
        "（前 N-1 轮正文）+ 工具结果",
);
console.log(
    "[gen-long-run] 跑法：cd playground/peri && bun perf-demo.ts --script " +
        outPath.replace(`${REPO_ROOT}/`, "") +
        " --exhausted stop --timeout-ms 1200000",
);
