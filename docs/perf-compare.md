# 压测对比：五种 harness（opencode 已退出排名）

> **opencode 已退出排名（2026-09-19 起）**
>
> 本批次六家里，它是唯一**各项指标都远落后**的一家：端到端 **38.6s**（其余五家 1.5~19.9s，
> 是最快的 pi 1.5s 的 25 倍多，也是第二慢的 Codex 19.9s 的 1.9 倍）、进程树 **CPU 均值 69.9% /
> 峰值 229.3%**（两项都最高）、进程树 **RSS 均值 798.9MB / 峰值 943.0MB**（第二高的 Claude Code
> 才 274.9 / 321.9MB，差 2.9 倍）。按「端到端 × CPU 均值」粗估整段消耗约 **27 核·秒**，其余五家
> 在 1.0~5.0 核·秒（第二贵的 dsh 5.0）——同跑一份 100 轮剧本，它烧掉的是别人的 5 倍以上。
>
> 继续把它放进榜单只会拉长横轴、把其余五家压成一堆，它也已不构成有意义的对照，因此**后续批次
> 不再跑 opencode、不计入排名**。`playground/opencode/` 的沙盒与接入代码保留（想复测随时可按
> 下面的命令单跑，`scripts/perf/harness-id.ts` 里的别名也还在）；本文表格里那一行与图表里的历史
> 读数按原样保留，只加标注。

用 llm-mock 以受控负载测量各 harness 自身的资源开销。测量时间 2026-09-19，机器 macOS（Apple Silicon，
18 核），采样间隔 100ms（`proc_pid_rusage`，CPU 为**单核 100%** 口径，不采 GPU）。

口径是**长剧本端到端**：一份有限长的剧本（100 轮 × 约 4KB 正文 + 一次工具调用，`--exhausted stop`），
harness 走完剧本、收到收尾响应后**自行退出**——回答的是「跑完同一个任务要多久、整段消耗多少、
启动 / 运转 / 收尾各占多少」。用固定时间窗去比「谁烧的 CPU 多」没有意义（各家在同一个窗口里做的
活量本来就不同）。

被测对象与接入方式：

| harness | 版本 | 线协议 | 接入点 | 沙盒隔离 |
| --- | --- | --- | --- | --- |
| peri | 3.17.0（PATH） | OpenAI Chat Completions | `--settings <JSON>` | `--db-path` 会话库 |
| opencode | 1.17.12 | OpenAI Chat Completions | 随 cwd 的 `opencode.json` + `{env:LLM_MOCK_BASE_URL}` | `XDG_*` |
| Claude Code | 2.1.277 | Anthropic Messages | `ANTHROPIC_BASE_URL` 等环境变量 | `HOME` + `CLAUDE_CONFIG_DIR` |
| Codex | 0.155.1 | OpenAI Responses | `CODEX_HOME/config.toml` 的 provider | `CODEX_HOME` |
| pi | 0.85.1 | OpenAI Chat Completions | 沙盒 `models.json` 换 baseUrl + `--model llm-mock/llm-mock` | `PI_CODING_AGENT_DIR` |
| dsh | 0.1.5-rc.2 | OpenAI Chat Completions | `$DEEPSEEK_BASE_URL` / `$DEEPSEEK_API_KEY` 环境变量 | `DSH_HOME` |
| MiniMax Code（`mcode`） | 0.4.12 | OpenAI Chat Completions | 沙盒 `config.yaml` 的 `custom_provider.*.options.baseURL` + `--model custom_provider:llm-mock/llm-mock` | `MINIMAX_DATA_DIR` |

约定：每个 harness 都在自己的 playground 沙盒里、用同一份剧本跑
（`cd playground/<名> && bun perf-demo.ts …`），剧本由同一个生成器现造、工具形状按各家实测；
节奏取生成器默认（`chunkSize=64 / chunkDelayMs=0`，mock 尽快吐完），mock 不是瓶颈；
测的是 harness 主进程 + 进程树。**六家串行跑**（不同时占用机器），各跑 1 次。

## 复现

### 长剧本端到端（100 轮 × 4KB，跑到自然结束）

剧本由生成器造：100 轮「约 4KB 正文 + 一次工具调用」，**尾部另带两条收尾条**——一条「任务结束」纯文本
（`finish_reason=stop`，harness 收到即自行收尾退出）+ 一条空白响应（给 peri 的「预测下一步输入」，
消掉它固定 5.0s 的收尾等待，机制见「逐家的收尾与辅助请求」）。本批读数还是在没有这两条时取的
（当时靠 mock 的 `--exhausted stop` 兜最后一条，peri 因此吃到非空预测文本、白等 5s）。
于是端到端时长就是「启动 → 跑完 100 轮 → 退出」，`--timeout-ms` 只是兜底（正常不该触发）。

摘要里会把这段时长**拆成三段**（靠 mock 侧记的请求时刻，与 harness 起止同机同时钟）：

```
时长分段: 启动 → 首个请求 X ｜ 首个请求 → 末次请求 Y ｜ 末次请求 → 退出 Z（收尾零请求：…）
```

第三段是「harness 已经不发请求、但进程还没退」的**收尾等待**——实测这条极有信息量：
peri / Codex 的所谓「启动开销」几乎全是它（见下节），只看总时长会把账记到启动头上。

```sh
# 生成剧本（工具形状按各家实测；**pi 那份要 130 轮**，理由见下）
bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json   # peri / opencode / Claude Code 共用
bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
bun run scripts/perf/gen-long-run.ts --turns 130 --tool bash --out data/scenarios/long-run-pi.json
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --args command+description \
  --out data/scenarios/long-run-dsh.json
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash \
  --out data/scenarios/long-run-minimax-code.json   # mcode：bash + {command}，100 条够跑满 100 轮

cd playground/peri        && bun perf-demo.ts --port 3480 --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000 --turns 100
cd playground/opencode    && bun perf-demo.ts --port 3480 --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000
cd playground/claude-code && bun perf-demo.ts --port 3480 --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000
cd playground/codex       && bun perf-demo.ts --port 3480 --script data/scenarios/long-run-codex.json \
  --exhausted stop --timeout-ms 1800000
cd playground/pi          && bun perf-demo.ts --port 3480 --script data/scenarios/long-run-pi.json \
  --exhausted stop --timeout-ms 1800000
cd playground/deepseek    && bun perf-demo.ts --port 3480 --script data/scenarios/long-run-dsh.json \
  --exhausted stop --timeout-ms 1800000
cd playground/minimax-code && bun perf-demo.ts --port 3480 \
  --exhausted stop --timeout-ms 1800000             # 默认剧本就是 long-run-minimax-code.json
```

- `--script` 要传**绝对路径**（或从仓库根跑）：`run.ts` 按进程 cwd 解析相对路径，而在
  `playground/<名>/` 里 cwd 已经变了；各家 demo 的**默认剧本**已经指向自家那份，`--script` 只是显式化。
- `--turns 100` 是防呆：peri 3.17 在 `-p` 模式下虽然忽略 `--max-turns`，但真生效时默认值 25
  会把剧本拦腰截断（其余各家没有等价的轮数参数，靠剧本耗尽收尾）。它与生成器的同名参数不同义：
  生成器的 `--turns` 是剧本轮数，这里传给 demo 的是 harness 的 `--max-turns`。
- **pi 那份为什么是 130 轮**：pi 从上下文约 140 条消息起开始**自动压缩**（`compaction.enabled`
  默认 true，`reserveTokens` 16384 / `keepRecentTokens` 20000），压缩期每轮追加一条
  `messages=2` 的总结请求，同样消费剧本条目。100 条剧本下它只跑到第 84 轮就耗尽了（第 70 轮起
  「总结 + 主请求」交替取号）；加长到 130 条后主循环正好跑到第 100 轮（实测：主循环 100 次请求，
  末次 `messages=200`，另有 30 条被总结请求取走）。

产物落在 `data/runs/<harness>/<runId>/`：`run.json`（机器接口：身份 / 时间线 / 分段 / 摘要 / 退出码）+
`perf.log`（人读时间线）+ `samples.csv`（逐拍采样）+ `harness.log` / `mock.log`。本次这 6 次是：

```
peri 20260919-135946 · opencode 20260919-140006 · claude-code 20260919-140052 · codex 20260919-140110
pi 20260919-142311   · dsh 20260919-140424
```

看逐拍曲线：`bun run scripts/perf/gen-chart-data.ts --pick <上面 6 个 runId>`（想把它整条挡在
图表外就加 `--exclude opencode`；页面上它本来就默认收起、不参与 X 轴定标）生成
`data/perf-chart.json`，再用静态服务器打开 `docs/perf-chart.html`（见文末「图表页」）。

## 结论速览

- **端到端（排名只看前五家）：pi 1.5s ≪ Claude Code 5.4s < dsh 9.8s < peri 13.2s < Codex 19.9s**；
  opencode 38.6s **已退出排名**（理由见开头）。这一行的排序**不等于「谁轻」**——peri / Codex 的
  大头是收尾等待，opencode 才是真的每轮都贵。
- **pi 的 1.5s 是真跑满 100 轮**（mock 侧主循环 100 次请求、末次请求 `messages=200`），
  12.8ms/轮是六家里最便宜的；它额外付出的代价是**自动压缩**：多发了 30 条总结请求（见上）。
- **那笔「固定成本」多半是「退出慢」不是「启动慢」**（`perf.log` 的「时长分段」）：peri 13.2s 里
  5.1s 是收尾等待（等一个 Prediction 后台任务，与轮数、连接都无关；根因与消除办法见「逐家的收尾」），
  Codex 19.9s 里 10.1s 是退出时等一个到 `chatgpt.com` 的请求超时（本机 DNS 污染所致，换干净网络
  会小得多）。**启动本身六家都在 0.2~2.3s**。
- **opencode 最贵在每轮**（它因此退出了排名）：364ms/轮的运转成本是 Claude Code（46ms/轮）的 8 倍、
  pi（12.8ms/轮）的 28 倍，CPU 峰值 229%、RSS 峰值 943MB（整段涨了 919MB）也是六家里最高的。
- 内存随轮次上涨是**预期**：每轮都把历史（上一轮的正文 + 工具结果）随请求回传，RSS 里既有渲染
  缓冲也有会话累积（100 轮剧本正文合计约 450KB，末轮请求体与它同量级；pi 因为压缩过所以短得多）。
- **别把「请求数」当「轮数」**：mock 请求数里混着各家自己的辅助请求——本批次实测 peri 1 条
  （「预测下一步输入」，发生在剧本耗尽之后）、opencode 1 条（启动期那条 2 消息请求）、dsh 1 条
  （会话标题生成）、pi 30 条（每轮一次的压缩总结）；Claude Code / Codex 本次没有。
  **辅助请求会吃掉剧本条目**，所以 100 条剧本下 opencode / dsh 实际只执行了 99 轮工具调用
  （见下表「执行轮数」）。
- Codex 的 CLI 是一层 Node 启动器（`~/.bun/bin/codex` 是 `node` 脚本，真正干活的是它 spawn 出来的
  原生二进制），所以「主进程」读数（0.2% / 42MB）没有意义——**看进程树那一列**。
- 本次测量机器上还有别的负载（load average 起跑 10.2、收尾 11.7，各家开跑时在 10.2~16.1 之间波动；
  pi 那次是稍后单独补跑，load 12.2），绝对读数偏保守；六家在相近条件下测得，横向比较可用，
  要更干净的数字请在空闲机器上按上节重跑。

## 结果

### 长剧本：100 轮 × 4KB，跑到自然结束（各家 1 次）

| harness | 端到端 | 启动 → 首个请求 | 首个请求 → 末次请求 | 末次请求 → 退出 | 运转段每轮 | 请求数 | 执行轮数 | CPU 均值 | CPU 峰值 | RSS 均值 | RSS 峰值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pi 0.85.1 | **1.5s** | 0.2s | 1.3s | 0.0s | **12.8ms** | 132 | 100 | 66.1% | 124.0% | 181.4MB | 227.9MB |
| Claude Code 2.1.277 | 5.4s | 0.7s | 4.6s | 0.1s | 46ms | 101 | 100 | 65.4% | 120.0% | 274.9MB | 321.9MB |
| dsh 0.1.5-rc.2 | 9.8s | 1.9s | 7.8s | 0.2s | 79ms | 101 | 99 | 51.0% | 190.0% | 178.4MB | 215.3MB |
| peri 3.17.0 | 13.2s | 2.0s | 6.1s | **5.1s**（零请求） | 61ms | 102 | 100 | 13.8% | 41.3% | 58.3MB | 72.5MB |
| Codex 0.155.1 | 19.9s | 0.4s | 9.4s | **10.1s**（零请求） | 94ms | 101 | 100 | 6.6% | 34.3% | 167.6MB | 182.8MB |
| opencode 1.17.12（**已退出排名**） | 38.6s | 2.3s | 36.0s | 0.2s | 364ms | 101 | 99 | 69.9% | 229.3% | 798.9MB | 943.0MB |

口径：

- **端到端时长**＝harness 启动到退出（`run.json` 的 `duration.endToEndMs`），比采样窗口多出
  prime 与最后一次采样的间隔；100 轮剧本正文合计约 450KB。
- **三段**＝`run.json` 的 `segments`（`startupMs / spanMs / tailMs`），由 mock 侧记的请求时刻算出。
  末段标「零请求」表示这段里 harness 一个请求都没发（纯等）。
- **运转段每轮** = `spanMs ÷ 执行轮数`，是对「每轮处理链路」的估计，**不含启动与收尾**。
- **执行轮数**＝真正被执行并回传结果的工具调用次数（从 `mock.log` 逐条数的：`消费第 N 条` 的
  请求里带工具结果的那些）。100 条剧本下 opencode / dsh 各被自家辅助请求吃掉 1 条，
  pi 用的是 130 条剧本、辅助请求吃掉 30 条（详见「结论速览」与「读数怎么读」）。
- **CPU / RSS 为进程树口径**，均值与峰值都取自 `samples.csv`（100ms 一拍）；Codex 主进程只是
  Node 启动器（0.2% / 42MB），看进程树才有意义。
- RSS 涨幅（首拍 → 末拍）：opencode +919MB、Claude Code +275MB、Codex +140MB、
  pi +128MB、peri +51MB、dsh +47MB。其中 Codex 的一大截来自每轮工具子进程（`zsh -lc` + 本机
  `.zshrc` 的 emsdk 初始化，`procs` 列 1~6），不全等于上下文累积。

读法：

- **pi 的 1.5s 不是漏跑**：mock 侧主循环 100 次请求，消息数 2 → 200 逐轮增长（每轮 +2 条），
  工具结果确实回传了；它快在链路短（12.8ms/轮）与压缩后请求体小（后半程 `messages` 被压回
  62 条量级）。要比较「长会话」形态的话，pi 的这份读数偏乐观——它自己把历史压掉了。
- **opencode 的贵在每轮**：364ms/轮的边际成本是 Claude Code 的 8 倍，CPU 峰值 229%（多核并发）、
  RSS 峰值 943MB；它的瓶颈不在启动，而在每轮的处理链路。
- **peri / Codex 的成本在「收尾」而非「启动」**：这两家的收尾段占了各自总时长的 39% / 51%，
  且收尾期间**零请求、CPU 归零**——是纯粹的退出前等待（peri 是等一个 Prediction 后台任务，
  根因见下；Codex 是等 `chatgpt.com` 超时）。要把「一次会话跑很多轮」和「反复短会话」分开看：
  后者的成本几乎全在这笔收尾上。跑 100 轮本身 peri 只要 6.1s、Codex 9.4s。
- **dsh 的启动 1.9s** 在六家里排第三（仅次于 opencode 2.3s / peri 2.0s），但端到端只有 9.8s——
  它没有 peri / Codex 那样的收尾等待，运转段也便宜（79ms/轮）。

### 新接入：MiniMax Code（`mcode`）——上方批次之后单独连跑 3 次

`mcode exec`（`@minimax-ai/code` 0.4.12 的无头模式，走 OpenAI Chat Completions）是本批次**之后**
新接的一家，**没有和上方批次串在一起跑**，所以下面单列；接入细节见 `CLAUDE.md` 的「与 harness 集成」：

| 运行 | 端到端 | 启动 → 首个请求 | 首个请求 → 末次请求 | 末次请求 → 退出 | 请求数 | CPU 均值 / 峰值 | RSS 均值 / 峰值 | CU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20260919-182058 | 19.5s | 1.3s | 18.0s | 0.2s | 101 | 97.9% / 191.9% | 588.8MB / 706.4MB | 21.20 |
| 20260919-182157 | 19.5s | 1.3s | 18.0s | 0.3s | 101 | 97.6% / 174.5% | 628.1MB / 911.1MB | 21.27 |
| 20260919-182219 | 19.3s | 1.2s | 17.9s | 0.2s | 101 | 98.1% / 167.9% | 623.3MB / 896.7MB | 21.13 |

- **端到端 19.3~19.5s，与 Codex（19.9s）同档**：启动 1.2~1.3s、运转 17.9~18.0s（≈180ms/轮）、
  收尾 0.2~0.3s——没有 peri / Codex 那种固定收尾等待；三次读数几乎重合（受控条件下可复现）；
- **消费规律是各家最干净的**：100 轮剧本实收 **101 条 = 100 轮 + 尾部那条收尾**，没有标题生成、
  没有上下文压缩、没有预测请求（pi 为此要 130 条剧本，dsh / opencode 的标题请求各吃掉 1 条）；
- **它是这份名单里最费资源的**：进程树 CPU 均值 **97.9%**（几乎全程占满一个核）、RSS 峰值 ~900MB，
  CU **21.1~21.3**——作为对照，`data/runs` 里 opencode 最近那次（端到端 17.5s）是 12.8 CU、
  pi 是 1.0 CU。端到端不比 opencode 慢，但每一轮都在满速吞吐：**它不省，只是快**。
- 启动时会刷新模型目录（`models.dev/api.json` → `filecdn.minimax.chat`，落沙盒 `cache/` 下 4.7MB），
  不经过 mock，但给启动段带了一点外部网络成分——跨机器比启动时长时要留意。

## 逐家的收尾与辅助请求（本批次实测）

| harness | 收尾段 | 收尾段里有请求吗 | 辅助请求（本批次实测） |
| --- | --- | --- | --- |
| Codex | 10.1s | 无（等 `chatgpt.com` 超时） | 无 |
| opencode | 0.2s | — | 1 条（启动期 `messages=2` 的请求，吃掉第 1 条剧本） |
| Claude Code | 0.1s | — | 无 |
| dsh | 0.2s | — | 1 条「会话标题生成」（`messages=2`，吃掉第 2 条剧本） |
| pi | 0.0s | — | 30 条压缩总结（第 70 轮起每轮一条，吃掉 30 条剧本） |

- **Codex 的 10s 是退出时在等一个网络请求超时**：`RUST_LOG=debug` 显示 turn 结束（`shutdown`）后
  10.0s 整，日志才打出
  `WARN codex_core_plugins::manager: failed to warm featured plugin ids cache error=failed to send
  remote featured plugin request to https://chatgpt.com/backend-api/plugins/featured?platform=codex`；
  同期还有 `https://ab.chatgpt.com/otlp/v1/metrics` 的导出超时。本机 `chatgpt.com` 被 DNS 污染
  （解析到 108.160.165.189 / 107.181.166.244 这类黑洞 IP），TCP 停在 `SYN_SENT` 直到 reqwest 10s
  超时。**这是本机网络环境的产物，不是 Codex 的固有成本**：把 HTTPS 出口指到死端口
  （`HTTPS_PROXY=http://127.0.0.1:9`，mock 走 HTTP 不受影响）后，同一套 1 轮流程从 10.5s 掉到
  **0.40s**。另外每次启动它都会起一条 `git fetch https://github.com/openai/plugins.git`
  （curated 插件仓库同步），本机传不完、Codex 退出后**变成孤儿进程继续挂着**（跑完记得看一眼
  `ps | grep plugins-clone`，会攒垃圾目录在 `$CODEX_HOME/.tmp/`）。
  试过但**没用**的开关：`-c features.plugins=false`（确实不再 clone，仍等 10s）、
  `-c otel.enabled=false`、`-c chatgpt_base_url=<死端口>`、播种 `models_cache.json`。
- **pi 的压缩**：上下文到阈值 → 发一条总结请求 → 用摘要开新对话，每轮一条（渐进式，30 条）。
  **它同样消费剧本条目**，编排剧本时要按「主循环轮数 + 压缩请求数」留足余量，
  否则主循环跑不满预期轮数。

## 读数怎么读（别踩的坑）

- **长剧本的「时长」含启动与收尾**，这是刻意的：端到端就该含。但要拆开看——`run.json` 的
  `segments` 把 启动 / 运转 / 收尾 三段分开，**peri 与 Codex 的成本九成在收尾**，别按总时长
  除以 100 去算「每轮成本」（那会同时冤枉 Codex 并高估 Claude Code）。
- **收尾段读数的两个坑**：一是它可能包含 harness 自己的固定等待（peri 5.1s，默认剧本已消掉；
  Codex 10.1s，与轮数无关），二是其中可能有**本机网络环境的成分**（Codex 那 10s 就是在等
  `chatgpt.com` 超时，换台干净网络会掉到 0.4s 量级——验证见上节）。跨机器比较时长前先确认这两件事。
- **收尾必须靠 `--exhausted stop`**：harness 不会因为剧本耗尽就自己退出——`hold` 会卡到兜底超时
  （时长读数全是超时值，白测），`error` 会让它看到 500 而不是「任务完成」。stop 让 mock 在剧本
  走完后返回一条纯文本结束语，各 harness 收尾路径与真实任务结束一致（生成器现在把这条直接写进
  剧本尾部，stop 仍是更后面的兜底）；peri 多发的「预测下一步输入」由尾部那条空白兜住——**别让它
  吃到非空文本**，否则白等 5s。
- **请求数 ≠ 轮数**：先数「带工具结果的请求」再看 `消费第 N 条` 取到几号，能分辨是主循环在跑
  还是辅助请求在取号（`mock.log` 每行都写了 `messages=` / `input=` 与最后一条消息的角色）。
  脚本不够用时症状是「harness 明明在正常工作，却提前收到收尾文本」。
- **不要拿 CPU 均值去除以请求数当「单次请求开销」**：各 harness 每轮做的事不一样（Codex 每轮
  工具调用都要新起一个 `/bin/zsh -lc`，而这台机器的 `.zshrc` 里还有 emsdk 初始化；opencode 每轮
  并发处理更重）。要比单位成本就用「运转段每轮」那一列。
- **进程树包含工具调用的子进程**：`samples.csv` 的 `procs` 列能看到进程数波动（本批次 peak：
  Codex 6，其余 1）；RSS 的涨幅里混着工具子进程的固定占用，别全记到上下文累积上。
- **peri 被强杀时 `harness.log` 是空的**（`-p` 模式只在自行退出时 flush），属已知限制；
  长剧本下它自行退出，所以日志完整。pi 同理。
- **首次运行与后续运行的温差**：本批次跑在各家沙盒状态已预热的情况下（会话库、缓存都在），
  冷启动读数会比这里更高；轮次之间没有清沙盒缓存，六家一视同仁。
- 想看逐拍曲线直接读 `data/runs/<harness>/<runId>/samples.csv`
  （`ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs`），或看下一节的图表页；
  采样口径的验证实验见 `bun run scripts/perf/verify.ts`。

## 图表页

`docs/perf-chart.html` 是个静态页：折线图画各家的逐拍曲线（X = 时间，Y 可切
RSS / CPU、主进程 / 进程树），图上带请求分界线（首个与末次请求）。数据来自同目录的
`data/perf-chart.json`（由 `gen-chart-data.ts` 从 `data/runs/` 里挑一次运行导出的精简载荷）。
**opencode 的线默认收起、不参与 X 轴定标**（已退出排名，见开头）：在图例里点一下可展开看它的
历史读数，展开时是一条虚线、横轴会自动延伸到 38.6s。

曲线默认按 **1s 窗口做滑动平均**（页面上可切原始 / 0.5s / 1s / 2s）：100ms 采样下多线程
harness 的 CPU 是真实的锯齿（几拍突发、几拍归零），不平滑就只剩毛刺——本批数据里相邻两拍
跳 30 个百分点以上的有 opencode 186 处、dsh 25 处、Claude Code 8 处，1s 窗口后降到 0 处。
平滑只改画法，`samples.csv` 与页面汇总表里的均值 / 峰值始终是原始读数。

图上另有两条读图约定：**每条线的峰值标出 harness 名**（CPU 与内存都标，标的是画出来的那条线，
所以峰值跟着平滑窗口走），以及**内存的纵轴是反的**（0 在顶、占用越大越靠下，方向与「内存变重」
一致）；CPU 轴仍是正常方向。

```sh
bun run scripts/perf/gen-chart-data.ts            # 默认每个 harness 取最近 3 次里时长居中的一次
bun run scripts/perf/gen-chart-data.ts --pick 20260919-135946 --pick 20260919-140006 …   # 或显式点名
cd <仓库根> && python3 -m http.server 8080        # 页面用 fetch 读 JSON，file:// 会被 CORS 挡
# → http://localhost:8080/docs/perf-chart.html
```

Chart.js 先试 unpkg 的 CDN（`chart.js@4`）**2s 超时**，拿不到就换仓库里的
`docs/vendor/chart.umd.min.js`（该目录已 gitignore，换机器可能没有）：本机浏览器走 PAC 代理
实测公共 CDN 不是报错而是挂着不动，所以超时是必需的、页面也不能用静态 script 标签去取它
（实测无头加载时卡在 CDN 上，页面根本不渲染）。**兜底才是常态路径**。页面不需要构建，
改 JSON 刷新即可。
