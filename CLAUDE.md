# CLAUDE.md

## 项目定位

llm-mock 是**脚本化的模型 API mock**（Bun 运行时，唯一依赖 hono）：把预设的响应序列写成 JSON
脚本，**第 i 次请求返回第 i 条**；`stream: true` 时把同一条完整响应转换成对应协议的 SSE 序列。

同一份脚本可以走三种线协议（各自独立计游标，互不干扰）：

| 端点 | 协议 | 谁在用 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | peri、opencode、pi、dsh、MiniMax Code、脚本自测 |
| `POST /v1/messages` | Anthropic Messages | Claude Code |
| `POST /v1/responses` | OpenAI Responses | Codex |

两个用途：

- **性能压测**：以脚本控制的节奏驱动 harness（peri / Claude Code / Codex / pi / dsh / MiniMax Code；
  opencode **已退出排名、不再跑**，见「与 harness 集成」开头），测量 harness 进程自身的 CPU / 内存开销
  （不采 GPU）；
- **功能测试**：不调用真实模型，复现 agent 的多轮循环、工具调用与流式渲染。

## 压测工作流（已实现）

一条命令跑完「起 mock → 起 harness → 每 100ms 采样 → 出记录」：

```sh
bun run scripts/perf/run.ts --script data/scenarios/long-run.json --exhausted stop --timeout-ms 600000
bun run scripts/perf/run.ts --help                      # 全部选项（--script 必填，没有默认剧本）

cd playground/peri        && bun perf-demo.ts --timeout-ms 600000   # peri 沙盒（默认长剧本 + stop）
cd playground/claude-code && bun perf-demo.ts --timeout-ms 600000   # Claude Code 沙盒
cd playground/codex       && bun perf-demo.ts --timeout-ms 600000   # Codex 沙盒
cd playground/pi          && bun perf-demo.ts --timeout-ms 600000   # pi 沙盒
cd playground/deepseek    && bun perf-demo.ts --timeout-ms 600000   # dsh 沙盒
cd playground/minimax-code && bun perf-demo.ts --timeout-ms 600000  # MiniMax Code（mcode）沙盒
# cd playground/opencode  && bun perf-demo.ts --timeout-ms 600000   # 已退出排名：代码保留，常规批次不再跑
```

`perf-demo.ts` 都是复用同一套实现的薄入口（相对路径按仓库根解析），差别只在 harness 命令、
沙盒与配置注入方式（详见「与 harness 集成」）。**默认剧本是各家的长剧本**
（`data/scenarios/long-run*.json`，由 `gen-long-run.ts` 按自家工具形状生成），`--exhausted` 默认
`stop`；`run.ts` 的 `--script` 是必填（见「关键约定与陷阱」），那份默认值因此由各家 demo 自己带：

- `playground/peri`：默认注入 `--db-path`（沙盒会话库）与 `--settings`（运行时生成、指向本次端口的 JSON）；
- `playground/opencode`：`XDG_*` 隔离 + `{env:LLM_MOCK_BASE_URL}` 变量替换（换端口不用改配置）；
- `playground/claude-code`：`HOME` + `CLAUDE_CONFIG_DIR` 都指到沙盒（**只改后者挡不住用户级 settings**）；
- `playground/codex`：`CODEX_HOME` 指向沙盒（用户全局配置里有 hooks 与别的 provider）；
- `playground/pi`：`PI_CODING_AGENT_DIR` 指向沙盒，`models.json` 每次启动按本次端口重写
  （pi 的 `baseUrl` 不吃 `$VAR` 插值，换端口只能改文件）；
- `playground/deepseek`：`DSH_HOME` 指向沙盒，provider 全走环境变量
  （`$DEEPSEEK_BASE_URL` / `$DEEPSEEK_API_KEY`），**不用生成配置文件**；
- `playground/minimax-code`：`MINIMAX_DATA_DIR` 指向沙盒，provider 按本次端口写进沙盒的
  `config.yaml`（mcode 的 `baseURL` 不吃环境变量插值，与 pi 同理）。

需要复核采样口径时跑 `bun run scripts/perf/verify.ts`（对 `yes` / `sleep` 这类已知负载回归，
并打印两个候选后端的开销与分辨率）。想把「CPU 与内存」混成一个可比的数（谁跑完同一部剧本烧的资源
更少）看**统一计分**——**Beta：口径还在讨论中，先用来看趋势、别当结论**，见下面的
「统一计分（Beta）：把 CPU 与内存混成一个数的试行口径」。

### 场景：长剧本端到端（跑完整个剧本，测时长）

`--exhausted stop` 让 mock 在剧本走完后返回一条「任务结束」纯文本（`finish_reason=stop`），
harness 收到即自行收尾退出——于是能测**端到端时长**（含启动，`perf.log` 里的「端到端时长」）
与整段资源消耗，而不是某段固定时间窗内的资源写照。剧本由生成器现造（仓库里不放剧本文件），
生成器**固定带两条收尾条**（轮数之外）：一条同文的「任务结束」文本 + 一条空白响应——后者是给
peri 的「预测下一步输入」的，能消掉它固定 5.0s 的收尾等待（理由见「已知限制与坑」）：

```sh
# 七家各一份（工具名/参数形状按各家实测，见 gen-long-run.ts 的 ArgShape）
bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json           # peri / opencode / Claude Code（Bash + command）
bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
bun run scripts/perf/gen-long-run.ts --turns 133 --tool bash --out data/scenarios/long-run-pi.json  # pi 要 133：压缩请求每轮多吃一条
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --args command+description \
  --out data/scenarios/long-run-dsh.json
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --out data/scenarios/long-run-minimax-code.json  # mcode：bash + command，轮数 + 1 条就够

cd playground/peri && bun perf-demo.ts --exhausted stop --timeout-ms 1200000
```

`--timeout-ms` 只作兜底（正常应看到 `harness 退出: code=0` 且时长远小于它）；peri 3.17 的
`-p` 模式忽略 `--max-turns`，但真生效时默认 25 会截断剧本，习惯给 harness 带上 `--turns 100`
（**demo / run.ts 的 `--turns` 是传给 harness 的 `--max-turns`，与生成器同名的那个「轮数」不同义**）。
想量「与轮数无关的固定成本」用 `--turns 1 --body-kb 0` 生成探针剧本（它同时含启动与收尾，
两边各占多少看摘要里的「时长分段」）。最近一批六家的分段读数差异极大——启动 0.1~1.3s、收尾 0.0~10.0s，
见 `docs/perf-compare.md`。
摘要里的**「时长分段」**把它拆成三段——启动（起进程 → 首个请求）、运转（首 → 末次请求）、
收尾（末次请求 → 退出）——实测很值钱：**peri / Codex 的固定成本九成是收尾**（Codex 10.1s 卡在
退出时向 `chatgpt.com` 发的一个请求上，本机 DNS 污染导致 10s 超时；把 HTTPS 出口指向死端口后
掉到 0.4s。peri 曾是固定 5.0s，根因是等一个 Prediction 后台任务，默认剧本的空白收尾条已把它
消到 ~0.05s，见「已知限制与坑」）。实测数据与验证过程见 `docs/perf-compare.md`。
注意**「剧本轮数」与「harness 实际执行的轮数」可能不等**：各家自己的辅助请求（标题生成、上下文
压缩）也消费剧本条目，100 条剧本下 opencode / dsh 实测只跑到 99 轮、pi 要 135 条（`--turns 133`）
才够跑满 100 轮（数法：`mock.log` 里带工具结果的请求有几条）。生成器写的条目数是 `轮数 + 2`
（两条收尾，见上），peri 那条「预测下一步输入」就落在最后那条空白上。

产物落在**一次运行一个目录**里：`data/runs/<harness>/<runId>/`（`--out-dir` 可改，`data/` 已在
.gitignore 里），`<harness>` 是 `peri` / `opencode` / `claude-code` / `codex` / `pi` / `dsh`
之一（由 `--harness` 指定，或从启动命令的第一个 token 查别名表推断，见 `scripts/perf/harness-id.ts`），
`<runId>` 形如 `20260919-140136`（同秒第二次运行加 `-2` 后缀）：

| 文件 | 内容 |
| --- | --- |
| `run.json` | **机器接口**：身份 / 剧本（含 sha256）/ mock 与采样参数 / 宿主信息 / 时间线（含首个与末次请求的绝对时刻）/ 时长分段 / 摘要统计 / **统一计分 `cost`** / 退出码 / 产物清单。开跑先写一份 `status:"running"`，结束时原子替换补全；读取端只认它 |
| `perf.log` | 人读时间线（含注入的环境变量）+ 每秒一行采样摘要 + 末尾总摘要（含「时长分段」启动 / 运转 / 收尾与「统一计分」那一行） |
| `samples.csv` | 原始采样：`ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs,child_cpu_pct`（列**只能往后加**，读取端按表头名取列） |
| `harness.log` | harness 的 stdout/stderr |
| `mock.log` | mock server 的输出（含每次请求的摘要行） |

老产物是平铺的 `data/claude-date/<runId>-{perf.log,samples.csv,harness.log,mock.log}`，用
`bun run scripts/perf/migrate-layout.ts [--dry-run]` 迁进新布局（幂等、不覆盖、拒迁还在写入的文件）；
读取端（`gen-chart-data.ts`）在迁移完成前同时认两种布局，扫到老布局会提示跑迁移。

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
- **短命子进程靠另一条通道兜**：进程树每隔 `treeRefreshMs`（默认 2000ms）才刷一次 pid 集合，
  harness 每轮工具调用拉起的 shell 只活几十毫秒，实测默认口径只捕获到它的 33%。这些都是**被回收**
  的子进程，其 CPU 会累加进父进程 rusage 的 `ri_child_user_time` / `ri_child_system_time`
  （实测钉死偏移 96/104，**单位同样是 Mach tick**），差分即得 `child_cpu_pct` 列。
  它与 `tree_cpu_pct` 是两套互补的下界、**可能重叠，不能相加**，计分时取两者较大者；
- 采样数据先进内存、每 1s 落盘一次，避免每拍同步 I/O 干扰被测对象。

### 统一计分（Beta）：把 CPU 与内存混成一个数的试行口径

**状态：Beta**（2026-09-19 起试行）。系数是借来的、实现是稳的，但**这套口径本身还没定稿**——
「后代 CPU 算不算 harness 的开销」「时长该按端到端还是按可控执行时长」这些还没想清楚，
所以它现在的定位是**一个可讨论的候选口径**，不是裁决：排名与结论可以引它，但别把它的名次
当成对 harness 的最终评价，也别据此改动被测对象。口径要改就先在 `docs/perf-compare.md` 写明、
重跑一个完整批次再更新读数。

它回答的问题很具体：「跑完同一部剧本，谁的整段资源成本更小」——单个 CPU 均值或 RSS 峰值答不了
这个（那要看**面积**，不是峰值）。系数借阿里云函数计算（FC）的 CU（Compute Unit）折算表
（2026-09-19 核对官方计费页；FC 的口径是「资源使用量 × 转换系数」再求和）：

```
CU    = 1.0 × 核·秒 + 0.15 × GB·秒      （FC 弹性实例：vCPU 1.0 CU/(vCPU·秒)、内存 0.15 CU/(GB·秒)）
核·秒 = ∫(tree_cpu_pct / 100) dt         GB·秒 = ∫(tree_rss_kb / 2^20) dt      ← 时间积分，含时长
分数  = 100 × 本批次最小 CU / 本次 CU    （最优 100 分；**只在同一批次内可比**，跨批次只比 CU）
```

口径、系数与四处刻意偏差的完整说明只在 **`scripts/perf/score.ts` 的文件头**，别处不许重写一份。

那个 `∫` 是**逐拍累加**（100ms 一拍，按每拍实测间隔差分）：`Σ(每拍资源率 × 该拍间隔)`，
不是「均值 × 时长」那种估法。报告与页面里的三段（启动 / 运转 / 收尾）是同一口径的**分段积分**，
只用来回答「钱花在哪一段」：三列之和 = 总分 − 尾部补齐（那 ~0.1s 只进总分，六家实测逐笔成立），
**不是三段相加**；后代 CPU 的取大也只在整段上取一次，逐段取会在段边界重复计。

**Beta 期间先守住的几条**（它们保证的是口径**内部自洽与可比**，不是「这么算就对了」；
要改任何一条，先在 `docs/perf-compare.md` 里写明理由并重跑全批次）：

- **系数不许微调**，尤其不许为了「让排名好看」动那三个数（`CU_COEFFICIENTS`）；
- **口径固定进程树**（含 harness 拉起的后代），不用主进程——Codex 主进程 CPU 近 0，
  真干活的是它 spawn 的原生二进制；
- **后代 CPU 取 `max(采样到的后代, 已回收子进程计数器)`，不许相加**：两条路都是下界且可能重叠
  （被看见过的子进程之后被回收，同一段 CPU 会在计数器里再出现一次，实测相加多算 136%）；
- **时长必须在公式里**（就是上面那个积分），不许退化成「平均 CPU%」之类的无量纲量；
- **末拍 → harness 退出的空档必须补**（`timing.harnessExitedAtMs` 实测，按末尾三拍速率外推，
  上限 500ms）；补不了（老产物没记这个时刻）就**明确标下界**，不许静默按 0 混进去；
- **调用次数项单列**（`callCu`，0.0075 CU/次）**不计入总分**：请求数由剧本决定，不是 harness 的开销；
- **`samples.csv` 的列只能往后加**，读取端按表头名取列；缺 `child_cpu_pct` 的老产物要在输出里
  标「进程树口径偏低」（`childColumnPresent: false`），跟数据一起走，不许悄悄按 0 处理。

**出口必须同源**（三处数字对不上就是 bug）：每次运行落 `run.json` 的 `cost` 与 `perf.log` 末尾那行；
`gen-chart-data.ts` 从 `samples.csv` **现算**（不读 `cost`，这样老产物也同口径可比）→
`docs/perf-chart.html` 的计分表与 `docs/perf-compare.md` 的计分章节都只显示，不自己记公式。
报告里给 CU 必须同时给「批内相对」与「下界标记」的说明，`gen-chart-data.ts` 的输出会替你把
这两类警告打出来。

**新批次要求**：重跑时用当前采样器（`child_cpu_pct` 列是新的），别再拿老产物出排名——
老批次的 CU 是下界（补不上尾部空档、也漏掉短命子进程，实测 pi 差 ~9%）。

**一批怎么跑**（分数是批内相对值，把不同批次混进一张表就废了）：六家**串行**、每家 **3 次**，
读数取**端到端时长居中的那一次**（`gen-chart-data.ts --window 3` 是同一口径，`--pick <runId>` 可显式
点名）；跑批统一带 `--label <批次名>` 便于按批筛产物（最近一批：六家 × 3 轮串行、3 分 12 秒跑完，
`--label score-batch`）。**跨批次只比 CU**，别比分数、也别比绝对时长——同一台机器、同一份剧本，
load 2.9 时 peri 是 2.2s，load 10~16 时要 13.2s。

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
scripts/perf/sampler.ts    采样：rusage/ps 后端、差分换算、进程树、已回收子进程计数器、CSV 与摘要
scripts/perf/score.ts      统一计分（**Beta**）：阿里云 FC 的 CU 口径（核·秒 / GB·秒 → CU → 百分制相对分）
scripts/perf/verify.ts     采样口径验证实验（已知负载 + 开销 + 后端对比）
scripts/perf/gen-long-run.ts  生成「长剧本」压测剧本（N 轮正文 + 工具调用，按各家的工具形状）
scripts/perf/gen-chart-data.ts 汇总长剧本产物 → docs/perf-chart.html 用的图表数据
scripts/perf/harness-id.ts     harness 身份与别名（写入端与读取端共用一份）
scripts/perf/run-meta.ts       run.json 的 schema 与原子写入
scripts/perf/legacy-run.ts     老布局（平铺产物）的解析：迁移与读取端兼容用，过渡件
scripts/perf/migrate-layout.ts 老布局 → 新布局的幂等迁移
scripts/perf/markdown.ts      剧本正文生成（长剧本每轮的 markdown 从这里来）
scripts/perf/*.test.ts     bun:test：差分换算、参数解析、计分公式、端到端（真 mock + 假 harness）
script.json             默认演示脚本（工具调用 + 中文回答）
scripts/peri-demo.json  按 peri 的消费规律编排的演示脚本
playground/<harness>/   各自 harness 的运行沙盒 + perf-demo.ts 入口 + 剧本（按需）
docs/perf-compare.md    各 harness 的压测对比报告
data/runs/              压测产物：一次运行一个目录（已 gitignore）
data/claude-date/       老布局的压测产物（迁移前的遗留，迁完即可删）
```

## 常用命令

```sh
bun install
bun run src/server.ts --script script.json          # 起 mock（脚本必填，默认端口 3457）
bun run scripts/perf/run.ts --script data/scenarios/long-run.json --exhausted stop   # 压测（--script 必填）
cd playground/claude-code && bun perf-demo.ts       # 换成 Claude Code 压测（默认剧本由 demo 自带）
bun run scripts/perf/verify.ts                      # 采样口径验证实验
bun test                                            # 全部测试
bun run typecheck                                   # tsc --noEmit（含 scripts/ 与 playground/）
```

## 与 harness 集成

七家都是「让 harness 把 base URL 指向本 mock」，但接入点各不相同：

### peri

- 默认 harness 是 **PATH 里的 `peri`**（`Bun.which("peri")`，实测 3.17.0）；**PATH 里没有就直接报错，
  不回退本地构建产物**（`../perihelion/target/debug/peri` 是 debug 构建，读数与发布版不可比，
  混用等于换了被测对象）；要测别的二进制用 `--peri <path>` 显式指定；
- peri 3.17 起**不再读 `{cwd}/.peri/settings.json`**（旧版行为），只认 `~/.peri/settings.json`
  或 `--settings <文件|JSON 字符串>`；demo 因此运行时生成 settings JSON 传给 `--settings`，
  不去动用户的全局配置（`playground/peri/.peri/settings.json` 保留为同结构的手工参考）；
- 默认还注入 `--db-path playground/peri/.peri/perf-threads.db`，隔离会话库（原因见「已知限制与坑」，
  想换库就自己传 `--peri-arg=--db-path --peri-arg=<path>`）；
- peri 每次 prompt 结束还会发一次「预测下一步输入」请求，同样消费一条脚本——编排脚本时必须算进去；
  `scripts/peri-demo.json` 就是按「主回答 → 预测 → …」的规律排的。它的位置在**主流程结束之后**，
  长剧本尾部那条空白就是给它的（预测拿到非空文本会拖出 5.0s 收尾等待，见「已知限制与坑」）。

### opencode（**已退出排名，常规批次不再跑**）

**退出原因**：它在各项指标上都远落后于其余五家（端到端 38.6s vs 1.5~19.9s、进程树 CPU 均值
69.9% / 峰值 229.3%、RSS 均值 798.9MB / 峰值 943.0MB，整段消耗约 27 核·秒 vs 其余 1.0~5.0），
故不计入排名，`docs/perf-compare.md` 与 `docs/perf-chart.html` 上都已标注。**代码、沙盒与下面的
接入说明全部保留**：要复测就按下面的方式单跑，跑完用 `--exclude opencode` 生成图表数据即可
（`gen-chart-data.ts` 的选项：某家退出常规批次后，留在 `data/runs` 里的历史产物不会自己爬回图表）。

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
- 剧本默认用自家的长剧本 `data/scenarios/long-run-codex.json`（`gen-long-run.ts --args exec` 生成）：
  codex 没有 peri 那份剧本用的 `Bash` 工具，而 `exec` 是它唯一的 custom 工具——实测拿 Bash 过去
  它也不会崩，只在每轮回一条 `unsupported call: Bash` 继续跑（能供压，但没有真实 shell，
  别拿它做对比）；想跑一次能自行收尾的完整循环用 `playground/codex/script.json` + `--exhausted hold`。

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
- 工具名**全小写**（read/bash/edit/write/grep/find/ls），用不了 peri 那份 `Bash`：
  实测遇到未知工具 pi 不崩，把 `Tool Bash not found` 当工具结果回传后继续下一轮（与 codex 同类行为，
  能供压但没有真实 shell），所以默认剧本是自家那份 `data/scenarios/long-run-pi.json`
  （`gen-long-run.ts --tool bash` 生成，工具名小写）；
- 消费规律是几家 harness 里最简的：一次 prompt 只消费「工具轮次 + 一条收尾」，
  **没有 peri 那样的预测请求、也没有 opencode 的标题生成请求**；
- `PI_OFFLINE=1` / `PI_TELEMETRY=0` 关掉启动联网（更新检查、包更新）与遥测；
- pi 没有权限确认弹窗（设计上就不含 permission popups），所以不需要 claude-code 的
  `--dangerously-skip-permissions`；剧本得自觉只放只读命令；
- 它会向上找到仓库根的 `CLAUDE.md` 当上下文文件，每次请求都带上（属预期，与 Claude Code 相同）；
- CLI 是单个 node 进程（`dist/bundle/cli.js`，无子进程），启动快：自行收尾的整轮（3 轮工具调用）
  实测约 0.5s 跑完；被强杀时与 peri 一样 `harness.log` 为空（自行退出才有输出）。

### dsh（DeepSeek Harness）

- 二进制从 PATH 找（`Bun.which("dsh")`，实测 0.1.5-rc.2，`npm i -g @deepseek-ai/dsh`）；harness 命令是
  `dsh --profile headless '<prompt>'`；
- **入口就是 profile**：`dsh --profile <name>` 启动 `$DSH_HOME/profiles/<name>`，`headless` 是官方的
  一次性模式——跑一个任务、最终回答写 stdout（推理增量写 stderr）、完成退出码 0 / 出错 1，**不起端口、
  不留后台进程**；`dsh web`（浏览器 UI，默认 127.0.0.1:3080）只是 `--profile web` 的别名；
- 走 **OpenAI Chat Completions**（`POST /v1/chat/completions`，`stream: true`）：内置的
  `dsh-llm-deepseek` 适配器按 `POST {baseURL}/chat/completions` 发请求，所以 baseURL 要带 `/v1`；
  模型 id 是默认配置里的 `deepseek-flash`（provider `deepseek-official`），命令行不用指定；
- 隔离靠 **`DSH_HOME`** 指向沙盒（`playground/deepseek/.dsh-home/`）：profile 树（各 profile 的
  `cordis.patch.yml` 与 patch 层）、`sessions/`、`storages/`、匿名用户 id 全从它找，指到沙盒就不会
  读用户默认的 `~/.dsh`；首次启动按内置模板初始化 profile（组合包从**安装目录**解析，不联网装依赖）；
- **provider 配置全走环境变量，不用生成配置文件**（这点比 pi 省事）：适配器的 `baseURL` 认
  `$DEEPSEEK_BASE_URL`（优先于默认的 https://api.deepseek.com），凭据引用名就是 `$DEEPSEEK_API_KEY`
  ——给个假值即可（mock 不校验 Authorization；引用解析为空才会以 `MISSING_CREDENTIAL` 失败）；
- `DSH_TELEMETRY_DISABLED` 关遥测（启动器认这个开关，**任何非空值**都算关）；
- 权限矩阵在 `dsh-base` 的 patch 里：`DSH_PERMISSION_MODE` 未设即 `workspace-write` + 审批 `ask`
  （`danger-full-access` 才把审批改成 `never`）。实测**工作区内的只读命令直接执行、不问审批**；
  需要升权（`sandbox_permissions` + `justification`）的命令在 headless 下无人可批，所以剧本自觉只放
  只读命令——比 claude-code 的 `--dangerously-skip-permissions` 收得更紧，demo 因此不设这个变量；
- 工具名是 **`bash`**（小写，同 pi），但参数是 `{command, description}` **两个都必填**：缺 description
  会被工具自己拒掉（tool result: `Error: invalid arguments: missing required property "description"`，
  agent 拿着这个错误继续跑），所以默认剧本是自家那份 `data/scenarios/long-run-dsh.json`
  （`gen-long-run.ts --tool bash --args command+description` 生成）；
- **消费规律**：一次 prompt 先发主请求（`messages=5`，末条是带 system-reminder 的 user），紧接着发一条
  **「会话标题生成」**请求（`messages=2`、同 provider 同模型，插件 `dsh-session-title-first-prompt-llm`），
  之后每轮工具调用各一条主请求——编排剧本必须把标题那条算进去；
- **它是流式写 stdout 的**：被强杀时 `harness.log` 也有内容（与 opencode / Claude Code 同类，
  与 peri / pi 相反）；自行收尾时退出码 0、不用强杀；
- 进程树口径：`samples.csv` 的 `procs` 列实测**恒为 1**——它执行 shell 命令时拉的子进程太短命、
  采样打不到，所以「进程树」读数与主进程一致。

### MiniMax Code（`mcode`）

- 二进制从 PATH 找（`Bun.which("mcode")`，实测 0.4.12，`npm i -g @minimax-ai/code`）；harness 命令是
  `mcode exec --permission off --cwd <沙盒> --model custom_provider:llm-mock/llm-mock '<prompt>'`：
  `exec` 是官方的**无头模式**（跑一个任务、最终回答写 stdout、成功退 0），不依赖 Electron——
  上游仓库 MiniMax-AI/minimax-code 是桌面 App 的 issue 收集页，能进压测的只有这条 CLI；
- 走 **OpenAI Chat Completions**（`POST /v1/chat/completions`，`stream: true`），与 peri / opencode /
  pi / dsh 同协议；实测请求体带 18 个工具（`read` / `write` / `edit` / **`bash`** / `grep` / `glob` /
  `todowrite` / `skill` / `web_fetch` / `task*` …），`reasoning_effort: medium`、`store: false`；
- 隔离靠 **`MINIMAX_DATA_DIR`** 指向沙盒（`playground/minimax-code/.minimax/`）：`config.yaml` 与
  `v2/` 运行时状态（会话库、background-tasks、日志、shims）全从它找，指到沙盒就不碰 `~/.minimax`；
- **provider 只能靠配置文件**：`custom_provider.<id>.options.baseURL` 不吃环境变量插值，所以 demo
  每次按本次端口重写 `$MINIMAX_DATA_DIR/config.yaml`（形状按 0.4.12 实测，就是 `mcode provider add`
  写出来的那份；`apiKey` 直接写文件——mock 不校验 Authorization）。`--model` 必须写
  `custom_provider:<id>/<model>` 这种**带类型前缀的全名**，只写模型名会落到官方模型、打不到 mock；
- 权限：headless **不支持 `ask`**，demo 固定 `--permission off`——一次性任务，剧本自觉只放只读命令；
- 工具名 **`bash`**（小写，同 pi）且参数只要 `{command}`（`timeout` 可选），所以剧本用
  `gen-long-run.ts --tool bash`（默认 `--args command`）生成；实测 `bash` 工具**没有**
  `description` 那种必填参数，也没有 dsh 的审批等待；
- **消费规律是七家里最干净的**：100 轮剧本实收 **101 条 = 100 轮 + 尾部收尾**，没有标题生成、
  没有上下文压缩、没有预测请求（对比：pi 要 135 条、dsh 的标题请求会吃第 2 条）——实测 3 次
  端到端 19.6~20.2s（启动 1.3s · 运转 18.2s · 收尾 0.25s）、CU 21.29~22.06（**已并入常规批次**，
  与其余五家同批测得，见 `docs/perf-compare.md`）；
- 启动时会刷新模型目录（`models.dev/api.json` → `filecdn.minimax.chat`），落成沙盒里
  4.7MB 的 `cache/models-dev-catalog.json`（`updatedAt` 每次运行都变）——它不经过 mock，
  但会给启动段带一点外部网络成分，跨机器比时长时要留意；
- `harness.log` 有内容（自行收尾时 stdout 里是最终回答，本次即收尾文本）。

## 已知限制与坑（压测相关）

- **`--max-turns` 在 peri 的 `-p` 模式下是空操作**，所以压测时长由 `--timeout-ms` 兜底，
  而不是轮数；`--turns` 只是原样透传给 harness；
- **peri 在 `-p` 模式下只在退出时 flush 输出**：被超时强杀时 `<runId>-harness.log` 会是空文件
  （工具会在 perf.log 里写明原因）；自行收敛时该文件有内容。**pi 同样如此**（实测自行收尾时
  harness.log 有完整回答，loop 剧本被强杀时为空）。**opencode / Claude Code / dsh 是持续流式的**，
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
- **多数 harness 会额外发请求消耗脚本条目**：peri 发「预测下一步输入」（在**主流程收尾之后**才发，
  长剧本里吃的是尾部那条空白），opencode 与 dsh 发「会话标题生成」（dsh 那条来自 `dsh-session-title-first-prompt-llm`，
  只看首条 prompt，一次会话一条；opencode 那条出现在启动期，`messages=2`）；**pi 的
  上下文压缩也会发请求**——pi 默认开压缩（`compaction.enabled=true`，`reserveTokens` 16384 /
  `keepRecentTokens` 20000），从约 140 条消息起每轮追加一条 `messages=2` 的总结；
  Claude Code / Codex 本次没见到。脚本不足时先看 `*-mock.log` 里
  是谁在取号（每行都有 `messages=` / `input=` 与末条消息的角色），症状是「明明在正常工作，
  却提前收到收尾文本」；
- 各 harness 的 `-p` / `run` / `exec` 模式普遍没有轮数上限，loop 剧本不会自行收敛
  （要收敛就配有限长的剧本 + `--exhausted stop`）；
- **peri `-p` 退出前固定等 ~5.0s：根因已查明，默认剧本已把它消掉**（长剧本摘要的「时长分段」
  第三段）。退出时 host 用硬编码 5s 的 cooperative_grace 等 host-owned 任务收尾，卡住的正是
  `HostTaskKind::Prediction`：「预测下一步输入」拿到**非空**文本后回落成 Placeholder 动作、
  走到写 session 标题那步停住（大概率是与关闭流程争 session 锁；日志停在 prediction.rs 的
  「Prediction ready, sending notification」之前），直到超时被 abort——日志里 `aborting
  host-owned task kind=Prediction` 与预测完成的间隔 5.0015s。与网络/连接无关（`--bare` 不消、
  杀掉 mock 也不消、静默期 `lsof` 无任何对外连接），**peri 侧说的「langfuse 环境变量」不成立**：
  本机没有 `LANGFUSE_*`，代码也要双 key 同时存在才启用（`from_env()`）。给预测请求一条**空白**
  响应则 `execute_prediction` 在拿锁前就返回空动作，5s 立刻消失（实测收尾 5.0s → 0.05s、端到端
  7.7s → 2.6s）——长剧本生成器据此固定带两条收尾条（见上）；要复现旧读数就把尾部那条空白删掉。
  根治得靠 peri 侧（给那把锁加超时，或关闭时拒绝 prediction 写 session）；
- **Codex 退出固定等 ~10.1s**：退出时向 `https://chatgpt.com/backend-api/plugins/featured` 发请求，
  本机 DNS 污染 → 连接停在 SYN_SENT → 10s 超时；`HTTPS_PROXY` 指死端口可把这 10s 消掉；
- Codex 每次启动会起一条 `git fetch https://github.com/openai/plugins.git`（curated 插件同步），
  本机传不完，Codex 退出后**变孤儿进程继续挂着**并往 `$CODEX_HOME/.tmp/` 攒目录；
  压测后 `ps | grep plugins-clone` 清理一下，免得干扰后续读数；
- 压测期间 mock 自己也在烧 CPU（实测本机均值约 2% 单核），但它与 harness 不同进程、不参与采样。

## 关键约定与陷阱

- 脚本文件必须显式指定（`--script` 或 `SCRIPT_PATH`），没有隐式默认路径，避免误加载别的剧本；
  **压测侧同一条约定**：`scripts/perf/run.ts` 的 `--script` 也是必填（仓库里不再放现成剧本），
  默认剧本由各 playground 的 `perf-demo.ts` 按自家的工具形状填（`data/scenarios/long-run*.json`）；
- 游标是**进程级全局单游标**：并发客户端共享同一序列；取号发生在响应开始之前，流式响应被中途取消也已消费；
- 耗尽策略默认 `error`（500 + `script_exhausted`），可选 `hold` / `loop` / `stop`——`stop` 在剧本
  走完后返回收尾文本（`finish_reason=stop`）让 harness 自然退出（长剧本把这条收尾直接写进尾部，
  `stop` 是更后面的兜底，见「场景：长剧本端到端」）；默认不静默兜底；
- 脚本条目是**协议中立**的（`message.content` + `message.tool_calls`），各协议适配器负责渲染：
  chat 的 `tool_calls` → Messages 的 `tool_use` 块（`arguments` 解析成 `input` 对象）→
  Responses 的 function_call / custom_tool_call；
- 节奏优先级：命令行 / 环境变量 > 脚本 `defaults` > 内置值；`chunkSize` 按 grapheme 切分，不拆坏 emoji；
- `usage` 未声明时按字符估算（CJK 1 token/字，其余 4 字符 1 token），要精确值就在条目里显式写；
- 不校验 `Authorization`；`/v1/models` 返回配置的模型名；`choices` 恒为 1；
- 脚本消耗比预期快时，先看 mock 的访问日志确认是哪类请求在取号；
- **harness 的「谁更省」先看 CU**（统一计分 **Beta**，口径见上）：写报告、出图表、做排名引用
  CU 与它的下界标记，别另起一套指标；口径只在 `scripts/perf/score.ts` 一处。因为还是 Beta，
  给结论时把「CU 这么算」一并说清（含后代 CPU 与尾部补齐两处取舍），别只报一个名次；
- 改动后跑 `bun test` + `bun run typecheck`；中文注释与文档。
