# CLAUDE.md

## 项目定位

llm-mock 是 OpenAI Chat Completions 的脚本化 mock 服务（Bun 运行时，唯一依赖 hono）：
把预设的响应序列写成 JSON 脚本，**第 i 次 `/v1/chat/completions` 请求返回第 i 条**；
`stream: true` 时把同一条完整响应转换成 OpenAI 规范的 SSE chunk 序列。

两个用途：

- **性能压测**：以脚本控制的节奏驱动 harness（目前接了 peri 与 opencode），测量 harness 进程自身的 CPU / 内存开销（不采 GPU）；
- **功能测试**：不调用真实模型，复现 agent 的多轮循环、工具调用与流式渲染。

## 压测工作流（已实现）

一条命令跑完「起 mock → 起 harness → 每 100ms 采样 → 出记录」：

```sh
bun run scripts/perf/run.ts --timeout-ms 60000          # 默认剧本 + 默认 peri 路径
bun run scripts/perf/run.ts --help                      # 全部选项

cd playground/peri && bun perf-demo.ts --timeout-ms 60000       # peri 沙盒里直接启动
cd playground/opencode && bun perf-demo.ts --timeout-ms 60000   # opencode 沙盒里直接启动
```

两个 `perf-demo.ts` 都是复用同一套实现的薄入口（相对路径按仓库根解析），差别只在 harness 命令与沙盒：

- `playground/peri/perf-demo.ts`：默认给 peri 注入沙盒内的会话库
  `playground/peri/.peri/perf-threads.db`，规避全局库的 workspace 快照过期报错（见「已知限制与坑」）；
  想指定别的库就自己传 `--peri-arg=--db-path`；
- `playground/opencode/perf-demo.ts`：harness 命令固定为
  `opencode run '<prompt>' --model llm-mock/llm-mock --pure`，并用 `XDG_*` 环境变量把 opencode 的数据
  隔离到沙盒内（见「与 opencode 集成」）；二进制从 PATH 找，也可 `--peri <path>` 指定。

需要复核采样口径时跑 `bun run scripts/perf/verify.ts`（对 `yes` / `sleep` 这类已知负载回归，
并打印两个候选后端的开销与分辨率）。

### 场景：超大 markdown 输出

默认剧本的响应只有一两百字节，压不到 markdown 渲染与大流量 SSE 解析；用生成器造大输出剧本：

```sh
bun run scripts/perf/gen-large-md.ts --size-kb 64 --responses 4   # → data/scenarios/large-md.json
bun run scripts/perf/run.ts --script data/scenarios/large-md.json --exhausted loop \
  --timeout-ms 60000 --peri-arg=--db-path --peri-arg=playground/peri/.peri/perf-threads.db
```

同机实测对比（单核口径，见对应 `*-perf.log`）：

| 剧本 | 请求速率 | CPU 均值 / 峰值 | RSS 均值 / 峰值 |
| --- | --- | --- | --- |
| `perf-scenario.json`（短响应 + 短工具调用循环） | 10.6 次/秒 | 46.0% / 82.6% | 119.5MB / 133.9MB |
| `large-md.json`（4×65KB markdown + Bash 调用，loop） | 3.5 次/秒 | 90.5% / 164.2% | 365.1MB / 508.0MB |

大输出下 CPU 在 ~20s 后稳定在 90%+（峰值可 >100%，peri 多线程解析），RSS 随上下文累积近似线性增长。
生成器可调 `--size-kb / --responses / --chunk-size / --chunk-delay-ms`，用不同 chunk 粒度可对比流解析开销。
peri 与 opencode 在同条件剧本下的对比数据见 `docs/perf-compare.md`。

产物落在 `data/claude-date/`（`--out-dir` 可改，`data/` 已在 .gitignore 里），`<runId>` 形如 `20260919-102954`：

| 文件 | 内容 |
| --- | --- |
| `<runId>-perf.log` | 时间线事件 + 每秒一行采样摘要 + 末尾总摘要（样本数、均值/峰值 CPU 与 RSS、时长、mock 请求数） |
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
src/app.ts      Hono 路由 + 访问日志（打印 stream/model/messages/last=role:"…"）
src/script.ts   脚本解析与进程级单游标 ScriptPlayer
src/stream.ts   非流式合成 / SSE 序列、token 估算、grapheme 切分
src/types.ts    OpenAI 协议类型
src/*.test.ts   bun:test：脚本解析、游标、SSE 序列、路由集成
scripts/perf/run.ts        压测入口：起 mock、起 harness、采样、写记录、出摘要
scripts/perf/config.ts     压测参数解析（parseArgs）
scripts/perf/sampler.ts    采样：rusage/ps 后端、差分换算、进程树、CSV 与摘要
scripts/perf/verify.ts     采样口径验证实验（已知负载 + 开销 + 后端对比）
scripts/perf/gen-large-md.ts  生成「超大 markdown 输出」压测剧本（写入 data/scenarios/）
scripts/perf/*.test.ts     bun:test：差分换算、参数解析、端到端（真 mock + 假 harness）
scripts/perf-scenario.json 压测剧本：全是 Bash 工具调用，配 --exhausted loop 持续供压
script.json             默认演示脚本（工具调用 + 中文回答）
scripts/peri-demo.json  按 peri 的消费规律编排的演示脚本
playground/peri/        peri 运行沙盒；.peri/settings.json 把 provider 指向本 mock
playground/peri/perf-demo.ts  压测 demo 入口（薄封装；默认换用沙盒内的会话库）
playground/opencode/    opencode 运行沙盒；opencode.json 定义 mock provider（随 cwd 生效）
playground/opencode/perf-demo.ts  压测 demo 入口（harness 命令换成 opencode run，隔离 XDG_*）
docs/perf-compare.md    peri 与 opencode 的压测对比报告
data/claude-date/       压测产物（已 gitignore）
```

## 常用命令

```sh
bun install
bun run src/server.ts --script script.json   # 起 mock（脚本必填，默认端口 3457）
bun run scripts/perf/run.ts                  # 压测（起 mock + peri + 采样 + 记录）
cd playground/opencode && bun perf-demo.ts   # 换成 opencode 压测
bun run scripts/perf/verify.ts               # 采样口径验证实验
bun test                                     # 全部测试
bun run typecheck                            # tsc --noEmit（含 scripts/ 与 playground/）
```

## 与 harness 集成

### peri

- peri 二进制从 perihelion 仓库构建，与本仓库同级（`../perihelion/target/debug/peri`）；
- `playground/peri/.peri/settings.json` 把 provider 指向 `http://127.0.0.1:3457/v1`；
  `{cwd}/.peri/settings.json` 只在 cwd 命中时生效，所以要**在 `playground/peri/` 下启动 peri**；
- peri 每次 prompt 结束还会发一次「预测下一步输入」请求，同样消费一条脚本——编排脚本时必须把它算进去；
- 起 mock 用 `scripts/peri-demo.json`，它就是按「主回答 → 预测 → …」的规律排的。

### opencode

- 二进制从 PATH 找（`Bun.which("opencode")`），版本现象见 `docs/perf-compare.md`（实测 1.17.12）；
- `playground/opencode/opencode.json` 定义 provider（`npm: "@ai-sdk/openai-compatible"`，baseURL 指向本 mock），
  该文件**随 cwd 生效**，所以必须在 `playground/opencode/` 下启动 opencode；
- **全局配置的 `plugin` 数组是合并而非替换**：项目里写 `"plugin": []` 清不掉 `~/.config/opencode/opencode.json`
  里的插件，所以压测命令固定带 `--pure`（跳过外部插件，保证冷启动可比）；
- 用 `XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME` 把数据/状态/缓存隔离到沙盒内的
  `.data/.state/.cache`，不碰 `~/.local/share/opencode`；`run.ts` 的 `Bun.spawn` 不传自定义 env，
  所以 demo 里 `process.env.*` 的赋值会被 harness 继承；
- opencode 会在会话开始时额外发一次**标题生成请求**（小模型、走同一个 provider），也消费脚本条目；
- 排查配置是否按预期生效：`opencode debug config`（合并结果）、`opencode debug paths`（数据目录）。

## 已知限制与坑（压测相关）

- **`--max-turns` 在 peri 的 `-p` 模式下是空操作**（perihelion `peri-tui/src/cli_print.rs:100` 把该参数
  丢弃），所以压测时长由 `--timeout-ms` 兜底，而不是轮数；`--turns` 只是原样透传给 harness；
- 实测 peri 在**消息数攒到 1000（约 500 轮工具调用）后会停掉 agentic 循环**：先发一次预测请求再退出，
  退出码 0。所以 loop 剧本的压测会在几十秒后由 peri 自己收尾（本机实测 47.5s / 501 次请求），
  最终时长取「peri 自行收敛」与「--timeout-ms」中先到者；
- **peri 在 `-p` 模式下只在退出时 flush 输出**：被超时强杀时 `<runId>-harness.log` 会是空文件
  （工具会在 perf.log 里写明原因）；peri 自行收敛时该文件有内容；
- 若 peri 报 `workspace identity changed; explicit relinking is required`，那是 `~/.peri/threads/threads.db`
  里该目录的 workspace 记录过期（注册时的 discovery 快照与现状不符），与本仓库无关；
  `perf-demo.ts` 默认换用沙盒内的库绕开，run.ts 则要手动传
  `--peri-arg=--db-path --peri-arg=/tmp/peri.db`，不要为此删用户的库；
- **opencode 的 `run` 模式同样没有轮数上限**：压测时长由 `--timeout-ms` 决定（实测它不会自行收敛，
  会一直跑工具循环直到被终止）；
- **opencode 的输出是持续流式的**（与 peri 只在退出时 flush 相反）：被超时强杀后 `harness.log` 仍有内容；
  但大输出剧本下它会把模型输出整段回显，一次 60s 的大输出压测能写出 10MB+ 的日志（peri 同场景约 45KB）；
- 两个 harness 都会额外发请求消耗脚本条目：peri 发「预测下一步输入」，opencode 发标题生成；
  脚本不足时先看 `*-mock.log` 里是谁在取号；
- 压测期间 mock 自己也在烧 CPU（实测本机均值约 2% 单核），但它与 harness 不同进程、不参与采样。

## 关键约定与陷阱

- 脚本文件必须显式指定（`--script` 或 `SCRIPT_PATH`），没有隐式默认路径，避免误加载别的剧本；
- 游标是**进程级全局单游标**：并发客户端共享同一序列；取号发生在响应开始之前，流式响应被中途取消也已消费；
- 耗尽策略默认 `error`（500 + `script_exhausted`），可选 `hold` / `loop`；默认不静默兜底；
- 节奏优先级：命令行 / 环境变量 > 脚本 `defaults` > 内置值；`chunkSize` 按 grapheme 切分，不拆坏 emoji；
- `usage` 未声明时按字符估算（CJK 1 token/字，其余 4 字符 1 token），要精确值就在条目里显式写；
- 不校验 `Authorization`；只实现 `chat/completions` 与 `models`，`choices` 恒为 1；
- 脚本消耗比预期快时，先看 mock 的访问日志确认是哪类请求在取号；
- 改动后跑 `bun test` + `bun run typecheck`；中文注释与文档。
