#!/usr/bin/env bun
/**
 * 生成「长剧本」压测剧本 —— 一个有限长、能跑到自然结束的多轮任务：
 * N 轮「中等正文 + 一次工具调用」，配 `--exhausted stop` 使用：主流程吃到尾部的
 * 「任务结束」纯文本即自行收尾退出，于是能测到**端到端时长**（跑完整个剧本要多久）
 * 与整段的资源消耗。
 *
 * 每轮把历史随 messages 回传，上下文逐轮累积（第 N 轮的请求体里躺着前 N-1 轮的正文），
 * 时长与内存曲线都由此产生。
 *
 *   bun run scripts/perf/gen-long-run.ts                            # 50 轮 × 约 4KB
 *   bun run scripts/perf/gen-long-run.ts --turns 100 --body-kb 8
 *   bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
 *
 * 工具形状用 `--tool`（工具名）+ `--args`（参数形状）指定，各家各一份的生成命令见 USAGE。
 *
 * 剧本尾部固定带**两条**收尾条（正文轮数之外）：
 *   1. 与 mock 的 stop 策略同文的「任务结束」纯文本——主流程吃到它才收敛（文本取自
 *      src/script.ts 的 STOP_MESSAGE，两边不会各自漂移）；
 *   2. 一条空白响应——给 peri 的「预测下一步输入」留的。
 * 第 2 条是把 peri 的 5.0s 收尾等待消掉的关键：预测请求在**主流程结束之后**才发，若它
 * 也吃到非空文本，预测分支会回落成 Placeholder 动作、一路走到写 session 标题，与 host
 * 关闭流程互锁到 cooperative_grace 超时（实测固定多 5.0s，机制见 docs/perf-compare.md）；
 * 拿到空白（trim 后为空）则在拿锁之前就返回空动作。顺序不可反：主流程得先吃到文本收尾。
 * 其余各家的辅助请求大多在途中取号（dsh 的会话标题生成、pi 的压缩摘要）；收尾之后还会再发
 * 一条的也有——pi 实测末条 `messages=2` 的总结请求就落在空白上，对它同样无害。
 * 输出默认写到 data/scenarios/long-run.json（data/ 已 gitignore）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { STOP_MESSAGE } from "../../src/script";
import { REPO_ROOT } from "./config";
import { largeMarkdown } from "./markdown";

const USAGE = `生成长剧本（多轮工具调用，跑到自然结束）

用法:
  bun run scripts/perf/gen-long-run.ts [选项]

选项:
  --turns <n>           轮数：每轮 = 一段正文 + 一次工具调用（默认 50；实际条目数 = 轮数 + 2 条收尾）
  --body-kb <n>         每轮正文目标大小，单位 KB（默认 4；0 = 只留一行标题）
  --chunk-size <n>      流式 chunk 字符数（默认 64）
  --chunk-delay-ms <n>  chunk 间隔毫秒（默认 0）
  --delay-ms <n>        首包前延迟毫秒（默认 0）
  --tool <name>         工具名（默认 Bash；--args exec / commandline 时各有各的默认，见下）
  --args <shape>        工具参数形状（默认 command）:
                          command              {command}                peri / opencode / Claude Code / MiniMax Code / opencode2 / hermes
                          command+description  {command, description}   pi / dsh
                          exec                 裸 JavaScript 源码        codex（custom 工具）
                          commandline          {CommandLine, Cwd, …}    agy（Antigravity CLI）
  --cwd <path>          commandline 形状里 Cwd 的值（默认 playground/antigravity，相对仓库根）
  --out <path>          输出路径（默认 data/scenarios/long-run.json，相对仓库根）
  -h, --help            显示本帮助

各家的生成命令（统一 100 轮主循环；正文大小用 --body-kb 调，默认 4KB）:
  bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json
    # peri / opencode / Claude Code：工具名 Bash，参数 {command}，三家共用这一份
  bun run scripts/perf/gen-long-run.ts --turns 100 --args exec \\
    --out data/scenarios/long-run-codex.json
  bun run scripts/perf/gen-long-run.ts --turns 133 --tool bash \\
    --out data/scenarios/long-run-pi.json
    # pi 要 133 轮（落成剧本 135 条 = 133 + 2 条收尾）：它从约 140 条消息起自动压缩，压缩期每轮
    # 追加一条 messages=2 的总结请求，同样取号。实测 135 个请求 = 1 条初始 + 100 轮工具调用 +
    # 34 条压缩总结；131 轮只有 99 个工具轮、128 轮只有 98 个（轮数要往上加，不是往下减）。
  bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --args command+description \\
    --out data/scenarios/long-run-dsh.json
  bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash \\
    --out data/scenarios/long-run-minimax-code.json
    # MiniMax Code CLI（mcode）的 shell 工具也叫 bash + {command}；消费最干净：
    # 100 轮剧本实收 101 条（100 轮 + 尾部那条收尾），没有标题生成也没有压缩请求
  bun run scripts/perf/gen-long-run.ts --turns 104 --args commandline \\
    --out data/scenarios/long-run-antigravity.json
    # Antigravity CLI（agy）的工具名是 run_command、参数五项全必填（--args commandline）。
    # 要 104 条才跑满 100 轮，两处原因（都实测）：
    #   1. 序列第一条是**会话标题生成**请求（gemini-3.1-flash-lite-preview，同一个端点），
    #      它在**最前面**——与 peri 的预测（在最后）正好相反；
    #   2. 上下文压缩：每约 32 个请求插一条「续写摘要」请求
    #      （last=user:"Your main task now is to generate a continuation summary of …"），
    #      同样取号。104 轮实测 3 次压缩，正好 100 个工具轮；103 轮只有 99 个。
  bun run scripts/perf/gen-long-run.ts --turns 101 --tool shell \\
    --out data/scenarios/long-run-opencode2.json
    # opencode v2（npm 包 @opencode/cli，bin 名 opencode2）：shell 工具改名叫 **shell**
    # （v1 的 bash 没了）、参数只要 {command}。它开局先发一条会话标题生成请求
    # （messages=2、无 tools，system 写着 "You are a title generator"），比主流程还早，
    # 同样吃条目，所以 +1：101 轮实测 102 条请求 = 标题 1 + 工具轮 100 + 收尾 1。
  bun run scripts/perf/gen-long-run.ts --turns 102 --tool terminal \\
    --out data/scenarios/long-run-hermes.json
    # Hermes Agent（Nous Research）：shell 工具叫 **terminal**、参数 {command}（与其余各家同形）。
    # 它有两笔自己的开销，都要算进条数，所以 +2：
    #   1. **会话标题生成**（stream=false、messages=2、无 tools，system 是 "You name chat
    #      sessions."）与主请求几乎同时发出、谁先不定（5 次实测 3 次标题在前、2 次主请求在前），
    #      合计吃掉开头那一条；
    #   2. 途中一次**上下文压缩**：上下文涨到约 170 条消息时插一条 messages=1、
    #      last=user:"You are a summarization agent creating a context checkpoint."，
    #      随后历史被压到 21 条、紧接着一条把原任务重述的主请求——**前后两条都取号**。
    # 102 轮实测 103 条请求 = 主请求 1 + 标题 1 + 压缩摘要 1 + 压缩后重述 1 + 带工具结果的续跑 99
    # = **100 个工具轮**（少一条只有 99 轮）。带工具结果的续跑比轮数少 1，是因为压缩前那一轮的
    # 工具结果被折进了摘要、没有单独回传：想数轮数要看剧本被执行到第几条，别数 last=tool。
    # 主流程收尾之后它**还可能**再发一条技能库复盘（"Review the conversation above and update
    # the skill library."，同一剧本 4 次里发了 1 次），落在尾部那条空白上——与 peri 的预测请求
    # 同一个位置，所以那条空白对 hermes 也有用；发不发都不影响工具轮数。

  各家自己的辅助请求都会消费条目（opencode / dsh / agy / opencode2 / hermes 的标题生成、
  pi · agy · hermes 的压缩摘要），所以「脚本轮数」≥「主循环实际轮数」是常态；脚本不够用时看
  mock.log 里是谁在取号。各家要跑到 100 轮的实际轮数：peri 100 · opencode 100 ·
  Claude Code 100 · codex 100 · dsh 100 · mcode 100 · **pi 133**（压缩从约 140 条消息起
  每轮多吃一条）· **agy 104** · **opencode2 101**（标题请求吃第一条）· **hermes 102**
  （标题与主请求抢开头那一条 + 压缩前后各一条）。
  剧本尾部固定两条收尾（轮数之外）：主流程的「任务结束」文本 + 给 peri 预测请求的空白
  响应（后者消掉 peri 固定 5.0s 的收尾等待，机制见 docs/perf-compare.md）。
  注：agy / opencode2 的标题请求在**主流程之前**（序列第一条），尾部那两条收尾它们只用到
  第一条；hermes 的标题与主请求几乎同时发出（谁先不定），同样只用到第一条；
  peri 的预测与 hermes 的技能库复盘在**主流程之后**，正好落在第二条空白上——多出来的一条
  不会被浪费，留着只在各家共用同一份
  生成器时无害。

配套运行（各 playground 的 perf-demo.ts 默认剧本已指向自家那份；timeout 只作兜底，
正常应看到 harness 自行退出。--script 的相对路径按**进程 cwd** 解析，别照抄仓库根的写法）:
  cd playground/peri  && bun perf-demo.ts --script ../../data/scenarios/long-run.json \\
    --exhausted stop --timeout-ms 1800000 --turns 100
  cd playground/pi    && bun perf-demo.ts --script ../../data/scenarios/long-run-pi.json \\
    --exhausted stop --timeout-ms 1800000
  cd playground/codex && bun perf-demo.ts --script ../../data/scenarios/long-run-codex.json \\
    --exhausted stop --timeout-ms 1800000
  cd playground/minimax-code && bun perf-demo.ts --exhausted stop --timeout-ms 1800000
    # 默认剧本 data/scenarios/long-run-minimax-code.json；沙盒 MINIMAX_DATA_DIR=playground/minimax-code/.minimax
  cd playground/opencode2 && bun perf-demo.ts --exhausted stop --timeout-ms 1800000
    # 默认剧本 data/scenarios/long-run-opencode2.json；沙盒是 XDG_* 指到 .data/.state/.cache/.config，
    # 命令固定带 --standalone（不加会留一个常驻 serve --service，三次读数就冷热不均）
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
        cwd: { type: "string" },
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
 * 各 harness 的工具形状（重测各家时逐个核过，原先记在各自的 scenario 文件 note 里，
 * 文件删掉后固化在这里）：
 *   peri 3.17 / opencode 1.17 / Claude Code 2.1   Bash                   {command}
 *   opencode2 2.0.10                              shell                   {command}
 *   codex 0.155                                   exec                    裸 JS 源码（custom 工具）
 *   pi 0.85.1                                     bash                    {command}
 *   dsh 0.1.5-rc.2                                bash                    {command, description}
 *   agy 1.2.7                                     run_command             {CommandLine, Cwd, …}
 *   hermes 0.21.3                                 terminal                {command}
 * opencode v2 的 shell 工具就叫 `shell`（v1 的 `bash` 没了）：名字换了，形状还是 {command}。
 * 注意 v1（opencode）与 v2（opencode2）是**两个 harness**，各自一份剧本，别把这份形状混过去。
 * dsh 的 description 是**必填**：缺了会被工具自己拒掉
 * （tool result: invalid arguments: missing required property "description"），
 * 所以生成器必须能把这一项补上，不能只写 command。
 * agy 的 run_command 同理——实测缺 Cwd / WaitMsBeforeAsync / toolSummary / toolAction 会被工具
 * 拒掉（tool result: missing properties 'Cwd', 'WaitMsBeforeAsync', 'toolSummary', 'toolAction'），
 * 五项都要给全，形状见 toolCall()。
 */
type ArgShape =
    | "command"
    | "command+description"
    | "exec"
    | "commandline";

const ARG_SHAPES: readonly ArgShape[] = [
    "command",
    "command+description",
    "exec",
    "commandline",
];

function argShapeOf(raw: string | undefined, tool: string): ArgShape {
    // `--tool exec` 是 codex 那条老用法，保持兼容：没给 --args 时按 exec 形状走。
    if (raw === undefined || raw === "") return tool === "exec" ? "exec" : "command";
    if ((ARG_SHAPES as readonly string[]).includes(raw)) return raw as ArgShape;
    throw new Error(`--args 必须是 ${ARG_SHAPES.join(" | ")}，收到 ${JSON.stringify(raw)}`);
}

const argShape = argShapeOf(values.args, values.tool ?? "Bash");
// exec / run_command 是 codex、agy 各自的工具名，形状定了名字就没有第二个选择。
const toolName =
    argShape === "exec"
        ? "exec"
        : argShape === "commandline"
          ? (values.tool ?? "run_command")
          : (values.tool ?? "Bash");
const outPath = resolve(REPO_ROOT, values.out ?? "data/scenarios/long-run.json");

/**
 * commandline 形状（agy 的 run_command）里的工作目录：工具要求 Cwd 落在 workspace 内，
 * 所以默认写死到 agy 的沙盒目录（playground/antigravity），可用 --cwd 改。
 * 只在生成时定格——剧本是现生成的（data/ 不入库），换人换机器各生成一份即可。
 */
const toolCwd = resolve(REPO_ROOT, values.cwd ?? "playground/antigravity");

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
 *   包起来的字符串），见 src/responses.ts 头注释里 exec 的声明形状；
 * - `commandline`：按 agy 的 run_command 写（五项全必填，见 ArgShape 注释）。参数名是
 *   大驼峰（`CommandLine`），与其余各家的 snake_case 不同，别顺手改小写。
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
    if (argShape === "commandline") {
        return {
            id: callId,
            type: "function",
            function: {
                name: toolName,
                arguments: {
                    CommandLine: command,
                    Cwd: toolCwd,
                    WaitMsBeforeAsync: 10000,
                    toolSummary: TOOL_DESCRIPTION,
                    // toolAction 是给 harness 自己展示「这一步在干什么」的，与 CommandLine 同源最自然。
                    toolAction: command,
                },
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
/** N 轮正文 + 工具调用（正文合计与上下文估算都只数这部分）。 */
const roundEntries = Array.from({ length: turns }, (_, i) => {
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

/**
 * 尾部两条（顺序不可换，理由见文件头）：
 * - 收尾文本：与 mock 的 stop 策略同文，主流程吃到即收敛；
 * - 空白响应：peri 的预测请求拿到它 → execute_prediction 判定空文本、拿锁前返回空动作。
 *   给一个空格而不是空串：实测空格足以让预测分支判空；空串没验过，有的桥接会当异常响应。
 */
const tailEntries = [
    { message: { role: "assistant", content: STOP_MESSAGE }, finish_reason: "stop" },
    { message: { role: "assistant", content: " " }, finish_reason: "stop" },
];

const responses = [...roundEntries, ...tailEntries];

const script = {
    note:
        `由 scripts/perf/gen-long-run.ts 生成：${turns} 轮，每轮约 ${bodyKb}KB 正文 + 一个 ` +
        `${toolName} 工具调用（参数形状 ${argShape}）；尾部另有两条收尾——「任务结束」纯文本` +
        "（主流程吃到即收敛）+ 空白响应（给 peri 的预测请求，消掉它固定 5.0s 的收尾等待）。" +
        "注：每轮把历史随 messages 回传，第 N 轮的请求体里含前 N-1 轮正文，上下文逐轮累积。",
    defaults: { delayMs, chunkDelayMs, chunkSize },
    responses,
};

mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(script, null, 2);
writeFileSync(outPath, json + "\n");

const bodyBytes = roundEntries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.message.content, "utf8"),
    0,
);
console.log(`[gen-long-run] 已写入 ${outPath}`);
console.log(
    `[gen-long-run] ${turns} 轮 × 约 ${bodyKb}KB 正文（正文合计 ${(bodyBytes / 1024).toFixed(0)}KB，` +
        `文件 ${(Buffer.byteLength(json, "utf8") / 1024).toFixed(0)}KB，共 ${responses.length} 条 = ${turns} 轮 + 2 条收尾）；` +
        `工具 ${toolName}（${argShape}）；节奏 chunkSize=${chunkSize} chunkDelayMs=${chunkDelayMs} delayMs=${delayMs}`,
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
