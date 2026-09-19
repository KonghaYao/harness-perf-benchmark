# 压测对比：六种 harness（opencode 已退出排名）

> **opencode 已退出排名（2026-09-19 起）**
>
> 它仍是唯一**各项指标都远落后**的一家（上一批实测：端到端 **38.6s**，同一批其余五家
> 1.5~19.9s；进程树 **CPU 均值 69.9% / 峰值 229.3%**，两项都最高；进程树 **RSS 均值 798.9MB /
> 峰值 943.0MB**，第二高的 Claude Code 才 274.9 / 321.9MB，差 2.9 倍）。按「端到端 × CPU 均值」
> 粗估整段消耗约 **27 核·秒**，其余五家在 1.0~5.0 核·秒（第二贵的 dsh 5.0）——同跑一份 100 轮
> 剧本，它烧掉的是别人的 5 倍以上。
>
> 继续把它放进榜单只会拉长横轴、把其余各家压成一堆，它也已不构成有意义的对照，因此**后续批次
> 不再跑 opencode、不计入排名**，下面的表格里也没有它（各家读数都出自同一批次，混进一份隔了
> 4 小时的旧产物就破坏了「批内可比」）。`playground/opencode/` 的沙盒与接入代码保留（想复测随时
> 可按下面的命令单跑，`scripts/perf/harness-id.ts` 里的别名也还在），它的历史产物仍在
> `data/runs/opencode/`——图表要显示它，生成数据时不加 `--exclude opencode` 即可。

用 llm-mock 以受控负载测量各 harness 自身的资源开销。测量时间 **2026-09-19 18:46~18:49**（第三批；
机器 macOS / Apple Silicon 18 核，批次期间 load average ≈ 2.9），采样间隔 100ms
（`proc_pid_rusage`，CPU 为**单核 100%** 口径，不采 GPU）。本文读数全部出自这一批
（跑批命令统一带 `--label score-batch`）；上一批（18:37~18:42）是在 pi 的剧本从 130 轮换成 133 轮
（理由见「复现」）之前开跑的，它的 pi 只跑到 99 轮、与其余五家不同源，故整批作废重跑。

口径是**长剧本端到端**：一份有限长的剧本（100 轮 × 约 4KB 正文 + 一次工具调用，`--exhausted stop`），
harness 走完剧本、收到收尾响应后**自行退出**——回答的是「跑完同一个任务要多久、整段消耗多少、
启动 / 运转 / 收尾各占多少」。用固定时间窗去比「谁烧的 CPU 多」没有意义（各家在同一个窗口里做的
活量本来就不同）。

被测对象与接入方式：

| harness | 版本 | 线协议 | 接入点 | 沙盒隔离 |
| --- | --- | --- | --- | --- |
| peri | 3.17.0（PATH） | OpenAI Chat Completions | `--settings <JSON>` | `--db-path` 会话库 |
| opencode（**已退出排名**） | 1.17.12 | OpenAI Chat Completions | 随 cwd 的 `opencode.json` + `{env:LLM_MOCK_BASE_URL}` | `XDG_*` |
| Claude Code | 2.1.277 | Anthropic Messages | `ANTHROPIC_BASE_URL` 等环境变量 | `HOME` + `CLAUDE_CONFIG_DIR` |
| Codex | 0.155.1 | OpenAI Responses | `CODEX_HOME/config.toml` 的 provider | `CODEX_HOME` |
| pi | 0.85.1 | OpenAI Chat Completions | 沙盒 `models.json` 换 baseUrl + `--model llm-mock/llm-mock` | `PI_CODING_AGENT_DIR` |
| dsh | 0.1.5-rc.2 | OpenAI Chat Completions | `$DEEPSEEK_BASE_URL` / `$DEEPSEEK_API_KEY` 环境变量 | `DSH_HOME` |
| MiniMax Code（`mcode`） | 0.4.12 | OpenAI Chat Completions | 沙盒 `config.yaml` 的 `custom_provider.*.options.baseURL` + `--model custom_provider:llm-mock/llm-mock` | `MINIMAX_DATA_DIR` |

约定：每个 harness 都在自己的 playground 沙盒里、用同一份剧本跑
（`cd playground/<名> && bun perf-demo.ts …`），剧本由同一个生成器现造、工具形状按各家实测；
节奏取生成器默认（`chunkSize=64 / chunkDelayMs=0`，mock 尽快吐完），mock 不是瓶颈；
测的是 harness 主进程 + 进程树。**六家串行跑**（不同时占用机器），每家跑 **3 次**，
取端到端时长居中的那一次（`gen-chart-data.ts --window 3` 是同一口径）——下面所有读数都是那一次。
**跨批次别比绝对时长**：更早那批是在 load 10~16 下测的，同样一台机器、同一份剧本，端到端能差 2~4 倍
（本轮 load ≈ 2.9，peri 从 13.2s 变 2.2s、dsh 从 9.8s 变 3.6s，而 CPU 满载的 mcode 几乎不动）。

## 复现

### 长剧本端到端（100 轮 × 4KB，跑到自然结束）

剧本由生成器造：100 轮「约 4KB 正文 + 一次工具调用」，**尾部另带两条收尾条**——一条「任务结束」纯文本
（`finish_reason=stop`，harness 收到即自行收尾退出）+ 一条空白响应（给 peri 的「预测下一步输入」，
消掉它固定 5.0s 的收尾等待，机制见「逐家的收尾与辅助请求」）。本批读数就是带着这两条取的
（peri 的收尾因此只有 0.09s）；不带时靠 mock 的 `--exhausted stop` 兜最后一条，
peri 会吃到非空预测文本、白等 5s。
于是端到端时长就是「启动 → 跑完 100 轮 → 退出」，`--timeout-ms` 只是兜底（正常不该触发）。

摘要里会把这段时长**拆成三段**（靠 mock 侧记的请求时刻，与 harness 起止同机同时钟）：

```
时长分段: 启动 → 首个请求 X ｜ 首个请求 → 末次请求 Y ｜ 末次请求 → 退出 Z（收尾零请求：…）
```

第三段是「harness 已经不发请求、但进程还没退」的**收尾等待**——实测这条极有信息量：
Codex 的所谓「固定开销」几乎全在这里（见下节），只看总时长会把账记到启动头上；peri 那笔
5.0s 的收尾等待已被剧本尾部的空白收尾条消掉，本批只剩 0.09s。

```sh
# 生成剧本（工具形状按各家实测；**pi 那份要 133 轮**，理由见下）
bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json   # peri / Claude Code 共用
bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
bun run scripts/perf/gen-long-run.ts --turns 133 --tool bash --out data/scenarios/long-run-pi.json
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
- **每家的 3 次**：同一条命令连跑 3 次（本批六家 × 3 轮串行跑完只用了 3 分 12 秒：18:46:18 → 18:49:30），
  跑批时统一带 `--label <批次名>` 便于按批筛产物；读数取**端到端时长居中的那一次**
  （`gen-chart-data.ts --window 3` 是同一口径），别把不同批次的运行混进同一张表。
- `--turns 100` 是防呆：peri 3.17 在 `-p` 模式下虽然忽略 `--max-turns`，但真生效时默认值 25
  会把剧本拦腰截断（其余各家没有等价的轮数参数，靠剧本耗尽收尾）。它与生成器的同名参数不同义：
  生成器的 `--turns` 是剧本轮数，这里传给 demo 的是 harness 的 `--max-turns`。
- **pi 那份为什么要 133 轮**：pi 从上下文约 140 条消息起开始**自动压缩**（`compaction.enabled`
  默认 true，`reserveTokens` 16384 / `keepRecentTokens` 20000），压缩期每轮追加一条
  `messages=2` 的总结请求，同样消费剧本条目。100 条剧本下它只跑到第 84 轮就耗尽了（第 70 轮起
  「总结 + 主请求」交替取号）。生成器给尾部那两条收尾（见上）会再占掉一条，**实测 132 条
  （`--turns 130`）只跑到 99 轮、133 条仍是 99 轮、135 条（`--turns 133`）才正好 100 轮**
  （那些多出来的条目全被压缩请求吃掉）——所以这份剧本是 133 轮 = 135 条。

产物落在 `data/runs/<harness>/<runId>/`：`run.json`（机器接口：身份 / 时间线 / 分段 / 摘要 / **统一计分
`cost`** / 退出码）+ `perf.log`（人读时间线）+ `samples.csv`（逐拍采样，含 `child_cpu_pct`）+
`harness.log` / `mock.log`。本批六家各跑 **3 次**（`--label score-batch`，共 18 次运行），
下面所有读数取自**端到端时长居中的那一次**：

```
peri 20260919-184618 · claude-code 20260919-184831 · codex 20260919-184836
pi 20260919-184856   · dsh 20260919-184652        · minimax-code 20260919-184803
```

看逐拍曲线：`bun run scripts/perf/gen-chart-data.ts --exclude opencode`（不给 `--pick` 时每个
harness 自动取最近 3 次里时长居中的那一次，也就是上表这 6 个 runId）生成
`data/perf-chart.json`，再用静态服务器打开 `docs/perf-chart.html`（见文末「图表页」）。

## 结论速览

- **端到端：pi 1.3s ≪ peri 2.2s ≈ Claude Code 2.2s < dsh 3.6s ≪ Codex 16.0s < MiniMax Code 19.7s**。
  但这一行的排序**不等于「谁轻」**：Codex 之所以慢，是因为它退出时固定等 10.0s（零 CPU、零请求），
  它跑完 100 轮本身是六家里最便宜的（运转段 0.71 CU）。
- **pi 的 1.3s 是真跑满 100 轮**（135 条请求 = 100 轮工具调用 + 34 条压缩总结 + 1 条初始），
  11ms/轮是六家里最便宜的；它额外付出的代价是**自动压缩**：多发了 34 条总结请求（见下）。
- **那笔「固定成本」是「退出慢」不是「启动慢」**（`perf.log` 的「时长分段」）：Codex 16.0s 里
  10.0s 是退出时等一个到 `chatgpt.com` 的请求超时（本机 DNS 污染所致，换干净网络会小得多）。
  **启动本身六家都在 0.1~1.3s**（最慢的 MiniMax Code 1.3s 是它在启动期刷模型目录）。
  peri 那个固定 5.0s 的收尾等待已由剧本尾部的空白收尾条消掉（13.2s → 2.2s、收尾剩 0.09s，
  根因见「逐家的收尾」）。
- **单看 CPU 均值 / RSS 峰值会读歪**：MiniMax Code 全程占满一个核（CPU 均值 97.8%、RSS 峰值
  895.6MB），peri 只要 32.4% / 72.7MB，Codex 更是 3.9% / 165.2MB——可 Codex 的「低 CPU」是因为
  真干活的是它 spawn 的原生二进制，而 peri 的「低 CPU」是因为它每轮拉起的 shell 会被回收
  （那部分记在子进程计数器上，见下）。**这两个数都答不了「跑完烧掉多少资源」**。
- 内存随轮次上涨是**预期**：每轮都把历史（上一轮的正文 + 工具结果）随请求回传，RSS 里既有渲染
  缓冲也有会话累积（100 轮剧本正文合计约 450KB，末轮请求体与它同量级；pi 因为压缩过所以短得多）。
  本批次首拍 → 末拍的涨幅：peri +51MB、Codex +100MB、pi +118MB、dsh +166MB、Claude Code +251MB、
  MiniMax Code +698MB。
- **别把「请求数」当「轮数」**：mock 请求数里混着各家自己的辅助请求——本批次实测 peri 1 条
  （「预测下一步输入」，吃的是剧本尾部那条空白、不占轮次）、dsh 1 条（会话标题生成，吃掉第 2 条剧本）、
  pi 34 条（压缩总结）；Claude Code / Codex / MiniMax Code 本次没有。
  **辅助请求会吃掉剧本条目**，所以 dsh 实收 99 轮工具调用；pi 那份剧本按 133 轮生成（135 条），
  才换来正好 100 轮（见「复现」）。
- **混成一个数看（统一计分 **Beta**，候选口径）：Codex 0.944 CU ＞ pi 1.067 ＞ peri 1.999 ＞
  Claude Code 2.114 ＞ dsh 2.431 ＞ MiniMax Code 21.511**（阿里云 FC 的 CU 口径，含时长；
  折成百分制 100 / 88.5 / 47.2 / 44.7 / 38.8 / 4.4，见「统一计分」）。**它答的不是「谁快」**：
  Codex 端到端最慢却最省——它 100 轮只烧 0.63 核·秒，那 10.0s 收尾是纯空等。
- **peri 排第三，是被它自己拉起的 100 个 shell 顶上来的**：它主进程 CPU 均值只有 32.4%，
  可每轮工具调用都要 spawn 一个进程，**1.264 核·秒（占总 CPU 的 64%，≈ 100 轮 × 12.6ms CPU/轮）
  记在「已回收子进程计数器」上**——2.2s 墙钟里它几乎一直有近一个核在干活（1.981 核·秒 ÷ 2.2s
  ≈ 0.9 核）。旧采样器看不见这笔，peri 的 CU 会从 1.999 虚低到 ~0.74（**会升到第一，比 Codex 的
  0.944 还低**）。这是本项目把「进程树」定为计分口径的直接理由；反过来说，谁的工具调用把活
  甩给子进程、谁自己扛，CU 分得清清楚楚。
- **MiniMax Code 是唯一的「不省，只是快」**：19.7s 里 18.2s 在运转、全程 CPU 97.8%，
  CU 21.511 是第二贵的 dsh 的 8.9 倍、最省的 Codex 的 23 倍。
- 本次测量机器上仍有别的负载（VS Code、终端等，load ≈ 2.9；更早那批是 10.2~16.1），
  绝对读数偏保守；六家在相近条件下测得，横向比较可用，要更干净的数字请在空闲机器上按上节重跑。

## 结果

### 长剧本：100 轮 × 4KB，跑到自然结束（各家 3 次取中位数）

| harness | 端到端 | 启动 → 首个请求 | 首个请求 → 末次请求 | 末次请求 → 退出 | 运转段每轮 | 请求数 | 执行轮数 | CPU 均值 | CPU 峰值 | RSS 均值 | RSS 峰值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pi 0.85.1 | **1.3s** | 0.2s | 1.1s | 0.0s | **11.1ms** | 135 | 100 | 64.8% | 131.6% | 183.1MB | 226.3MB |
| peri 3.17.0 | 2.2s | 0.3s | 1.9s | 0.1s | 18.5ms | 102 | 100 | 32.4% | 43.5% | **55.4MB** | **72.7MB** |
| Claude Code 2.1.277 | 2.2s | 0.3s | 1.8s | 0.0s | 18.4ms | 101 | 100 | 67.0% | 141.5% | 285.2MB | 333.9MB |
| dsh 0.1.5-rc.2 | 3.6s | 0.6s | 3.0s | 0.1s | 30.1ms | 101 | 99 | 46.9% | 150.2% | 190.5MB | 230.0MB |
| Codex 0.155.1 | 16.0s | 0.1s | 5.9s | **10.0s**（零请求） | 58.9ms | 101 | 100 | 3.9% | **25.1%** | 135.4MB | 165.2MB |
| MiniMax Code 0.4.12 | 19.7s | 1.3s | 18.2s | 0.2s | 181.8ms | 101 | 100 | **97.8%** | 182.8% | 618.7MB | 895.6MB |

口径：

- **端到端时长**＝harness 启动到退出（`run.json` 的 `duration.endToEndMs`），比采样窗口多出
  prime 与最后一次采样的间隔；100 轮剧本正文合计约 450KB。
- **三段**＝`run.json` 的 `segments`（`startupMs / spanMs / tailMs`），由 mock 侧记的请求时刻算出。
  末段标「零请求」表示这段里 harness 一个请求都没发（纯等）。
- **运转段每轮** = `spanMs ÷ 执行轮数`，是对「每轮处理链路」的估计，**不含启动与收尾**。
- **执行轮数**＝真正被执行并回传结果的工具调用次数（从 `mock.log` 逐条数的：`消费第 N 条` 的
  请求里带工具结果的那些：chat 协议是 `last=tool`、Codex 是 `last=custom_tool_call_output`、
  Claude Code 末条总缀一条 system（token 余额）所以按「请求数 − 1」算）。
  dsh 被自家标题请求吃掉 1 条（99 轮），pi 用的 133 轮剧本正好跑满 100 轮
  （**注意**：`--turns 130` /131 都只到 99 轮，多出来的条目会被压缩请求吃掉，详见「复现」）。
- **CPU / RSS 为进程树口径**，均值与峰值都取自 `samples.csv`（100ms 一拍）；Codex 主进程只是
  Node 启动器（0.2% / 41.7MB），看进程树才有意义。
- RSS 涨幅（首拍 → 末拍）：MiniMax Code +698MB、Claude Code +251MB、dsh +166MB、pi +118MB、
  Codex +100MB、peri +51MB。其中 Codex 的一大截来自每轮工具子进程（`zsh -lc` + 本机
  `.zshrc` 的 emsdk 初始化，`procs` 列峰值 3），不全等于上下文累积。

读法：

- **pi 的 1.3s 不是漏跑**：mock 侧主循环 100 轮工具调用，末条消息里工具结果确实在（消息数逐轮 +2
  一路涨到 202）；它快在链路短（11.1ms/轮）与历史被自己压过（34 条 `messages=2` 的总结请求）。
  要比较「长会话」形态的话，pi 的这份读数偏乐观——它自己把历史压掉了。
- **Codex 的成本几乎全在「收尾」**：16.0s 里 10.0s 是收尾段，期间**零请求、CPU 归零**（等
  `chatgpt.com` 超时，根因见下）；它跑 100 轮本身只要 5.9s、0.71 CU。要把「一次会话跑很多轮」
  和「反复短会话」分开看：后者的成本几乎全在这笔收尾上。
- **MiniMax Code 的贵在每轮**：181.8ms/轮的运转成本是 Claude Code（18.4ms/轮）的 10 倍、
  pi（11.1ms/轮）的 16 倍，CPU 均值 97.8%（全程占满一个核）、RSS 峰值 895.6MB；它的瓶颈不在
  启动（1.3s，六家里最慢），而在每轮的处理链路。
- **dsh 的启动 0.6s** 在六家里排第二（仅次于 MiniMax Code 1.3s），端到端 3.6s——没有 Codex
  那样的收尾等待，运转段 30.1ms/轮 比 Claude Code 的 18.4ms/轮 贵约六成。

### MiniMax Code（`mcode`）：本批起并入常规批次

`mcode exec`（`@minimax-ai/code` 0.4.12 的无头模式，走 OpenAI Chat Completions）上一轮是单独连跑的，
**本批起与其余五家同批串跑**，所以上面两张表里都有它；接入细节见 `CLAUDE.md` 的「与 harness 集成」。
本批三次读数（19.6s / 19.7s / 20.2s，CU 21.29 / 21.51 / 22.06）几乎重合，下面读数取中位那次（19.7s）：

- **端到端 19.7s（启动 1.3s · 运转 18.2s · 收尾 0.25s）**：没有 Codex 那种固定收尾等待，
  慢在「每一轮都在满速吞吐」而不是启动或收尾；
- **消费规律是六家里最干净的**：100 轮剧本实收 **101 条 = 100 轮 + 尾部那条收尾**，没有标题生成、
  没有上下文压缩、没有预测请求（对比：pi 要 135 条剧本，dsh 的标题请求吃掉第 2 条）；
- **它是这份名单里最费资源的**：进程树 CPU 均值 **97.8%**（几乎全程占满一个核）、RSS 峰值
  **895.6MB**、CU **21.511**——第二贵的 dsh 才 2.431、最省的 Codex 是 0.944，
  **它不省，只是快**；
- 启动时会刷新模型目录（`models.dev/api.json` → `filecdn.minimax.chat`，落沙盒 `cache/` 下 4.7MB），
  不经过 mock，但给启动段带了 1.3s（六家里最慢）——跨机器比启动时长时要留意。

## 统一计分（**Beta**）：把 CPU 与内存混成一个数（CU，阿里云 FC 口径）

> **状态：Beta（2026-09-19 起试行）**。系数是借来的、实现（逐拍积分 / 后代取大 / 尾部补齐）都有
> 验证，但**这套口径本身还没定稿**：「后代 CPU 算不算 harness 的开销」「时长该按端到端还是按
> 可控执行时长」仍在讨论。所以下面的排名是**候选口径下的读数**，不是对 harness 的裁决——看趋势、
> 拆账可以，别把名次当结论。口径与系数只在 `scripts/perf/score.ts` 一处（文件头也标了 Beta），
> 本节只是读数；要改口径就改那处 + 重跑一个完整批次。

比时长、比内存都回答不了「谁更省」：pi 只跑 1.3s 但全程满速，Codex 跑 16.0s 却有 10.0s 是零 CPU
空等。要一个标量就得先有一套**不是我们拍的**权重，于是借阿里云函数计算（FC）的 CU
（Compute Unit）折算系数——它把 CPU、内存、调用次数按系数折成同一个单位再加总
（2026-09-19 核对官方计费文档；FC 的计费口径是「规格 × 时长」，正好对应我们关心的问题）：

```
CU使用量 = ∑(资源使用量 × CU转换系数)
弹性实例（活跃）：vCPU 1.0 CU/(vCPU·秒) · 内存 0.15 CU/(GB·秒)
                  调用次数 75 CU/万次（= 0.0075 CU/次） · 磁盘 0.05 CU/(GB·秒)
```

映射到本项目的采样数据（`samples.csv` 是按拍读数，时间积分把**时长**也算进去）：

```
核·秒 = ∫(tree_cpu_pct / 100) dt      GB·秒 = ∫(tree_rss_kb / 2^20) dt
CU    = 1.0 × 核·秒 + 0.15 × GB·秒
分数  = 100 × 本批次最小 CU / 本次 CU        （最优 100 分，越贵越低）
```

口径与实现只在 **`scripts/perf/score.ts`** 一处：`run.json` 的 `cost` 字段、`perf.log` 末尾那行
摘要、图表页的计分表都从那儿来。下表与上一节的「结果」是**同一批运行**：

| harness | CU | 分数 | 核·秒 | GB·秒 | 内存项占 CU | 后代 CPU | 启动 / 运转 / 收尾 CU（各自积分） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex 0.155.1 | **0.944** | **100.0** | 0.627 | 2.117 | 34% | 0.602（采样） | 0.000 / 0.713 / 0.229 |
| pi 0.85.1 | 1.067 | 88.5 | 1.031 | 0.235 | 3% | 0.192（计数） | 0.133 / 0.857 / 0.000 |
| peri 3.17.0 | 1.999 | 47.2 | 1.981 | 0.121 | 1% | 1.264（计数） | 0.186 / 1.722 / 0.000 |
| Claude Code 2.1.277 | 2.114 | 44.7 | 2.021 | 0.618 | 4% | 0.556（计数） | 0.215 / 1.820 / 0.000 |
| dsh 0.1.5-rc.2 | 2.431 | 38.8 | 2.330 | 0.673 | 4% | 0.662（计数） | 0.510 / 1.869 / 0.000 |
| MiniMax Code 0.4.12 | 21.511 | 4.4 | 19.722 | 11.929 | 8% | 0.419（计数） | 1.225 / 19.880 / 0.255 |

与 FC 的**四处刻意偏差**（都在 `score.ts` 的文件头写着）：

1. **内存用实测 RSS**，不是 FC 的「申报规格 × 时长」——我们只有实测值，实测也更公平；
2. **不含磁盘项**（无数据）与 **GPU 项**（本项目不采 GPU）；
3. **调用次数项单列**（`callCu`）不计入总分——请求数由剧本决定，不是 harness 的开销。
   本批次五家 101~102 次、pi 135 次，折 0.757~1.013 CU；若计入，pi 会因为「自己多发了 34 条
   压缩请求」被额外罚分，而那是它的策略选择、不是「跑完这部剧本」的必要资源，故只单列；
4. 时长是**自然结束的端到端时长**，不是 FC 那种可控执行时长。

怎么读：

- **它答的是「跑完同一部剧本烧掉多少资源」，不是「谁先跑完」**：Codex 端到端最慢（16.0s）
  却最省（0.944 CU）——那 10.0s 是零 CPU 的纯空等；反过来 pi 1.3s 就跑完，却比 Codex 贵 13%
  （1.067 vs 0.944），因为它从启动到退出一直是满速。要「响应快」看端到端，要「成本低」看 CU，
  两者不是一回事。
- **内存项在大户身上才咬人**：六家里内存项占比 1%~34%（Codex 那 34% 是因为它的 CPU 项太小——
  0.627 核·秒里还有 0.602 是子进程干的；它带着 130~165MB 常驻内存耗了 16 秒，内存项自然顶上来；
  绝对量最大的是 MiniMax Code 的 11.929 GB·秒，是 pi 的 51 倍）。CPU 项始终是大头——这也是为什么
  「RSS 峰值」单独看会误导：峰值只出现一瞬，计分关心的是**面积**。
- **分数是批内相对值**：`100 × 最小 CU / 本次 CU`，换一批运行（机器负载、剧本、被比较的对手
  不同）分数就会变。**跨批次只比 CU**，别比分数。
- **后代 CPU 取「已回收子进程计数器」与「采样到的后代」的较大者**（`child_cpu_from` 写明取自
  哪一路），不求和：两条路都是真值的下界且可能重叠（被看见过的子进程之后被回收，同一段 CPU
  会在计数器里再出现一次，实测相加会多算 136%）。本批六家都记到了后代（peri 1.264 核·秒最大，
  占它自己总 CPU 的 64%——每轮工具调用拉起的 shell；Codex 的 0.602 取自「采样到的后代」，
  它的活确实是原生二进制干的）。
- **末拍 → 退出的空档要补**：采样循环读到「进程不在了」就停，最后一拍到真正退出还差约一个
  采样间隔（实测 ≈100ms），不补的话 pi 这种 1.3s 的快 harness 会漏计约 8%。本批六次都是当前
  采样器的产物，`score.tailGapKnown` 与 `childColumnPresent` 全为 true（每笔都按末尾三拍的
  速率外推补了 ~100ms），所以**这一节的 CU 不是下界**——更早那批老产物才是（那时两列都缺）。
- **CU 是「逐拍累加」出来的**：`核·秒 = Σ(每拍 CPU% ÷ 100 × 该拍实测间隔)`、`GB·秒` 同理
  （`samples.csv` 100ms 一拍，间隔按实际时间戳差分，间隔不齐也不会算歪），**不是「均值 × 时长」
  那种估法**。表里那列「启动 / 运转 / 收尾 CU」是**同一口径的分段积分**（三段各自逐拍算），
  与总分的差只有一笔：**尾部补齐只进总分**（本批 0.002~0.15 CU，占各家 0.2%~7%）——采样点在三段
  之间首尾相接、不重不漏，六家实测「三段之和 + 尾部补齐 = 总分」逐笔成立。后代 CPU 的「取较大者」
  同理在整段上取一次、不逐段取（逐段取会在段边界上把同一段子进程 CPU 重复计）。分段是拿来看
  「钱花在哪一段」的，**不是三段相加**。

采样侧的两个新口径（`scripts/perf/sampler.ts`）：`child_cpu_pct` 是父进程 rusage 里
`ri_child_user_time` / `ri_child_system_time` 的差分（**已回收子进程**的累计 CPU，实测钉死了
偏移 96/104 与「单位是 Mach tick 不是纳秒」）；它与 `tree_cpu_pct`（进程表里看得见的后代）
是两套互补的下界，**不能相加**，计分时取较大者。

## 逐家的收尾与辅助请求（本批次实测）

| harness | 收尾段 | 收尾段里有请求吗 | 辅助请求（本批次实测） |
| --- | --- | --- | --- |
| peri | 0.09s | 无 | 1 条「预测下一步输入」（主流程收尾**之后**才发，吃的是尾部那条空白、不占轮次） |
| Codex | 10.03s | 无（等 `chatgpt.com` 超时） | 无 |
| Claude Code | 0.04s | — | 无 |
| dsh | 0.06s | — | 1 条「会话标题生成」（`messages=2`，吃掉第 2 条剧本） |
| pi | 0.03s | — | 34 条压缩总结（第 70 轮起每轮一条，吃掉 34 条剧本） |
| MiniMax Code | 0.25s | — | 无 |

- **peri 的 5s 是等一个 Prediction 后台任务的收尾宽限期（根因已查明，默认剧本已消掉）**：
  收尾段此前多次实测都是 5.0~5.1s，与轮数无关（1 轮探针同样是 5.0s）；静默期 CPU 0%、无子进程、
  主线程停在 `pthread_cond_wait`、没有任何对外 socket，`--bare` 不消、**把 mock 杀掉也不消**。
  后续读 peri 源码 + 抓栈定位到：`-p` 退出时 host 用硬编码 5s 的 cooperative_grace 等
  host-owned 任务，卡住的是 `HostTaskKind::Prediction`——「预测下一步输入」拿到**非空**文本后
  回落成 Placeholder 动作、一路走到写 session 标题那步就停住（日志停在该任务打出
  「Prediction ready, sending notification」之前，大概率是与关闭流程争 session 锁），
  直到超时被 abort：日志里 `aborting host-owned task owner=Session kind=Prediction` 与预测完成
  的间隔正好 5.0015s。
  **peri 侧一度说这是 langfuse 环境变量导致的等待，实测不成立**：本机没有任何 `LANGFUSE_*`，
  代码也要求 `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` 双 key 同时存在才启用
  （`from_env()`，唯一初始化点在 `peri-acp/src/host/assemble.rs`），退出期的 `lsof` 更是一条
  对外连接都没有；推测那个说法来自 langfuse 客户端里恰好也是 5s 的 `connect_timeout`。
  **消掉的办法**：给预测请求一条**空白**响应——`execute_prediction` 见文本 trim 后为空，在拿锁
  之前就返回空动作，5s 直接归零（对照实测：空白 2150 / 2110 / 2149ms vs 非空收尾文本 7096ms，
  差 4.95s、完全可复现）。长剧本生成器已把「收尾文本 + 空白」两条固定写进尾部（顺序不可反），
  端到端 7.7s → 2.2s、收尾 5.0s → 0.09s（本批实测）；要复现旧读数就把尾部那条空白删掉。
  根治仍得靠 peri 侧（给那把锁加超时，或关闭时拒绝 prediction 写 session）。
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
- **pi 的压缩**：上下文到阈值 → 发一条总结请求 → 用摘要开新对话，每轮一条（渐进式，本批 34 条）。
  **它同样消费剧本条目**，编排剧本时要按「主循环轮数 + 压缩请求数」留足余量，
  否则主循环跑不满预期轮数。

## 读数怎么读（别踩的坑）

- **长剧本的「时长」含启动与收尾**，这是刻意的：端到端就该含。但要拆开看——`run.json` 的
  `segments` 把 启动 / 运转 / 收尾 三段分开，**Codex 的成本九成在收尾**（peri 那笔已经被剧本
  尾部的空白收尾条消掉：本批收尾 0.09s），别按总时长除以 100 去算「每轮成本」。
- **收尾段读数的两个坑**：一是它可能包含 harness 自己的固定等待（peri 曾有 5.0s，默认剧本已消掉；
  Codex 10.0s，与轮数无关），二是其中可能有**本机网络环境的成分**（Codex 那 10s 就是在等
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
  工具调用都要新起一个 `/bin/zsh -lc`，而这台机器的 `.zshrc` 里还有 emsdk 初始化；MiniMax Code
  每轮自己的处理链就要 ~180ms）。要比单位成本就用「运转段每轮」那一列。
- **进程树包含工具调用的子进程**：`samples.csv` 的 `procs` 列能看到进程数波动（本批次 peak：
  Codex 3、MiniMax Code 2，其余 1）；RSS 的涨幅里混着工具子进程的固定占用，别全记到上下文累积上。
- **peri 被强杀时 `harness.log` 是空的**（`-p` 模式只在自行退出时 flush），属已知限制；
  长剧本下它自行退出，所以日志完整。pi 同理。
- **首次运行与后续运行的温差**：本批次跑在各家沙盒状态已预热的情况下（会话库、缓存都在），
  冷启动读数会比这里更高；轮次之间没有清沙盒缓存，六家一视同仁。
- 想看逐拍曲线直接读 `data/runs/<harness>/<runId>/samples.csv`
  （`ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs,child_cpu_pct`），或看下一节的
  图表页；采样口径的验证实验见 `bun run scripts/perf/verify.ts`。
  同一目录的 `run.json` 里还有 `cost`（统一计分的那一整笔账，逐项摊开）。

## 图表页

`docs/perf-chart.html` 是个静态页，**打开先看到统一计分表**（标着 **Beta** 的候选口径：CU /
分数 / 核·秒 / GB·秒 / 三段拆账，公式直接印在页面上，按 CU 升序排）；往下才是折线图——画各家的逐拍曲线
（X = 时间，Y 可切 RSS / CPU、主进程 / 进程树），图上带请求分界线（首个与末次请求）。
数据来自仓库根的 `data/perf-chart.json`（页面按 `../data/perf-chart.json` 取；由 `gen-chart-data.ts`
从 `data/runs/` 里挑一次运行导出的精简载荷；计分是**现算**的，所以新老产物同口径可比）。
**opencode 的线默认收起、不参与 X 轴定标**（已退出排名，见开头）：在图例里点一下可展开看它的
历史读数，展开时是一条虚线、横轴会自动延伸到 38.6s。

曲线默认按 **1s 窗口做滑动平均**（页面上可切原始 / 0.5s / 1s / 2s）：100ms 采样下多线程
harness 的 CPU 是真实的锯齿（几拍突发、几拍归零），不平滑就只剩毛刺——本批数据里相邻两拍
跳 30 个百分点以上的有 MiniMax Code 14 处、Claude Code 4 处、dsh 3 处、pi 1 处
（peri / Codex 各 0 处），1s 窗口后全部降到 0 处。
平滑只改画法，`samples.csv` 与页面汇总表里的均值 / 峰值始终是原始读数。

图上另有两条读图约定：**每条线的峰值标出 harness 名**（CPU 与内存都标，标的是画出来的那条线，
所以峰值跟着平滑窗口走），以及**内存的纵轴是反的**（0 在顶、占用越大越靠下，方向与「内存变重」
一致）；CPU 轴仍是正常方向。

```sh
bun run scripts/perf/gen-chart-data.ts --exclude opencode   # 本批：每个 harness 取最近 3 次里居中的一次
bun run scripts/perf/gen-chart-data.ts --pick 20260919-184618 --pick 20260919-184831 …   # 或显式点名
cd <仓库根> && python3 -m http.server 8080        # 页面用 fetch 读 JSON，file:// 会被 CORS 挡
# → http://localhost:8080/docs/perf-chart.html
```

Chart.js 先试 unpkg 的 CDN（`chart.js@4`）**2s 超时**，拿不到就换仓库里的
`docs/vendor/chart.umd.min.js`（该目录已 gitignore，换机器可能没有）：本机浏览器走 PAC 代理
实测公共 CDN 不是报错而是挂着不动，所以超时是必需的、页面也不能用静态 script 标签去取它
（实测无头加载时卡在 CDN 上，页面根本不渲染）。**兜底才是常态路径**。页面不需要构建，
改 JSON 刷新即可。
