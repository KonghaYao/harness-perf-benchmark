# 压测对比：六种 harness（opencode 已退出排名）

> **opencode 已退出排名（2026-09-19 起）**
>
> 它是唯一**各项指标都远落后**的一家（退出排名时的实测：端到端 **38.6s**，同一批其余五家
> 1.5~19.9s；进程树 **CPU 均值 69.9% / 峰值 229.3%**，两项都最高；进程树 **RSS 均值 798.9MB /
> 峰值 943.0MB**，第二高的 Claude Code 才 274.9 / 321.9MB，差 2.9 倍）。按「端到端 × CPU 均值」
> 粗估整段消耗约 **27 核·秒**，其余五家在 1.0~5.0 核·秒——同跑一份 100 轮剧本，它烧掉的是别人的
> 5 倍以上。
>
> 继续把它放进榜单只会拉长横轴、把其余各家压成一堆，它也已不构成有意义的对照，因此**后续批次
> 不再跑 opencode、不计入排名**，下面的表格里也没有它（各家读数都出自同一批次，混进一份隔了
> 几小时的旧产物就破坏了「批内可比」）。`playground/opencode/` 的沙盒与接入代码保留（想复测随时
> 可按下面的命令单跑，`scripts/perf/harness-id.ts` 里的别名也还在），它的历史产物仍在
> `data/runs/opencode/`——图表要显示它，生成数据时不加 `--exclude opencode` 即可。

用 llm-mock 以受控负载测量各 harness 自身的资源开销。测量时间 **2026-09-19 20:39~20:43**（第五批；
机器 macOS / Apple Silicon 18 核），采样间隔 100ms（`proc_pid_rusage`，CPU 为**单核 100%** 口径，
不采 GPU）。本文读数全部出自这一批——跑批统一带 `--label codex-proxy-fix`，六家 × 3 次串行，
共 18 次运行、**2 分 50 秒**跑完。

**这一批是为了让 Codex 的修复落地成读数才重跑的**：Codex demo 消掉了「退出时等 `chatgpt.com`
超时」那笔固定开销（只给 harness 及其子进程注入指向死端口的 HTTPS 代理，根因与验证见「逐家的
收尾与辅助请求」），它的端到端与 CU 都会变，只能整批重来。与上一批（19:50~19:54，`cu-1to1`）
对照：**Codex 端到端 16.4s → 6.1s、收尾 10.06s → 0.04s、CU 3.294 → 1.383、名次从第四升到第二**。
这一批的机器也明显更空（`load average` 全程 **2.9~3.8**，上一批是 4~17），所以**各家的绝对时长
与 CU 普遍低于上一批**（pi 1.6 → 1.3s、peri 2.8 → 2.2s、Claude Code 2.6 → 2.2s、MiniMax Code
21.1 → 19.9s）——跨批次**只比结构与名次，别把两批的秒数直接相减**。

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
**跨批次别比绝对时长**：更早那批是在 load 10~16 下测的，同样一台机器、同一份剧本，端到端能差
2~4 倍（本批 load 2.9~3.8，peri 2.2s、dsh 3.8s；而 CPU 满载的 MiniMax Code 对负载最敏感）。

## 复现

### 长剧本端到端（100 轮 × 4KB，跑到自然结束）

剧本由生成器造：100 轮「约 4KB 正文 + 一次工具调用」，**尾部另带两条收尾条**——一条「任务结束」纯文本
（`finish_reason=stop`，harness 收到即自行收尾退出）+ 一条空白响应（给 peri 的「预测下一步输入」，
消掉它固定 5.0s 的收尾等待，机制见「逐家的收尾与辅助请求」）。本批读数就是带着这两条取的
（peri 的收尾因此只剩 0.07s）；不带时靠 mock 的 `--exhausted stop` 兜最后一条，
peri 会吃到非空预测文本、白等 5s。
于是端到端时长就是「启动 → 跑完 100 轮 → 退出」，`--timeout-ms` 只是兜底（正常不该触发）。

摘要里会把这段时长**拆成三段**（靠 mock 侧记的请求时刻，与 harness 起止同机同时钟）：

```
时长分段: 启动 → 首个请求 X ｜ 首个请求 → 末次请求 Y ｜ 末次请求 → 退出 Z（收尾零请求：…）
```

第三段是「harness 已经不发请求、但进程还没退」的**收尾等待**——实测这条极有信息量：
Codex 的「固定开销」原来几乎全在这里（10.06s），本批已由 demo 的代理注入消到 0.04s（见下节）；
peri 那笔 5.0s 的收尾等待则早被剧本尾部的空白收尾条消掉，本批 0.07s。

```sh
# 生成剧本（工具形状按各家实测；**pi 那份要 133 轮**，理由见下）
bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json   # peri / Claude Code 共用
bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
bun run scripts/perf/gen-long-run.ts --turns 133 --tool bash --out data/scenarios/long-run-pi.json
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --args command+description \
  --out data/scenarios/long-run-dsh.json
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash \
  --out data/scenarios/long-run-minimax-code.json   # mcode：bash + {command}，100 条够跑满 100 轮

cd playground/peri        && bun perf-demo.ts --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000 --turns 100 --label codex-proxy-fix
cd playground/opencode    && bun perf-demo.ts --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/claude-code && bun perf-demo.ts --script data/scenarios/long-run.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/codex       && bun perf-demo.ts --script data/scenarios/long-run-codex.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/pi          && bun perf-demo.ts --script data/scenarios/long-run-pi.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/deepseek    && bun perf-demo.ts --script data/scenarios/long-run-dsh.json \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix
cd playground/minimax-code && bun perf-demo.ts \
  --exhausted stop --timeout-ms 1800000 --label codex-proxy-fix   # 默认剧本就是 long-run-minimax-code.json
```

- 上面的 `--script` 是各家的默认剧本（demo 自己带的那份），写出来只为显式；路径按仓库根解析，
  所以在 `playground/<名>/` 里跑也没问题。
- **每家的 3 次**：同一条命令连跑 3 次（本批六家 × 3 轮串行共 2 分 50 秒），跑批时统一带
  `--label <批次名>` 便于按批筛产物；读数取**端到端时长居中的那一次**（`gen-chart-data.ts --window 3`
  是同一口径），别把不同批次的运行混进同一张表。
- `--turns 100` 是防呆：peri 3.17 在 `-p` 模式下虽然忽略 `--max-turns`，但真生效时默认值 25
  会把剧本拦腰截断（其余各家没有等价的轮数参数，靠剧本耗尽收尾）。它与生成器的同名参数不同义：
  生成器的 `--turns` 是剧本轮数，这里传给 demo 的是 harness 的 `--max-turns`。
- **pi 那份为什么要 133 轮**：pi 从上下文约 140 条消息起开始**自动压缩**（`compaction.enabled`
  默认 true，`reserveTokens` 16384 / `keepRecentTokens` 20000），压缩期每轮追加一条
  `messages=2` 的总结请求，同样消费剧本条目。100 条剧本下它只跑到第 84 轮就耗尽了（第 70 轮起
  「总结 + 主请求」交替取号）。生成器给尾部那两条收尾（见上）会再占掉一条，**实测 132 条
  （`--turns 130`）只跑到 99 轮、133 条仍是 99 轮、135 条（`--turns 133`）才正好 100 轮**
  （那些多出来的条目全被压缩请求吃掉）——所以这份剧本是 133 轮 = 135 条。

产物落在 `data/runs/<harness>/<runId>/`：`run.json`（机器接口：身份 / 时间线 / 分段 / 摘要 /
**统一计分 `cost` 与峰值 `peaks`** / 退出码）+ `perf.log`（人读时间线）+ `samples.csv`
（逐拍采样，含 `child_cpu_pct`）+ `harness.log` / `mock.log`。本批六家各跑 **3 次**
（`--label codex-proxy-fix`，共 18 次运行），下面所有读数取自**端到端时长居中的那一次**：

```
peri 20260919-204152 · dsh 20260919-204208        · minimax-code 20260919-204129
claude-code 20260919-204027 · codex 20260919-204120 · pi 20260919-204157
```

看逐拍曲线：`bun run scripts/perf/gen-chart-data.ts --exclude opencode`（不给 `--pick` 时每个
harness 自动取最近 3 次里时长居中的那一次，也就是上表这 6 个 runId）生成
`data/perf-chart.json`，再用静态服务器打开 `docs/perf-chart.html`（见文末「图表页」）。

## 结论速览

- **端到端：pi 1.3s ≈ Claude Code 2.2s ≈ peri 2.2s < dsh 3.8s < Codex 6.1s ≪ MiniMax Code 19.9s**。
  它与「谁轻」不是一回事：Codex 每轮要 59.8ms（六家里只有 MiniMax Code 比它慢），端到端也排第二慢，
  但整段 CU 只比 pi 贵一点。
- **统一计分（CPU 与内存 1:1，**Beta**）：pi 1.271 CU（100 分）＜ Codex 1.383（91.9）＜ peri 2.102（60.5）
  ＜ Claude Code 2.828（45.0）＜ dsh 3.101（41.0）≪ MiniMax Code 31.995（4.0）**。
  **Codex 升到第二是这一批修复的直接结果**：上一批它的 CU 里 53% 是退出时那 10s 空等（收尾段
  1.760 CU，全程顶着约 160MB 内存）；消掉后只剩 1.383 CU，与 pi 差 0.11。
- **pi 的 1.3s 是真跑满 100 轮**（135 条请求 = 100 轮工具调用 + 34 条压缩总结 + 1 条初始），
  11.2ms/轮是六家里最便宜的；代价是**自动压缩**：多发了 34 条总结请求（见下）。
- **本批的固定成本已经很小**：六家启动 0.10~1.22s、收尾 0.02~0.23s（Codex 修完 0.04s、peri 0.07s），
  **时间几乎全花在运转段**——最慢的 MiniMax Code 启动 1.22s 是它在启动期刷模型目录。
- **单看 CPU 均值 / RSS 峰值会读歪**：MiniMax Code 全程占满一个核（CPU 均值 98.1%、RSS 峰值
  892.0MB），peri 只要 32.6% / 71.7MB，Codex 10.5% / 163.7MB——可 Codex 的「低 CPU」是因为真干活的
  是它 spawn 的原生二进制（0.618 核·秒记在「采样到的后代」上），peri 的「低 CPU」是因为它每轮拉起的
  shell 会被回收（1.261 核·秒记在子进程计数器上）。**这两个数都答不了「跑完烧掉多少资源」**。
- **peri 第三，是被它自己拉起的 100 个 shell 顶上来的**：它主进程 CPU 均值只有 32.6%，可每轮工具调用
  都要 spawn 一个进程，**1.261 核·秒（占总 CPU 的 64%，≈ 100 轮 × 13ms CPU/轮）记在「已回收子进程
  计数器」上**——2.2s 墙钟里它几乎一直有近一个核在干活（1.983 ÷ 2.2 ≈ 0.9 核）。旧采样器看不见这笔，
  peri 的 CU 会从 2.102 虚低到 ~0.84（0.722 + 0.119），**比 pi 还低、直接升到第一**。
  这是本项目把「进程树」定为计分口径的直接理由；反过来说，谁的工具调用把活甩给子进程、
  谁自己扛，CU 分得清清楚楚。
- **内存随轮次上涨是预期**：每轮都把历史（上一轮的正文 + 工具结果）随请求回传，RSS 里既有渲染
  缓冲也有会话累积（100 轮剧本正文合计约 450KB，末轮请求体与它同量级；pi 因为压缩过所以短得多）。
  本批首拍 → 末拍（进程树）的涨幅：peri +49MB、pi +106MB、Codex +119MB、dsh +173MB、
  Claude Code +206MB、MiniMax Code +696MB。
- **别把「请求数」当「轮数」**：mock 请求数里混着各家自己的辅助请求——本批次实测 peri 1 条
  （「预测下一步输入」，吃的是剧本尾部那条空白、不占轮次）、dsh 1 条（会话标题生成，吃掉第 2 条剧本）、
  pi 34 条（压缩总结）；Claude Code / Codex / MiniMax Code 本次没有。
  **辅助请求会吃掉剧本条目**，所以 dsh 实收 99 轮工具调用；pi 那份剧本按 133 轮生成（135 条），
  才换来正好 100 轮（见「复现」）。
- **MiniMax Code 是唯一的「不省，只是快」**：19.9s 里 18.5s 在运转、全程 CPU 98.1%，
  CU 31.995 是第二贵的 dsh 的 10.3 倍、最省的 pi 的 25.2 倍。
- **peri 在「轻」这一点上没有争议**：内存面积 122 MB·秒、峰值 71.7MB 都是六家里最小的，
  CPU 峰值 43.7% 是唯一没超过单核的（它贵在 CPU 积分——100 轮工具 shell 的账）。
- 本次测量机器负载 2.9~3.8（比上一批的 4~17 干净），六家在相近条件下测得，横向比较可用，
  要更干净的数字请在空闲机器上按上节重跑。

## 结果

### 长剧本：100 轮 × 4KB，跑到自然结束（各家 3 次取中位数）

| harness | 端到端 | 启动 → 首个请求 | 首个请求 → 末次请求 | 末次请求 → 退出 | 运转段每轮 | 请求数 | 执行轮数 | CPU 均值 | CPU 峰值 | RSS 均值 | RSS 峰值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pi 0.85.1 | **1.3s** | 0.18s | 1.12s | 0.02s | **11.2ms** | 135 | 100 | 65.5% | 128.8% | 186.2MB | 234.4MB |
| Claude Code 2.1.277 | 2.2s | 0.19s | 1.96s | 0.06s | 19.6ms | 101 | 100 | 71.8% | 122.4% | 310.9MB | 351.0MB |
| peri 3.17.0 | 2.2s | 0.30s | 1.85s | 0.07s | 18.5ms | 102 | 100 | 32.6% | **43.7%** | **54.7MB** | **71.7MB** |
| dsh 0.1.5-rc.2 | 3.8s | 0.76s | 2.99s | 0.07s | 30.2ms | 101 | 99 | 46.3% | 128.0% | 185.6MB | 231.2MB |
| Codex 0.155.1 | 6.1s | 0.10s | 5.98s | **0.04s** | 59.8ms | 101 | 100 | **10.5%** | **26.0%** | 123.4MB | 163.7MB |
| MiniMax Code 0.4.12 | 19.9s | 1.22s | 18.47s | 0.23s | 184.7ms | 101 | 100 | **98.1%** | 177.8% | 617.6MB | 892.0MB |

口径：

- **端到端时长**＝harness 启动到退出（`run.json` 的 `duration.endToEndMs`），比采样窗口多出
  prime 与最后一次采样的间隔；100 轮剧本正文合计约 450KB。Claude Code 与 peri 都记作 2.2s，
  实为 2219 / 2221ms（同一档，表里不刻意分先后）。
- **三段**＝`run.json` 的 `segments`（`startupMs / spanMs / tailMs`），由 mock 侧记的请求时刻算出。
- **运转段每轮** = `spanMs ÷ 执行轮数`，是对「每轮处理链路」的估计，**不含启动与收尾**。
- **执行轮数**＝真正被执行并回传结果的工具调用次数（从 `mock.log` 逐条数的：`消费第 N 条` 的
  请求里带工具结果的那些：chat 协议是 `last=tool`、Codex 是 `last=custom_tool_call_output`、
  Claude Code 末条总缀一条 system（token 余额）所以按「请求数 − 1」算）。
  dsh 被自家标题请求吃掉 1 条（99 轮），pi 用的 133 轮剧本正好跑满 100 轮。
- **CPU / RSS 为进程树口径**，均值与峰值都取自 `samples.csv`（100ms 一拍）；Codex 主进程只是
  Node 启动器（CPU 均值 0.1%、RSS 均值 41.7MB，末拍也是 41.7MB），看进程树才有意义。
- RSS 涨幅（首拍 → 末拍，进程树）：MiniMax Code +696MB、Claude Code +206MB、dsh +173MB、
  Codex +119MB、pi +106MB、peri +49MB。其中 Codex 的一大截来自每轮工具子进程（`zsh -lc` + 本机
  `.zshrc` 的 emsdk 初始化，本批 `procs` 列峰值 **3**），不全等于上下文累积。

读法：

- **pi 的 1.3s 不是漏跑**：mock 侧主循环 100 轮工具调用，末条消息里工具结果确实在；它快在链路短
  （11.2ms/轮）与历史被自己压过（34 条 `messages=2` 的总结请求）。要比较「长会话」形态的话，
  pi 的这份读数偏乐观——它自己把历史压掉了。
- **Codex 的 6.1s 是实打实的运转**：修复后收尾只剩 0.04s，5.98s 全在运转段（59.8ms/轮，六家里
  仅次于 MiniMax Code）——它慢在每轮都要新起 `/bin/zsh -lc`（本机 `.zshrc` 还带 emsdk 初始化），
  不是慢在收尾。修复前的 10.06s 收尾等待属本机 DNS 污染，见「逐家的收尾与辅助请求」。
- **MiniMax Code 的贵在每轮**：184.7ms/轮的运转成本是 Claude Code（19.6ms/轮）的 9.4 倍、
  pi（11.2ms/轮）的 16.5 倍，CPU 均值 98.1%（全程占满一个核）、RSS 峰值 892.0MB；它的瓶颈不在
  启动（1.22s，六家里最慢），而在每轮的处理链路。本批它的三次很稳（19.1 / 19.9 / 20.0s），
  不再有上一批那种负载尖峰下的散点。
- **dsh 的启动 0.76s** 在六家里排第二（仅次于 MiniMax Code 1.22s），端到端 3.8s——运转段
  30.2ms/轮 比 Claude Code 的 19.6ms/轮 贵约五成。

## MiniMax Code（`mcode`）：常规批次的一员

`mcode exec`（`@minimax-ai/code` 0.4.12 的无头模式，走 OpenAI Chat Completions）从上一批起与其余五家
同批串跑，接入细节见 `CLAUDE.md` 的「与 harness 集成」。本批三次读数（19.1s / 19.9s / 20.0s，
CU 30.42 / 31.99 / 32.15），下面取中位那次（19.9s）：

- **端到端 19.9s（启动 1.22s · 运转 18.47s · 收尾 0.23s）**：没有 Codex 那种固定收尾等待，
  慢在「每一轮都在满速吞吐」而不是启动或收尾；
- **消费规律是六家里最干净的**：100 轮剧本实收 **101 条 = 100 轮 + 尾部那条收尾**，没有标题生成、
  没有上下文压缩、没有预测请求（对比：pi 要 135 条剧本，dsh 的标题请求吃掉第 2 条）；
- **它是这份名单里最费资源的**：进程树 CPU 均值 **98.1%**（几乎全程占满一个核）、RSS 峰值
  **892.0MB**、CU **31.995**——第二贵的 dsh 才 3.101、最省的 pi 是 1.271，
  **它不省，只是快**；
- 启动时会刷新模型目录（`models.dev/api.json` → `filecdn.minimax.chat`，落沙盒 `cache/` 下 4.7MB），
  不经过 mock，但给启动段带了 1.22s（六家里最慢）——跨机器比启动时长时要留意。

## 统一计分（**Beta**）：CPU 与内存 1:1

> **状态：Beta（2026-09-19 起试行）**。系数是本项目定的、实现（逐拍积分 / 后代取大 / 尾部补齐）
> 都有验证，但**这套口径本身还没定稿**：「后代 CPU 算不算 harness 的开销」「时长该按端到端还是按
> 可控执行时长」仍在讨论。所以下面的排名是**候选口径下的读数**，不是对 harness 的裁决——看趋势、
> 拆账可以，别把名次当结论。口径与系数只在 `scripts/perf/score.ts` 一处（文件头也标了 Beta），
> 本节只是读数；要改口径就改那处 + 重跑一个完整批次。

比时长、比内存都回答不了「谁更省」：pi 跑得最快（1.3s）却平均常驻 186.2MB，peri 多花 0.9s 却只用
54.7MB；Codex 每轮最贵（59.8ms）却因为只跑 6 秒而挤进第二。要一个标量，公式结构借阿里云函数计算
（FC）的「CU使用量 = ∑(资源使用量 × CU转换系数)」——它把 CPU、内存按系数折成同一个单位再加总，
正好对应我们要问的问题。FC 弹性实例（活跃）的系数表（2026-09-19 核对官方计费页）是：

```
CU使用量 = ∑(资源使用量 × CU转换系数)
弹性实例（活跃）：vCPU 1.0 CU/(vCPU·秒) · 内存 0.15 CU/(GB·秒)
                  调用次数 75 CU/万次（= 0.0075 CU/次） · 磁盘 0.05 CU/(GB·秒)
```

**本项目只借它的公式结构，系数自己定：CPU 与内存逐秒同价（1:1）**——

```
CU    = 1.0 × 核·秒 + 1.0 × GB·秒
核·秒 = ∫(tree_cpu_pct / 100) dt      GB·秒 = ∫(tree_rss_kb / 2^20) dt
分数  = 100 × 本批次最小 CU / 本次 CU        （最优 100 分，越贵越低）
```

映射到采样数据时那个 `∫` 是**逐拍累加**（100ms 一拍，间隔按实际时间戳差分），不是「均值 × 时长」
的估法；内存面积在下面按 **MB·秒** 显示（`GB·秒 × 1024`）——换显示单位不改口径。与 FC 的**四处
刻意偏差**（都在 `score.ts` 的文件头写着）：

1. **系数不是 FC 的 0.15**：本项目按「资源负担」读，CPU 与内存同价（理由见下）；
2. **内存用实测 RSS**，不是 FC 的「申报规格 × 时长」——我们只有实测值，实测也更公平；
3. **不含磁盘项**（无数据）与 **GPU 项**（本项目不采 GPU）；时长取**自然结束的端到端时长**，
   不是 FC 那种「可控执行时长」；
4. **调用次数项不折算**：请求数由剧本决定，不是 harness 的开销（本批 pi 135 次 vs 其余 101~102 次，
   若按 FC 折 0.0075 CU/次，pi 会因为「自己多发了 34 条压缩请求」被额外罚分，而那是它的策略选择）。

| harness | CU | 分数 | 核·秒 | MB·秒 | 内存项占 CU | 后代 CPU | 启动 / 运转 / 收尾 CU（各自积分） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pi 0.85.1 | **1.271** | **100.0** | 1.031 | 246 | 19% | 0.183（计数） | 0.140 / 1.037 / 0.000 |
| Codex 0.155.1 | 1.383 | 91.9 | 0.644 | 757 | 53% | 0.618（采样） | 0.000 / 1.352 / 0.000 |
| peri 3.17.0 | 2.102 | 60.5 | 1.983 | 122 | 6% | 1.261（计数） | 0.190 / 1.816 / 0.000 |
| Claude Code 2.1.277 | 2.828 | 45.0 | 2.156 | 688 | 24% | 0.592（计数） | 0.134 / 2.586 / 0.000 |
| dsh 0.1.5-rc.2 | 3.101 | 41.0 | 2.408 | 710 | 22% | 0.665（计数） | 0.688 / 2.342 / 0.000 |
| MiniMax Code 0.4.12 | 31.995 | 4.0 | 19.967 | 12316 | 38% | 0.414（计数） | 1.685 / 29.641 / 0.444 |

怎么读：

- **它答的是「跑完同一部剧本烧掉多少资源」，不是「谁先跑完」**：Codex 端到端第二慢（6.1s）、
  CU 却是第二省（1.383）——因为它只跑 6 秒；反例是 peri：端到端并列第二快（2.2s），CU 却排第三，
  贵在那 100 个工具 shell 的 CPU 积分上。要「响应快」看端到端，要「成本低」看 CU，两者不是一回事。
- **Codex 的名次是这次修复的直接读数**：上一批它 CU 3.294（47.2 分，第四），其中收尾段 1.760 CU
  是零 CPU 的空等顶着约 160MB 内存；修复后 1.383（91.9 分，第二），收尾段的积分归零。
- **内存项在新口径下是实打实的一项**：本批内存项占 CU 的 6%~53%（极值是 Codex：CPU 只有
  0.644 核·秒，其中 0.618 还是子进程干的；绝对量最大的是 MiniMax Code 的 12316 MB·秒，
  是 peri 的 101 倍）。**这也是 1:1 的意义**：内存不再是总账里的尾数，「谁更省内存」真的参与计分。
- **peri 第三靠的是「轻」**：内存面积 122 MB·秒是六家里最小的（Codex 的 1/6.2），CPU 项则几乎
  全是那 100 个工具 shell 的账；它 CPU 峰值 43.7% 是唯一没超过单核的。
- **分数是批内相对值**：`100 × 最小 CU / 本次 CU`，换一批运行（机器负载、剧本、被比较的对手
  不同）分数就会变。**跨批次只比 CU**，别比分数。

### 为什么是 1:1，而不是照抄 FC 的 0.15

FC 的 `0.15 CU/(GB·秒)` 等于说「1 个核 ≈ 6.67 GB 内存」，那是云厂商的出价——行业里 AWS Lambda
新版 vCPU 价折算 **≈7.6**、Cloud Run **≈9.0**，都在这条线上。照它算，内存项在总账里只占
**1%~8%**，「谁更省内存」几乎不参与计分。

本项目问的是**资源负担**：跑同一部剧本，一个核烧一秒与一 GB 常驻一秒，对机器的占用没有谁更「便宜」。
所以把这件事明说一次——**1 核·秒 = 1 GB·秒**，系数写在 `score.ts` 的 `CU_COEFFICIENTS` 里，
改它等于换一套口径（改系数要显式、要重跑整批）。这个选择不是无关紧要的：同一批数据，按 FC 的 0.15
排是 **Codex 0.755 ＜ pi 1.067 ＜ peri 2.001 ＜ Claude Code 2.257 ＜ dsh 2.512 ≪ MiniMax Code 21.771**
（Codex 第一），按 1:1 排则是 **pi 1.271 ＜ Codex 1.383 ＜ peri 2.102 ＜ Claude Code 2.828 ＜
dsh 3.101 ≪ MiniMax Code 31.995**——冠军换人：Codex 的 CPU 积分只有 pi 的六成（0.644 对 1.031），
可它的内存面积是 pi 的 3.1 倍（757 对 246 MB·秒），内存权重一抬就被 pi 反超。
名次在什么权重下翻转，本身就是读数；把系数显式写出来，比藏在「借来的数」后面更诚实。

### 峰值（压力口径，不折算）

CU 看**面积**，峰值看**最坏一刻**——机器的内存水位与规格是照峰值配的，两个问题都真实。
峰值不折算成分数：MB 与 % 是绝对量，本来就能横比，再套一层批内相对分只会多一个「我们拍的」数字。

| harness | 峰值 RSS（进程树） | 峰值出现在 | 当时进程数 | 峰值 CPU |
| --- | --- | --- | --- | --- |
| peri 3.17.0 | **71.7MB** | 2.10s（末拍） | 1 | **43.7%** |
| Codex 0.155.1 | 163.7MB | 3.00s（运转段） | 3 | 26.0% |
| dsh 0.1.5-rc.2 | 231.2MB | 3.70s（末拍） | 1 | 128.0% |
| pi 0.85.1 | 234.4MB | 1.00s（运转段） | 1 | 128.8% |
| Claude Code 2.1.277 | 351.0MB | 2.10s（末拍） | 1 | 122.4% |
| MiniMax Code 0.4.12 | 892.0MB | 19.60s（运转段） | 2 | 177.8% |

怎么读：

- **peri 在两个口径上都是最轻的**：内存面积最小（122 MB·秒）、峰值也最小（71.7MB）、CPU 峰值
  43.7% 是六家里唯一没超过单核的——它贵在 CPU 积分（100 轮工具 shell 的账），不贵在「要多少资源
  才跑得起来」。
- **峰值与面积会指向不同的家**：Codex 峰值 163.7MB 不算大，面积却是 peri 的 6.2 倍（757 对
  122 MB·秒）；MiniMax Code 的 892.0MB 出现在 19.6s——是**一路涨上去**（首拍 170MB → 末拍
  866MB），不是某一瞬的尖峰。
- **峰值那一拍的进程数要一起看**：Codex 峰值落在 3.00s、当时 3 个进程，说明那 163.7MB 里含着
  工具 shell（`zsh -lc` + 本机 `.zshrc` 的 emsdk 初始化），不全等于它自己的常驻内存（主进程峰值
  41.7MB）。
- peri / dsh / Claude Code 的峰值落在**末拍**：RSS 到退出前还在涨，峰值就是最后一拍——这也是
  为什么「峰值」要跟「面积」分开看。

### 口径细节（面积与峰值共用）

- **后代 CPU 取「已回收子进程计数器」与「采样到的后代」的较大者**（`child_cpu_from` 写明取自
  哪一路），不求和：两条路都是真值的下界且可能重叠（被看见过的子进程之后被回收，同一段 CPU
  会在计数器里再出现一次，实测相加会多算 136%）。本批六家都记到了后代（peri 1.261 核·秒最大，
  占它自己总 CPU 的 64%——每轮工具调用拉起的 shell；Codex 的 0.618 取自「采样到的后代」，
  它的活确实是原生二进制干的）。
- **末拍 → 退出的空档要补**：采样循环读到「进程不在了」就停，最后一拍到真正退出还差约一个
  采样间隔（实测 ≈100ms），不补的话 pi 这种 1.3s 的快 harness 会漏计约 8%。本批六次都是当前
  采样器的产物，`score.tailGapKnown` 与 `childColumnPresent` 全为 true（每笔都按末尾三拍的
  速率外推补了 100~101ms），所以**这一节的 CU 不是下界**——更早那批老产物才是（那时两列都缺）。
  峰值不受它影响（峰值是最大值，与空档无关）。
- **CU 是「逐拍累加」出来的**（见上），表里那列「启动 / 运转 / 收尾 CU」是**同一口径的分段积分**
  （三段各自逐拍算），与总分的差只有一笔：**尾部补齐只进总分**（本批 0.03~0.23 CU，占各家
  0.7%~7.4%）——采样点在三段之间首尾相接、不重不漏，六家实测「三段之和 + 尾部补齐 = 总分」逐笔
  成立。后代 CPU 的「取较大者」同理在整段上取一次、不逐段取（逐段取会在段边界上把同一段子进程
  CPU 重复计）。分段是拿来看「钱花在哪一段」的，**不是三段相加**。
- 采样侧的两个口径（`scripts/perf/sampler.ts`）：`child_cpu_pct` 是父进程 rusage 里
  `ri_child_user_time` / `ri_child_system_time` 的差分（**已回收子进程**的累计 CPU，实测钉死了
  偏移 96/104 与「单位是 Mach tick 不是纳秒」）；它与 `tree_cpu_pct`（进程表里看得见的后代）
  是两套互补的下界，**不能相加**，计分时取较大者。

## 逐家的收尾与辅助请求（本批次实测）

| harness | 收尾段 | 收尾段里有请求吗 | 辅助请求（本批次实测） |
| --- | --- | --- | --- |
| peri | 0.07s | 无 | 1 条「预测下一步输入」（主流程收尾**之后**才发，吃的是尾部那条空白、不占轮次） |
| Codex | 0.04s（修复前 10.06s） | 无 | 无 |
| Claude Code | 0.06s | — | 无 |
| dsh | 0.07s | — | 1 条「会话标题生成」（`messages=2`，吃掉第 2 条剧本） |
| pi | 0.02s | — | 34 条压缩总结（第 70 轮起每轮一条，吃掉 34 条剧本） |
| MiniMax Code | 0.23s | — | 无 |

- **peri 的 5s 是等一个 Prediction 后台任务的收尾宽限期（根因已查明，默认剧本已消掉）**：
  收尾段此前多次实测都是 5.0~5.1s，与轮数无关（1 轮探针同样是 5.0s）；静默期 CPU 0%、无子进程、
  主线程停在 `pthread_cond_wait`、没有任何对外 socket，`--bare` 不消、**把 mock 杀掉也不消**。
  后续读 peri 源码 + 抓栈定位到：`-p` 退出时 host 用硬编码 5s 的 cooperative_grace 等
  host-owned 任务，卡住的是 `HostTaskKind::Prediction`——「预测下一步输入」拿到**非空**文本后
  回落成 Placeholder 动作、一路走到写 session 标题那步就停住，直到超时被 abort：日志里
  `aborting host-owned task owner=Session kind=Prediction` 与预测完成的间隔正好 5.0015s。
  **peri 侧一度说这是 langfuse 环境变量导致的等待，实测不成立**：本机没有任何 `LANGFUSE_*`，
  代码也要求 `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` 双 key 同时存在才启用
  （`from_env()`，唯一初始化点在 `peri-acp/src/host/assemble.rs`），退出期的 `lsof` 更是一条
  对外连接都没有；推测那个说法来自 langfuse 客户端里恰好也是 5s 的 `connect_timeout`。
  **消掉的办法**：给预测请求一条**空白**响应——`execute_prediction` 见文本 trim 后为空，在拿锁
  之前就返回空动作，5s 直接归零（对照实测：空白 2150 / 2110 / 2149ms vs 非空收尾文本 7096ms，
  差 4.95s、完全可复现）。长剧本生成器已把「收尾文本 + 空白」两条固定写进尾部（顺序不可反），
  当批对照实测端到端 7.7s → 2.2s；本批 peri 的收尾只剩 0.07s。要复现旧读数就把尾部那条空白删掉。
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
  **2026-09-19 修复落地**：Codex demo 现在仅给 harness 及其子进程注入大小写 HTTPS 代理变量，
  指向 `http://127.0.0.1:9`，同时覆盖大小写 `NO_PROXY` 为本地地址，保证 HTTP mock 直连。
  不改系统或用户全局配置；代价是该沙盒不再适用于依赖外部 HTTPS 的剧本（本机 9 端口须未监听）。
  Codex 0.155.1 用 `playground/codex/script.json` 三轮只读工具调用复核：修复前端到端 11.1s /
  收尾 10.2s，修复后端到端 1.0s / 收尾 0.1s；两次均 4 个请求、退出码 0、三次工具执行成功。
  诊断产物在 `data/diagnostics/codex-shutdown/codex/`，不参与排名。**本文这一批就是按新配置
  重跑的完整批次**：长剧本下 Codex 端到端 **16.4s → 6.1s**、收尾 **10.06s → 0.04s**、
  CU **3.294 → 1.383**（名次第四 → 第二）——它的 CU 从此只在运转段产生。
- **pi 的压缩**：上下文到阈值 → 发一条总结请求 → 用摘要开新对话，每轮一条（渐进式，本批 34 条）。
  **它同样消费剧本条目**，编排剧本时要按「主循环轮数 + 压缩请求数」留足余量，
  否则主循环跑不满预期轮数。

## 读数怎么读（别踩的坑）

- **长剧本的「时长」含启动与收尾**，这是刻意的：端到端就该含。但要拆开看——`run.json` 的
  `segments` 把 启动 / 运转 / 收尾 三段分开，**本批的时间几乎全在运转段**（Codex 修复后收尾
  0.04s，MiniMax Code 的 0.23s 已是最大的一笔），别按总时长除以 100 去算「每轮成本」。
- **收尾段读数的两个坑**：一是它可能包含 harness 自己的固定等待（peri 曾有 5.0s，默认剧本已消掉；
  Codex 曾有 10.0s，本批已由 demo 代理注入消掉），二是其中可能有**本机网络环境的成分**（Codex
  那 10s 就是在等 `chatgpt.com` 超时，换台干净网络会掉到 0.4s 量级——验证见上节）。
  跨机器比较时长前先确认这两件事。
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
  每轮自己的处理链就要 ~185ms）。要比单位成本就用「运转段每轮」那一列。
- **进程树包含工具调用的子进程**：`samples.csv` 的 `procs` 列能看到进程数波动（本批次峰值：
  Codex 3、MiniMax Code 2，其余 1）；RSS 的涨幅里混着工具子进程的固定占用，别全记到上下文累积上。
- **peri 被强杀时 `harness.log` 是空的**（`-p` 模式只在自行退出时 flush），属已知限制；
  长剧本下它自行退出，所以日志完整。pi 同理。
- **首次运行与后续运行的温差**：本批次跑在各家沙盒状态已预热的情况下（会话库、缓存都在），
  冷启动读数会比这里更高；轮次之间没有清沙盒缓存，六家一视同仁。
- 想看逐拍曲线直接读 `data/runs/<harness>/<runId>/samples.csv`
  （`ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs,child_cpu_pct`），或看下一节的
  图表页；采样口径的验证实验见 `bun run scripts/perf/verify.ts`。
  同一目录的 `run.json` 里还有 `cost` / `peaks`（面积与峰值各一整笔账，逐项摊开）。

## 图表页

`docs/perf-chart.html` 是个静态页，**打开先看到统一计分表**（标着 **Beta** 的候选口径，
按**口径**分组的表头：统一计分（面积：`CU` / 分数）、构成（积分出来：核·秒 / MB·秒 /
内存项占 CU / 后代 CPU）、压力口径（峰值 · 进程树：峰值 RSS / 峰值 CPU）、
启动 / 运转 / 收尾 CU（各自积分）；公式直接印在页面上，按 CU 升序排）；
往下才是折线图——画各家的逐拍曲线（X = 时间，Y 可切 RSS / CPU、主进程 / 进程树），
图上带请求分界线（首个与末次请求）。
数据来自仓库根的 `data/perf-chart.json`（页面按 `../data/perf-chart.json` 取；由 `gen-chart-data.ts`
从 `data/runs/` 里挑一次运行导出的精简载荷；计分是**现算**的，所以新老产物同口径可比）。
**opencode 的线默认收起、不参与 X 轴定标**（已退出排名，见开头）：在图例里点一下可展开看它的
历史读数，展开时是一条虚线、横轴会自动延伸到 38.6s。

曲线默认按 **1s 窗口做滑动平均**（页面上可切原始 / 0.5s / 1s / 2s）：100ms 采样下多线程
harness 的 CPU 是真实的锯齿（几拍突发、几拍归零），不平滑就只剩毛刺——本批数据里相邻两拍
跳 30 个百分点以上的有 MiniMax Code 21 处、Claude Code 3 处、dsh 3 处、pi 1 处
（peri / Codex 各 0 处），1s 窗口后全部降到 0 处。
平滑只改画法，`samples.csv` 与页面汇总表里的均值 / 峰值始终是原始读数。

图上另有两条读图约定：**每条线的峰值标出 harness 名**（CPU 与内存都标，标的是画出来的那条线，
所以峰值跟着平滑窗口走），以及**内存的纵轴是反的**（0 在顶、占用越大越靠下，方向与「内存变重」
一致）；CPU 轴仍是正常方向。

```sh
bun run scripts/perf/gen-chart-data.ts --exclude opencode   # 本批：每个 harness 取最近 3 次里居中的一次
bun run scripts/perf/gen-chart-data.ts --pick 20260919-204152 --pick 20260919-204208 …   # 或显式点名
cd <仓库根> && python3 -m http.server 8080        # 页面用 fetch 读 JSON，file:// 会被 CORS 挡
# → http://localhost:8080/docs/perf-chart.html
```

Chart.js 先试 unpkg 的 CDN（`chart.js@4`）**2s 超时**，拿不到就换仓库里的
`docs/vendor/chart.umd.min.js`（该目录已 gitignore，换机器可能没有）：本机浏览器走 PAC 代理
实测公共 CDN 不是报错而是挂着不动，所以超时是必需的、页面也不能用静态 script 标签去取它
（实测无头加载时卡在 CDN 上，页面根本不渲染）。**兜底才是常态路径**。页面不需要构建，
改 JSON 刷新即可。
