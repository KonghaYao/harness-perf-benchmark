# CLAUDE.md

## 项目定位

llm-mock 是**脚本化的模型 API mock**（Bun 运行时，唯一依赖 hono）：把预设的响应序列写成 JSON
脚本，**第 i 次请求返回第 i 条**；`stream: true` 时把同一条完整响应转换成对应协议的 SSE 序列。

同一份脚本可以走三种线协议（各自独立计游标，互不干扰）：

| 端点 | 协议 | 谁在用 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | peri、opencode、pi、grok、脚本自测 |
| `POST /v1/messages` | Anthropic Messages | Claude Code |
| `POST /v1/responses` | OpenAI Responses | Codex |

两个用途：

- **性能压测**：以脚本控制的节奏驱动 harness（peri / opencode / Claude Code / Codex / pi / grok），
  测量 harness 进程自身的 CPU / 内存开销（不采 GPU）；
- **功能测试**：不调用真实模型，复现 agent 的多轮循环、工具调用与流式渲染。

## 压测工作流（已实现）

一条命令跑完「起 mock → 起 harness → 每 100ms 采样 → 出记录」：

```sh
bun run scripts/perf/run.ts --timeout-ms 60000          # 默认剧本 + 默认 peri（PATH 里的）
bun run scripts/perf/run.ts --help                      # 全部选项

cd playground/peri        && bun perf-demo.ts --timeout-ms 60000   # peri 沙盒
cd playground/opencode    && bun perf-demo.ts --timeout-ms 60000   # opencode 沙盒
cd playground/claude-code && bun perf-demo.ts --timeout-ms 60000   # Claude Code 沙盒
cd playground/codex       && bun perf-demo.ts --timeout-ms 60000   # Codex 沙盒
cd playground/pi          && bun perf-demo.ts --timeout-ms 60000   # pi 沙盒
cd playground/grok        && bun perf-demo.ts --timeout-ms 60000   # grok 沙盒
```

六个 `perf-demo.ts` 都是复用同一套实现的薄入口（相对路径按仓库根解析），差别只在 harness 命令、
沙盒与配置注入方式（详见「与 harness 集成」）：

- `playground/peri`：默认注入 `--db-path`（沙盒会话库）与 `--settings`（运行时生成、指向本次端口的 JSON）；
- `playground/opencode`：`XDG_*` 隔离 + `{env:LLM_MOCK_BASE_URL}` 变量替换（换端口不用改配置）；
- `playground/claude-code`：`HOME` + `CLAUDE_CONFIG_DIR` 都指到沙盒（**只改后者挡不住用户级 settings**）；
- `playground/codex`：`CODEX_HOME` 指向沙盒（用户全局配置里有 hooks 与别的 provider）；
- `playground/pi`：`PI_CODING_AGENT_DIR` 指向沙盒，`models.json` 每次启动按本次端口重写
  （pi 的 `baseUrl` 不吃 `$VAR` 插值，换端口只能改文件）；
- `playground/grok`：`GROK_HOME` 指向沙盒，`XAI_API_KEY` 注入假值过登录检查，
  `config.toml` 的 `base_url` 行每次启动按本次端口重写。

需要复核采样口径时跑 `bun run scripts/perf/verify.ts`（对 `yes` / `sleep` 这类已知负载回归，
并打印两个候选后端的开销与分辨率）。

### 场景：超大 markdown 输出

默认剧本的响应只有一两百字节，压不到 markdown 渲染与大流量 SSE 解析；用生成器造大输出剧本：

```sh
bun run scripts/perf/gen-large-md.ts --size-kb 64 --responses 4   # → data/scenarios/large-md.json
cd playground/peri && bun perf-demo.ts --script data/scenarios/large-md.json \
  --exhausted loop --timeout-ms 60000
```

生成器可调 `--size-kb / --responses / --chunk-size / --chunk-delay-ms / --tool`，用不同 chunk 粒度
可对比流解析开销；`--tool exec` 生成 codex 形状的那份（`data/scenarios/large-md-codex.json`）。
各 harness 在两种剧本下的实测对比数据见 `docs/perf-compare.md`。

产物落在 `data/claude-date/`（`--out-dir` 可改，`data/` 已在 .gitignore 里），`<runId>` 形如 `20260919-102954`：

| 文件 | 内容 |
| --- | --- |
| `<runId>-perf.log` | 时间线事件（含注入的环境变量）+ 每秒一行采样摘要 + 末尾总摘要 |
| `<runId>-samples.csv` | 原始采样：`ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs` |
| `<runId>-harness.log` | harness 的 stdout/stderr |
| `<runId>-mock.log` | mock server 的输出（含每次请求的摘要行） |

退出码：`0` 正常 · `1` 配置/mock/环境错误 · `2` harness 非 0 退出 · `3` 超时被强杀 · `130` 被中断；
无论走哪条路径，mock 与 harness 都按**进程组**回收，不留孤儿。

采样口径（选型实验见 `scripts/perf/sampler.ts` 文件头）：

- CPU 取「累计 CPU 时间差分 ÷ 实测间隔」，单位是**单核 100%**，多线程进程可 >100%；
- 默认后端 `proc_pid_rusage`（bun:ffi，实测单次 0.77µs、分辨率 ~1µs，满转读数 99.8%）；
  `--sampler ps` 是兜底（单次 1.3ms、读数分辨率约 60ms，100ms 窗口下误差可达 ±7%）；
- **注意 rusage 返回值在本机是 Mach 时基 tick 而非文档所说的纳秒**，必须用 `mach_timebase_info`
  换算（本机 1 tick ≈ 41.67ns），否则 CPU 会低估 41.7 倍；
- RSS 用 `ri_resident_size`（字节）；`--no-tree` 可关掉后代进程统计（默认含 harness 拉起的 MCP 子进程，
  RSS 会因此偏高，摘要里主进程与进程树分开列）；
- 采样数据先进内存、每 1s 落盘一次，避免每拍同步 I/O 干扰被测对象。

## 目录结构

```
src/server.ts   入口：--help、加载配置与脚本、Bun.serve（默认 :3457）
src/config.ts   运行配置：CLI > 环境变量 > 内置默认
src/app.ts      Hono 路由 + 访问日志；三种协议共用取号/日志/错误处理
src/protocol.ts 协议适配接口（ProtocolAdapter、SSE 帧编码与流包装）
src/anthropic.ts  Anthropic Messages 适配（Claude Code）
src/responses.ts  OpenAI Responses 适配（Codex）
src/script.ts   脚本解析与进程级单游标 ScriptPlayer
src/stream.ts   OpenAI chat 的非流式合成 / SSE 序列、token 估算、grapheme 切分
src/types.ts    OpenAI 协议类型
src/*.test.ts   bun:test：脚本解析、游标、SSE 序列、各协议渲染、路由集成
scripts/perf/run.ts        压测入口：起 mock、起 harness、采样、写记录、出摘要
scripts/perf/config.ts     压测参数解析（parseArgs）；默认 harness 取 PATH 里的 peri
scripts/perf/sampler.ts    采样：rusage/ps 后端、差分换算、进程树、CSV 与摘要
scripts/perf/verify.ts     采样口径验证实验（已知负载 + 开销 + 后端对比）
scripts/perf/gen-large-md.ts  生成「超大 markdown 输出」压测剧本（写入 data/scenarios/）
scripts/perf/*.test.ts     bun:test：差分换算、参数解析、端到端（真 mock + 假 harness）
scripts/perf-scenario.json 压测剧本：全是 Bash 工具调用，配 --exhausted loop 持续供压
scripts/codex-scenario.json  Codex 版压测剧本（exec custom 工具）
scripts/pi-scenario.json    pi 版压测剧本（bash 小写工具）
scripts/grok-scenario.json  grok 版压测剧本（run_terminal_command 工具）
script.json             默认演示脚本（工具调用 + 中文回答）
scripts/peri-demo.json  按 peri 的消费规律编排的演示脚本
playground/<harness>/   各自 harness 的运行沙盒 + perf-demo.ts 入口 + 剧本（按需）
docs/perf-compare.md    各 harness 的压测对比报告
data/claude-date/       压测产物（已 gitignore）
```

## 常用命令

```sh
bun install
bun run src/server.ts --script script.json          # 起 mock（脚本必填，默认端口 3457）
bun run scripts/perf/run.ts                         # 压测（起 mock + peri + 采样 + 记录）
cd playground/claude-code && bun perf-demo.ts       # 换成 Claude Code 压测
bun run scripts/perf/verify.ts                      # 采样口径验证实验
bun test                                            # 全部测试
bun run typecheck                                   # tsc --noEmit（含 scripts/ 与 playground/）
```

## 与 harness 集成

五家都是「让 harness 把 base URL 指向本 mock」，但接入点各不相同：

### peri

- 默认 harness 是 **PATH 里的 `peri`**（`Bun.which("peri")`，实测 3.17.0）；找不到才退回
  `../perihelion/target/debug/peri`；用 `--peri <path>` 指定别的二进制；
- peri 3.17 起**不再读 `{cwd}/.peri/settings.json`**（旧版行为），只认 `~/.peri/settings.json`
  或 `--settings <文件|JSON 字符串>`；demo 因此运行时生成 settings JSON 传给 `--settings`，
  不去动用户的全局配置（`playground/peri/.peri/settings.json` 保留为同结构的手工参考）；
- 默认还注入 `--db-path playground/peri/.peri/perf-threads.db`，隔离会话库（原因见「已知限制与坑」，
  想换库就自己传 `--peri-arg=--db-path --peri-arg=<path>`）；
- peri 每次 prompt 结束还会发一次「预测下一步输入」请求，同样消费一条脚本——编排脚本时必须算进去；
  `scripts/peri-demo.json` 就是按「主回答 → 预测 → …」的规律排的。

### opencode

- 二进制从 PATH 找（`Bun.which("opencode")`，实测 1.17.12）；
- `playground/opencode/opencode.json` 定义 provider（`npm: "@ai-sdk/openai-compatible"`），
  该文件**随 cwd 生效**，所以必须在 `playground/opencode/` 下启动 opencode；
  baseURL 写成 `{env:LLM_MOCK_BASE_URL}`，demo 按本次端口注入，换端口不必改配置；
- **全局配置的 `plugin` 数组是合并而非替换**：项目里写 `"plugin": []` 清不掉 `~/.config/opencode/opencode.json`
  里的插件，所以压测命令固定带 `--pure`（跳过外部插件，保证冷启动可比）；
- 用 `XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME` 把数据/状态/缓存隔离到沙盒内的
  `.data/.state/.cache`（必须经 `deps.harnessEnv` 注入，别用 `process.env` 赋值——见「已知限制与坑」）；
- opencode 会在会话开始时额外发一次**标题生成请求**（小模型、走同一个 provider），也消费脚本条目；
- 排查配置是否按预期生效：`opencode debug config`（合并结果）、`opencode debug paths`（数据目录）。

### Claude Code

- 二进制从 PATH 找（`Bun.which("claude")`，实测 2.1.277）；harness 命令是
  `claude -p '<prompt>' --dangerously-skip-permissions --no-session-persistence`；
- 走 **Anthropic Messages**（`POST /v1/messages`，`stream: true`）；`ANTHROPIC_BASE_URL` **不带 `/v1`**
  （客户端自己拼 `/v1/messages`），`ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`
  与 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 都要显式覆盖，否则会用到用户全局配置；
- **隔离必须改 `HOME`**：`CLAUDE_CONFIG_DIR` 只管状态目录，用户级 `~/.claude/settings.json`
  （里面有 `env`、hooks、插件、MCP）只按 HOME 找——只改后者时它的 `env` 块会把 base URL 抢回去，
  压测就完全打不到本 mock（实测：mock 请求数为 0）；
- 它会向上找到仓库根的 `CLAUDE.md` 当项目记忆，每次请求都带上（属预期）；
- `-p` 模式没有轮数上限、也不会自行收敛，压测时长由 `--timeout-ms` 决定；剧本要收敛就配上
  最后一轮 `finish_reason: "stop"` 的文本回答，并设 `--exhausted hold`。

### Codex

- 二进制从 PATH 找（`Bun.which("codex")`，实测 codex-cli 0.155.1）；harness 命令是
  `codex exec --skip-git-repo-check -s read-only '<prompt>'`；
- 走 **OpenAI Responses**（`POST /v1/responses`，`stream: true`），并且**流必须以 `response.completed`
  事件收尾**，否则 codex 会报 `stream disconnected before completion` 并重试 5 次
  （沙盒 config.toml 里把 `request_max_retries` / `stream_max_retries` 关成 0，免得一次协议错误拖一分钟）；
- 用 `CODEX_HOME` 指向 `playground/codex/.codex`：用户全局 `~/.codex/config.toml` 里有 hooks
  与别的 provider，**绝不能共用**；端口由 demo 每次用
  `-c model_providers.llm-mock.base_url="http://127.0.0.1:<port>/v1"` 覆盖，换端口不用改配置文件；
- 它把工具放在 `input` 的 `additional_tools` 条目里（新版是 `namespace` 包 `custom` 工具 `exec`），
  与 Anthropic / OpenAI chat 的 `tools` 字段不同；剧本书写要按实测形状来：
  `exec` 吃**裸 JavaScript 源码**（`const r = await tools.exec_command({ cmd: "ls" }); text(r.output);`），
  不是 JSON；
- 剧本默认用 `scripts/codex-scenario.json`（四条 exec 调用、不自行收尾，配 `--exhausted loop`），
  因为全局默认剧本（`scripts/perf-scenario.json`）清一色 `Bash` 调用，而 codex 没有这个工具——
  实测它不会崩，只在每轮回一条 `unsupported call: Bash` 继续循环（能供压，但没有真实 shell，
  别拿它做对比）；想跑一次能自行收尾的完整循环用 `playground/codex/script.json` + `--exhausted hold`；
- 大输出剧本要按 codex 的工具形状单独生成一份：
  `bun run scripts/perf/gen-large-md.ts --tool exec --out data/scenarios/large-md-codex.json`。

### pi

- 二进制从 PATH 找（`Bun.which("pi")`，实测 0.85.1，`npm i -g @earendil-works/pi-coding-agent`）；
  harness 命令是 `pi -p '<prompt>' --model llm-mock/llm-mock --no-session --no-extensions`；
- 走 **OpenAI Chat Completions**（`POST /v1/chat/completions`，`stream: true`），与 peri / opencode 同协议；
- 隔离靠 **`PI_CODING_AGENT_DIR`** 指向沙盒（`playground/pi/.pi-agent/`）：配置、凭据、trust 记录、
  extensions 全从它找，指到沙盒就不会读 `~/.pi/agent`（那里面有用户自己的扩展与登录态）；
- 沙盒 `models.json` 每次启动由 demo 生成：读同目录的 `models.json`（人读的源文件，写的是默认端口），
  只把 provider 的 `baseUrl` 换成本次端口。**pi 的配置只对 `apiKey` / `headers` 做 `$VAR` 插值**
  （0.85.1 实测：`baseUrl` 写 `$LLM_MOCK_BASE_URL` 会被当成字面量静默用下去），所以换端口只能改文件，
  没法照搬 opencode 的 `{env:…}` 写法；
- `--model` 必须写 `provider/id`：pi 的默认 provider 是 google，只写模型名会落错 provider
  （沙盒 `--list-models` 可自查，实测能列出 `llm-mock  llm-mock  128K`）；
- 工具名**全小写**（read/bash/edit/write/grep/find/ls），默认剧本用不了 peri 那份 `Bash`：
  实测遇到未知工具 pi 不崩，把 `Tool Bash not found` 当工具结果回传后继续下一轮（与 codex 同类行为，
  能供压但没有真实 shell），所以默认剧本换成 `scripts/pi-scenario.json`；
- 消费规律是几家 harness 里最简的：一次 prompt 只消费「工具轮次 + 一条收尾」，
  **没有 peri 那样的预测请求、也没有 opencode 的标题生成请求**；
- `PI_OFFLINE=1` / `PI_TELEMETRY=0` 关掉启动联网（更新检查、包更新）与遥测；
- pi 没有权限确认弹窗（设计上就不含 permission popups），所以不需要 claude-code 的
  `--dangerously-skip-permissions`；剧本得自觉只放只读命令；
- 它会向上找到仓库根的 `CLAUDE.md` 当上下文文件，每次请求都带上（属预期，与 Claude Code 相同）；
- CLI 是单个 node 进程（`dist/bundle/cli.js`，无子进程），启动快：自行收尾的整轮（3 轮工具调用）
  实测约 0.5s 跑完；被强杀时与 peri 一样 `harness.log` 为空（自行退出才有输出）。

### grok

- 二进制从 PATH 找（`Bun.which("grok")`），再退回官方布局 `~/.grok/bin/grok`；harness 命令是
  `grok -p '<prompt>' -m llm-mock --yolo --no-auto-update`；
- **本机两者都没有**：官方安装脚本在 `x.ai/cli/install.sh`，而这台机器连不上 x.ai（GitHub /
  npm 正常），所以实测用的是源码编译的 `grok-build/target/debug/xai-grok-pager`
  （`--version` 报 `grok 0.2.120`）：该 crate 的注释写明「artifact is still named
  `xai-grok-pager`」，它就是主程序。**debug 构建启动慢——实测 25s 只跑完 13 个请求，
  读数不能与 release 版横向比**，要显式传 `--peri <path>` 指过去；
- 走 **OpenAI Chat Completions**（`POST /v1/chat/completions`，`stream: true`）。它的
  `config.toml` 还支持 `api_backend = "responses" / "messages"`，**三种协议都能指向本 mock**，
  是唯一能做三协议对照的 harness（本次只接了 chat_completions）；
- 隔离靠 **`GROK_HOME`** 指向沙盒（`playground/grok/.grok-home/`）：配置、sessions、hooks、
  marketplace 全从它找，指到沙盒就不会读 `~/.grok`（那里有用户自己的 model 段与凭据）；
- **`XAI_API_KEY` 必须注入**（值任意，demo 给的是 `mock-key`）：grok 启动时先做登录检查，
  即便 model 段自己带 `api_key` 也照样拦（实测报 "Not signed in"）——mock 不校验
  Authorization，这个值纯粹是给 grok 看的；
- 沙盒 `config.toml` 每次启动由 demo 生成：读同目录的 `config.toml`（人读的源文件，`base_url`
  写的是默认端口），只把 `base_url` 替换成本次端口。**判断有没有命中要用正则自身，不能拿
  「替换后是否变化」当判据**——源文件默认端口恰好等于本次端口时字符串不变，会误报「没找到
  base_url 行」（已踩过）；
- 工具名是**全称 `run_terminal_command`**，且 `required = ["command", "description"]`
  （description 必填）。源码里 `"run_terminal_command" | "run_terminal_cmd" | "bash" | "shell"`
  那组只是渲染用的别名，照它写成 `run_terminal_cmd` 会被当成未知工具（tool result:
  `Tool not found: run_terminal_cmd`，然后 grok 把参数解析失败写回模型），所以默认剧本是
  `scripts/grok-scenario.json`；
- 消费规律与 pi 一样简洁：一次 prompt 只消费「工具轮次 + 一条收尾」，**没有辅助请求**；
- `--yolo` 放行工具执行（headless 下没有交互确认）、`--no-auto-update` 关更新检查、
  `GROK_TELEMETRY_ENABLED=0` 关遥测；
- **它是流式写 stdout 的**：被强杀时 `harness.log` 也有内容（与 peri / pi 相反），自行收尾时
  退出码 0、不用强杀；
- 进程树口径要留意：它执行 shell 命令时会拉子进程，`samples.csv` 的 `procs` 列在 1~6 之间跳，
  于是「进程树 RSS」远高于主进程（实测峰值 603MB vs 主进程 135MB）。

## 已知限制与坑（压测相关）

- **`--max-turns` 在 peri 的 `-p` 模式下是空操作**，所以压测时长由 `--timeout-ms` 兜底，
  而不是轮数；`--turns` 只是原样透传给 harness；
- **peri 在 `-p` 模式下只在退出时 flush 输出**：被超时强杀时 `<runId>-harness.log` 会是空文件
  （工具会在 perf.log 里写明原因）；自行收敛时该文件有内容。**pi 同样如此**（实测自行收尾时
  harness.log 有完整回答，loop 剧本被强杀时为空）。**grok / opencode / Claude Code 是持续流式的**，
  被强杀也留有输出；
- 若 peri 报 `workspace identity changed; explicit relinking is required`，那是 `~/.peri/threads/threads.db`
  里该目录的 workspace 记录过期（注册时的 discovery 快照与现状不符），与本仓库无关；
  `perf-demo.ts` 默认换用沙盒内的库绕开，run.ts 则要手动传
  `--peri-arg=--db-path --peri-arg=/tmp/peri.db`，不要为此删用户的库；
- **mock 就绪探活要认出「端口上的是不是本次起的 mock」**：只看 HTTP 200 会被野生 HTTP 服务骗到
  （实测踩过一个抓包服务器），所以先按 `/__mock/status` 的字段校验；但那仍拦不住**另一个 llm-mock
  实例**（字段当然齐备，实测踩过——上一轮被中断的压测留下的旧 mock 占着端口，我们起的 mock 因
  EADDRINUSE 退出，整轮压测静默打到旧实例上，请求数 0），于是再用**剧本路径**核对身份，
  对不上直接 `EXIT_SETUP`，绝不拿别人的数据出报告；
- **Bun 1.4 的 `Bun.spawn` 不继承运行时对 `process.env` 的赋值**（实测子进程读到空值，只有显式传
  `env` 才生效）。所有沙盒变量必须走 `RunDeps.harnessEnv`；早期 demo 用 `process.env.X = …`
  写的隔离是静默失效的；
- **多数 harness 会额外发请求消耗脚本条目**：peri 发「预测下一步输入」，opencode 发标题生成，
  Claude Code / Codex 也会发辅助请求；脚本不足时先看 `*-mock.log` 里是谁在取号。
  **pi 与 grok 是例外**：实测一次 prompt 只消费「工具轮次 + 一条收尾」，没有辅助请求；
- 各 harness 的 `-p` / `run` / `exec` 模式普遍没有轮数上限，loop 剧本不会自行收敛；
- 压测期间 mock 自己也在烧 CPU（实测本机均值约 2% 单核），但它与 harness 不同进程、不参与采样。

## 关键约定与陷阱

- 脚本文件必须显式指定（`--script` 或 `SCRIPT_PATH`），没有隐式默认路径，避免误加载别的剧本；
- 游标是**进程级全局单游标**：并发客户端共享同一序列；取号发生在响应开始之前，流式响应被中途取消也已消费；
- 耗尽策略默认 `error`（500 + `script_exhausted`），可选 `hold` / `loop`；默认不静默兜底；
- 脚本条目是**协议中立**的（`message.content` + `message.tool_calls`），各协议适配器负责渲染：
  chat 的 `tool_calls` → Messages 的 `tool_use` 块（`arguments` 解析成 `input` 对象）→
  Responses 的 function_call / custom_tool_call；
- 节奏优先级：命令行 / 环境变量 > 脚本 `defaults` > 内置值；`chunkSize` 按 grapheme 切分，不拆坏 emoji；
- `usage` 未声明时按字符估算（CJK 1 token/字，其余 4 字符 1 token），要精确值就在条目里显式写；
- 不校验 `Authorization`；`/v1/models` 返回配置的模型名；`choices` 恒为 1；
- 脚本消耗比预期快时，先看 mock 的访问日志确认是哪类请求在取号；
- 改动后跑 `bun test` + `bun run typecheck`；中文注释与文档。
