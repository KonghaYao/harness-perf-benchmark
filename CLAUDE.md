# CLAUDE.md

## 项目定位

llm-mock 是**脚本化的模型 API mock**（Bun 运行时，唯一依赖 hono）：把预设的响应序列写成 JSON
脚本，**第 i 次请求返回第 i 条**；客户端要流式时把同一条完整响应转换成对应协议的 SSE 序列
（Chat / Messages / Responses 按 body 的 `stream: true`，Gemini 那份写在路径的
`:streamGenerateContent` 上——见「关键约定与陷阱」）。

同一份脚本可以走四种线协议（各自独立计游标，互不干扰）：

| 端点 | 协议 | 谁在用 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | peri、opencode、opencode2、pi、dsh、MiniMax Code、Hermes Agent、Cline、脚本自测 |
| `POST /v1/messages` | Anthropic Messages | Claude Code |
| `POST /v1/responses` | OpenAI Responses | Codex |
| `POST /v1beta/models/{model}:generateContent` | Google Gemini API | Antigravity CLI |

两个用途：

- **性能压测**：以脚本控制的节奏驱动 harness（peri / Claude Code / Codex / pi / dsh / MiniMax Code /
  Antigravity CLI / opencode2 / Hermes Agent / Cline；opencode **v1** 已退出排名、不再跑，见
  「与 harness 集成」开头），测量 harness 进程自身的 CPU / 内存开销（不采 GPU）；
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
cd playground/antigravity && bun perf-demo.ts --timeout-ms 600000   # Antigravity CLI（agy）沙盒
cd playground/opencode2   && bun perf-demo.ts --timeout-ms 600000   # opencode v2（bin 名 opencode2）沙盒
cd playground/hermes      && bun perf-demo.ts --timeout-ms 600000   # Hermes Agent（hermes）沙盒
cd playground/cline       && bun perf-demo.ts --timeout-ms 600000   # Cline（cline）沙盒
# cd playground/opencode  && bun perf-demo.ts --timeout-ms 600000   # opencode v1 已退出排名：代码保留，常规批次不再跑
```

`perf-demo.ts` 都是复用同一套实现的薄入口（相对路径按仓库根解析），差别只在 harness 命令、
沙盒与配置注入方式（详见「与 harness 集成」）。**默认剧本是各家的长剧本**
（`data/scenarios/long-run*.json`，由 `gen-long-run.ts` 按自家工具形状生成），`--exhausted` 默认
`stop`；`run.ts` 的 `--script` 是必填（见「关键约定与陷阱」），那份默认值因此由各家 demo 自己带：

- `playground/peri`：默认注入 `--db-path`（沙盒会话库）与 `--settings`（运行时生成、指向本次端口的 JSON）；
- `playground/opencode`（v1）：`XDG_*` 隔离 + `{env:LLM_MOCK_BASE_URL}` 变量替换（换端口不用改配置）；
- `playground/opencode2`（v2）：同样是 `XDG_*` + `{env:…}`，外加 XDG_CONFIG_HOME、一条死代理，
  命令固定带 `--standalone`（**不加会留一个常驻后台服务，三次读数冷热不均**）；二进制按
  **`opencode2` 这个 bin 名**找（裸 `opencode` 已被 v2 顶掉，认名字才不会拿错代）；
- `playground/claude-code`：`HOME` + `CLAUDE_CONFIG_DIR` 都指到沙盒（**只改后者挡不住用户级 settings**）；
- `playground/codex`：`CODEX_HOME` 指向沙盒（用户全局配置里有 hooks 与别的 provider）；
- `playground/pi`：`PI_CODING_AGENT_DIR` 指向沙盒，`models.json` 每次启动按本次端口重写
  （pi 的 `baseUrl` 不吃 `$VAR` 插值，换端口只能改文件）；
- `playground/deepseek`：`DSH_HOME` 指向沙盒，provider 全走环境变量
  （`$DEEPSEEK_BASE_URL` / `$DEEPSEEK_API_KEY`），**不用生成配置文件**；
- `playground/minimax-code`：`MINIMAX_DATA_DIR` 指向沙盒，provider 按本次端口写进沙盒的
  `config.yaml`（mcode 的 `baseURL` 不吃环境变量插值，与 pi 同理）；
- `playground/antigravity`：`HOME` 指向沙盒（`$HOME/.gemini/antigravity-cli/settings.json` 里选
  `modelProvider: gemini`），端点靠 `GOOGLE_GEMINI_BASE_URL`、凭据靠 `GEMINI_API_KEY` 假值
  （agy 的 provider 配置与登录态都只按 HOME 找，与 Claude Code 同理）；
- `playground/hermes`：`HERMES_HOME` 指向沙盒（config.yaml / .env / sessions / state.db / skills
  全从这里找），provider（`model.provider: custom` + `base_url`）按本次端口重写那份 `config.yaml`
  （没有环境变量插值这一说，与 pi / mcode 同理）。**代码不在 HERMES_HOME 下**——官方安装脚本把仓库
  放在 `~/.hermes/hermes-agent`、`~/.local/bin/hermes` 是固定指向它的启动壳，所以换 HERMES_HOME
  只换数据、不动代码。
- `playground/cline`：`--config` / `--data-dir` / `--hooks-dir` 三个位置参数都指到沙盒，
  provider 按本次端口写进 `<沙盒>/data/settings/providers.json`（不吃环境变量插值，与 pi / mcode /
  hermes 同理）。**不用换 HOME**（实测用户级 `~/.cline` 抢不走配置）；**也不注入死代理**——实测那样
  反而把它拖慢 4~5 倍（见「与 harness 集成」的 Cline 一节）。

需要复核采样口径时跑 `bun run scripts/perf/verify.ts`（对 `yes` / `sleep` 这类已知负载回归，
并打印两个候选后端的开销与分辨率）。想把「CPU 与内存」混成一个可比的数（谁跑完同一部剧本烧的资源
更少）看**统一计分**——公式结构借自阿里云 FC，**系数是本项目定的 CPU 与内存 1:1**
（`CU = 1.0 × 核·秒 + 1.0 × GB·秒`），另给一列不折算的**峰值**（最坏一刻占多少）；**还在 Beta：
口径没定稿，先用来看趋势、别把名次当结论**，见下面的「统一计分（Beta）：CPU 与内存 1:1」。

### 场景：长剧本端到端（跑完整个剧本，测时长）

`--exhausted stop` 让 mock 在剧本走完后返回一条「任务结束」纯文本（`finish_reason=stop`），
harness 收到即自行收尾退出——于是能测**端到端时长**（含启动，`perf.log` 里的「端到端时长」）
与整段资源消耗，而不是某段固定时间窗内的资源写照。剧本由生成器现造（仓库里不放剧本文件），
生成器**固定带两条收尾条**（轮数之外）：一条同文的「任务结束」文本 + 一条空白响应——后者是给
peri 的「预测下一步输入」的，能消掉它固定 5.0s 的收尾等待（理由见「已知限制与坑」）：

```sh
# 各家各一份（工具名/参数形状按各家实测，见 gen-long-run.ts 的 ArgShape）
bun run scripts/perf/gen-long-run.ts --turns 100 --out data/scenarios/long-run.json           # peri / opencode / Claude Code（Bash + command）
bun run scripts/perf/gen-long-run.ts --turns 100 --args exec --out data/scenarios/long-run-codex.json
bun run scripts/perf/gen-long-run.ts --turns 133 --tool bash --out data/scenarios/long-run-pi.json  # pi 要 133：压缩请求每轮多吃一条
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --args command+description \
  --out data/scenarios/long-run-dsh.json
bun run scripts/perf/gen-long-run.ts --turns 100 --tool bash --out data/scenarios/long-run-minimax-code.json  # mcode：bash + command，轮数 + 1 条就够
bun run scripts/perf/gen-long-run.ts --turns 104 --args commandline \
  --out data/scenarios/long-run-antigravity.json  # agy：run_command + 五项参数；104 条 = 100 轮 + 标题 1 + 压缩 3
bun run scripts/perf/gen-long-run.ts --turns 101 --tool shell \
  --out data/scenarios/long-run-opencode2.json  # opencode v2：shell 工具 + {command}；101 条 = 100 轮 + 标题 1
bun run scripts/perf/gen-long-run.ts --turns 102 --tool terminal \
  --out data/scenarios/long-run-hermes.json  # hermes：terminal 工具 + {command}；104 条 = 102 轮 + 2 条收尾 → 100 个工具轮（标题与压缩各吃掉一条轮次）
bun run scripts/perf/gen-long-run.ts --turns 101 --args commands \
  --out data/scenarios/long-run-cline.json  # cline：run_commands 工具 + **字符串数组** {commands:[…]}；103 条 = 101 轮 + 2 条收尾 → 100 个工具轮（压缩吃掉一条）

cd playground/peri && bun perf-demo.ts --exhausted stop --timeout-ms 1200000
```

`--timeout-ms` 只作兜底（正常应看到 `harness 退出: code=0` 且时长远小于它）；peri 3.17 的
`-p` 模式忽略 `--max-turns`，但真生效时默认 25 会截断剧本，习惯给 harness 带上 `--turns 100`
（**demo / run.ts 的 `--turns` 是传给 harness 的 `--max-turns`，与生成器同名的那个「轮数」不同义**）。
想量「与轮数无关的固定成本」用 `--turns 1 --body-kb 0` 生成探针剧本（它同时含启动与收尾，
两边各占多少看摘要里的「时长分段」）。最近一批（第五批 `codex-proxy-fix`）六家的分段是
**启动 0.10~1.22s、收尾 0.02~0.23s**——两笔大的固定成本（Codex 10.1s、peri 5.0s）本批都已消掉，
时间几乎全在运转段，见 `docs/perf-compare.md`。
摘要里的**「时长分段」**把它拆成三段——启动（起进程 → 首个请求）、运转（首 → 末次请求）、
收尾（末次请求 → 退出）——实测很值钱：**两笔最大的固定成本都出在收尾段，且都已消掉**——Codex 的
10.1s（退出时向 `chatgpt.com` 发请求，本机 DNS 污染导致 10s 超时；demo 把 HTTPS 出口指向死端口后
掉到 0.04s）与 peri 的 5.0s（等一个 Prediction 后台任务，默认剧本的空白收尾条已把它消到 0.07s）；
Codex 那笔还顺带说明了「收尾零 CPU 的空等照样花钱」——它顶着约 160MB 内存挂了 10s，1:1 口径下
值 1.76 CU（占当时总 CU 的 53%），修完名次从第四升到第二。见「已知限制与坑」与 `docs/perf-compare.md`。
注意**「剧本轮数」与「harness 实际执行的轮数」可能不等**：各家自己的辅助请求（标题生成、上下文
压缩）也消费剧本条目，100 条剧本下 opencode / dsh 实测只跑到 99 轮、pi 要 135 条（`--turns 133`）
才够跑满 100 轮、opencode2 要 103 条（`--turns 101`）、hermes 要 104 条（`--turns 102`）、
cline 要 103 条（`--turns 101`，见「与 harness 集成」的消费规律）（数法：`mock.log` 里带工具结果
的请求有几条）。
生成器写的条目数是 `轮数 + 2`（两条收尾，见上），peri 那条「预测下一步输入」就落在最后那条空白上。

产物落在**一次运行一个目录**里：`data/runs/<harness>/<runId>/`（`--out-dir` 可改，`data/` 已在
.gitignore 里），`<harness>` 是 `peri` / `opencode` / `opencode2` / `claude-code` / `codex` / `pi` /
`dsh` / `minimax-code` / `antigravity` / `hermes` / `cline` 之一（由 `--harness` 指定，或从启动命令的第一个 token 查别名表推断——`claude` →
`claude-code`、`mcode` → `minimax-code`、`agy` → `antigravity`，见 `scripts/perf/harness-id.ts`），
`<runId>` 形如 `20260919-140136`（同秒第二次运行加 `-2` 后缀）：

| 文件 | 内容 |
| --- | --- |
| `run.json` | **机器接口**：身份 / 剧本（含 sha256）/ mock 与采样参数 / 宿主信息 / 时间线（含首个与末次请求的绝对时刻）/ 时长分段 / 摘要统计 / **统一计分 `cost` 与峰值 `peaks`** / 退出码 / 产物清单。开跑先写一份 `status:"running"`，结束时原子替换补全；读取端只认它 |
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
  **这条通道只对「根进程直接拉起的子进程」有效**：子进程再拉起的孙进程（cline 就是这种形状——
  启动壳 → 单文件二进制 → 每轮一个 shell）记在**子进程**的计数器上，采样器不读它，于是那一笔
  两头都漏（既不在进程树里、也不在 `child_cpu_pct` 里），口径上是个下界，见「与 harness 集成」的
  Cline 一节；
  它与 `tree_cpu_pct` 是两套互补的下界、**可能重叠，不能相加**，计分时取两者较大者；
- 采样数据先进内存、每 1s 落盘一次，避免每拍同步 I/O 干扰被测对象。

### 统一计分（Beta）：CPU 与内存 1:1

**状态：Beta**（2026-09-19 起试行）。系数是本项目定的、实现是稳的，但**这套口径本身还没定稿**——
「后代 CPU 算不算 harness 的开销」「时长该按端到端还是按可控执行时长」这些还没想清楚，
所以它现在的定位是**一个可讨论的候选口径**，不是裁决：排名与结论可以引它，但别把它的名次
当成对 harness 的最终评价，也别据此改动被测对象。口径要改就先在 `docs/perf-compare.md` 写明、
重跑一个完整批次再更新读数。

它回答的问题很具体：「跑完同一部剧本，谁的整段资源成本更小」——单个 CPU 均值或 RSS 峰值答不了
这个（那要看**面积**，不是峰值）。公式结构借阿里云函数计算（FC）的 CU（Compute Unit）折算表
（2026-09-19 核对官方计费页；FC 的口径是「资源使用量 × 转换系数」再求和）：

```
CU    = 1.0 × 核·秒 + 1.0 × GB·秒        （结构借自 FC；**系数是本项目定的 1:1**——FC 原表内存项是 0.15）
核·秒 = ∫(tree_cpu_pct / 100) dt         GB·秒 = ∫(tree_rss_kb / 2^20) dt      ← 时间积分，含时长
分数  = 100 × 本批次最小 CU / 本次 CU    （最优 100 分；**只在同一批次内可比**，跨批次只比 CU）
```

口径、系数与四处刻意偏差的完整说明只在 **`scripts/perf/score.ts` 的文件头**，别处不许重写一份。
**为什么是 1:1 而不是照抄 FC 的 0.15**：`0.15 CU/(GB·秒)` 等于说「1 核 ≈ 6.67 GB」（AWS Lambda
新版价折算 ≈7.6、Cloud Run ≈9，云厂商都在这条线上），照它算内存项只占总账 1%~8%，「谁更省内存」
几乎不参与计分。本项目问的是**资源负担**：跑同一部剧本，一个核烧一秒与 1GB 常驻一秒，对机器的
占用没有谁更便宜。这个选择不是无关紧要的——同一批数据按 FC 的 0.15 排是 Codex 第一、peri 第四，
按 1:1 排是 pi 第一、peri 第二、Codex 第四，两头都换位（数据见 `docs/perf-compare.md`），
所以系数必须显式写出来、不许藏在「借来的数」后面。内存面积在报告里按 **MB·秒** 显示
（`gbSeconds × 1024`），换显示单位不改口径。**峰值**（`peaks`：MB / %）刻意不折算：绝对量本来就
能横比，再套一层批内相对分只会多一个「我们拍的」数字，它单独回答「最坏一刻要占多少」。

那个 `∫` 是**逐拍累加**（100ms 一拍，按每拍实测间隔差分）：`Σ(每拍资源率 × 该拍间隔)`，
不是「均值 × 时长」那种估法。报告与页面里的三段（启动 / 运转 / 收尾）是同一口径的**分段积分**，
只用来回答「钱花在哪一段」：三列之和 = 总分 − 尾部补齐（那 ~0.1s 只进总分，六家实测逐笔成立），
**不是三段相加**；后代 CPU 的取大也只在整段上取一次，逐段取会在段边界重复计。

**Beta 期间先守住的几条**（它们保证的是口径**内部自洽与可比**，不是「这么算就对了」；
要改任何一条，先在 `docs/perf-compare.md` 里写明理由并重跑全批次）：

- **系数不许微调**，尤其不许为了「让排名好看」动那两个数（`CU_COEFFICIENTS`）；
- **换系数等于换口径**：要按别家的价重算（FC 原表 0.15、AWS Lambda 折算 ≈7.6、Cloud Run ≈9）
  就改 `CU_COEFFICIENTS` 一处、在 `docs/perf-compare.md` 写明理由并重跑整批，
  **不许在别处另写一套、也不许拿它去凑名次**；
- **峰值不折算成分数**（MB / % 直接横比），它单独回答「最坏一刻要占多少」；
- **口径固定进程树**（含 harness 拉起的后代），不用主进程——Codex 主进程 CPU 近 0，
  真干活的是它 spawn 的原生二进制；
- **后代 CPU 取 `max(采样到的后代, 已回收子进程计数器)`，不许相加**：两条路都是下界且可能重叠
  （被看见过的子进程之后被回收，同一段 CPU 会在计数器里再出现一次，实测相加多算 136%）；
- **时长必须在公式里**（就是上面那个积分），不许退化成「平均 CPU%」之类的无量纲量；
- **末拍 → harness 退出的空档必须补**（`timing.harnessExitedAtMs` 实测，按末尾三拍速率外推，
  上限 500ms）；补不了（老产物没记这个时刻）就**明确标下界**，不许静默按 0 混进去；
- **调用次数项不折算**：请求数由剧本决定，不是 harness 的开销（按 FC 折 0.0075 CU/次的话，
  pi 会因为「自己多发了 34 条压缩总结」被额外罚分，而那是它的策略选择）；
- **`samples.csv` 的列只能往后加**，读取端按表头名取列；缺 `child_cpu_pct` 的老产物要在输出里
  标「进程树口径偏低」（`childColumnPresent: false`），跟数据一起走，不许悄悄按 0 处理。

**出口必须同源**（同一口径的数字对不上就是 bug）：每次运行把 `cost`（面积）与 `peaks`（峰值）
两个字段落 `run.json`，并把摘要行写进 `perf.log` 末尾；
`gen-chart-data.ts` 从 `samples.csv` **现算**（不读这两个字段，这样老产物也同口径可比）→
`docs/perf-chart.html` 与 `docs/perf-compare.md` 的计分部分都只显示、不自己记公式（页面上那条公式是
从 payload 的 `scoreFormula` 印出来的，页面不重打一遍）。
报告里给 CU 必须同时给「批内相对」与「下界标记」的说明，`gen-chart-data.ts` 的输出会替你把
这两类警告打出来。

**一张图不许混批**（分数是「本批最小 CU」的相对值，跨批混画出来的分数没有意义，而页面上看数据
是看不出来的）：payload 里每次运行都带它跑批时的 `--label`（没带就是 null），页面按「多数 label =
本批」判定，出现第二个批次就在页尾告警行里点名是哪几家、哪个 label，并说明只能按 CU 读——某个
harness 单跑过、后来又并进批次，这行会自己消失。所以往 `data/runs` 里留下单独跑过的产物是安全的，
但也**别指望页面替你把它们排除**：只看批内排名就显式 `--exclude <id>`。

**新批次要求**：重跑时用当前采样器（`child_cpu_pct` 列是新的），别再拿老产物出排名——
老批次的 CU 是下界（补不上尾部空档、也漏掉短命子进程，实测 pi 差 ~9%）。
`peaks` 是 2026-09-19 才加的字段，更早的 `run.json` 里没有：读取端从 `samples.csv` 现算补上
（峰值是最大值，不受尾部空档影响，老产物一样准）。

**一批怎么跑**（分数是批内相对值，把不同批次混进一张表就废了）：各家**串行**、每家 **3 次**，
读数取**端到端时长居中的那一次**（`gen-chart-data.ts --window 3` 是同一口径，`--pick <runId>` 可显式
点名）；跑批统一带 `--label <批次名>` 便于按批筛产物（最近一批：六家 × 3 轮串行、2 分 50 秒跑完，
`--label codex-proxy-fix`）。**跨批次只比 CU**，别比分数、也别比绝对时长——同一台机器、同一份剧本，
load 在 4~17 之间波动就能让 MiniMax Code 从 19.8s 变 34.7s；负载尖峰撞上哪一家，哪一家的读数
就偏保守（重跑比硬解释划算）。

## CI：跑一批 + 发 GH Pages

`.github/workflows/benchmark-pages.yml` 一趟串起「装 harness → 生成剧本 → 跑整批 → 汇总 →
组装站点 → 发 Pages」，判定逻辑只在那一个 workflow 的 decide 步骤里：

- 触发：`workflow_dispatch`（可传 turns / repeats / runner / peri 版本；勾 `skip_bench` 只发布、
  取消勾 `publish` 只跑管道不动线上——第一次调管道就用 `turns=5 repeats=1 publish=off`）、
  `schedule`（每周一 03:00 UTC）、`push` 到 main；
- **push 只动了 `docs/` 时不重跑压测**（改页面不该把榜单数字刷一遍），拿上一次的结果直接重发；
  动了 `scripts/perf/`、`src/`、`playground/` 或 workflow 才重跑；
- 数据是「现跑现生成」、仓库里不存（`data/` 已 gitignore）：每趟把 `data/perf-chart.json` 存进
  Actions cache，只发布的那趟取上一次的；缓存空时自动补跑一批；
- 默认 runner 是 **macOS**：采样器的首选后端 `proc_pid_rusage` 只在 macOS 上可用，换 ubuntu 会
  静默退到 `ps`（CPU 读数分辨率约 60ms、`child_cpu_pct` 恒为 0，页面上看不出异常），CU 会偏低。
  runner 上跑出来的数字与开发机不是一个批次——跨批次只比 CU；
- 站点布局：`docs/perf-chart.html` 当站点根目录的 `index.html`，`logos/` 与 `vendor/` 摆在根上，
  数据放 `data/`——所以页面取数是两处候选（`data/` 优先，退回 `../data/`），本地打开走后者；
- 装 peri 那一步得留个心眼：官方安装脚本在 `PERI_NO_PATH_HINT=1` 下会以 `BIN_LINK: unbound variable`
  收尾（上游 bug，3.17.2 实测——那个变量只在「写 PATH 提示」的分支里赋值，末尾那句提示却照用）。
  出事位置在**全部安装动作之后**（二进制与 `$HOME/.peri/peri` 软链都已就位），所以 workflow 不拿它的
  退出码当成败，改由紧随其后的 `"$HOME/.peri/peri" --version` 自查：脚本真倒在下载/解包上，这一步才会失败；
- 装 agy 那一步与 peri 同类（也是官方的 `install.sh`，先落盘再执行），但**它没有钉版本的参数**
  （只认 `--dir`），CI 每次拿到的是当天的最新版；脚本自己校验 SHA-512、装到 `~/.local/bin`，且**不改
  PATH**，所以 workflow 补一句 `GITHUB_PATH`。`agy --version` 是有的（1.2.7 实测，只是没写进 `--help`），
  workflow 拿它当安装自查——装不上这一趟就整趟失败，线上继续挂上一批的站点，不会悄悄少一条曲线；
- 一次性设置：repo 的 Settings → Pages → Source 选 **GitHub Actions**（私有仓库还得有 Pro 才开得了 Pages）。

## 目录结构

```
src/server.ts   入口：--help、加载配置与脚本、Bun.serve（默认 :3457）
src/config.ts   运行配置：CLI > 环境变量 > 内置默认
src/app.ts      Hono 路由 + 访问日志；四种协议共用取号/日志/错误处理
src/protocol.ts 协议适配接口（ProtocolAdapter、SSE 帧编码与流包装）
src/anthropic.ts  Anthropic Messages 适配（Claude Code）
src/responses.ts  OpenAI Responses 适配（Codex）
src/gemini.ts   Google Gemini API 适配（Antigravity CLI）
src/script.ts   脚本解析与进程级单游标 ScriptPlayer
src/stream.ts   OpenAI chat 的非流式合成 / SSE 序列、token 估算、grapheme 切分
src/types.ts    OpenAI 协议类型
src/*.test.ts   bun:test：脚本解析、游标、SSE 序列、各协议渲染、路由集成
scripts/perf/run.ts        压测入口：起 mock、起 harness、采样、写记录、出摘要
scripts/perf/config.ts     压测参数解析（parseArgs）；默认 harness 取 PATH 里的 peri
scripts/perf/sampler.ts    采样：rusage/ps 后端、差分换算、进程树、已回收子进程计数器、CSV 与摘要
scripts/perf/score.ts      统一计分（**Beta**）：CU = 1.0 × 核·秒 + 1.0 × GB·秒（CPU 与内存 1:1，
                           公式结构借自 FC）→ 百分制相对分；另有不折算的峰值口径（压力）
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
.github/workflows/benchmark-pages.yml  CI：跑一批 + 组装站点 + 发 GH Pages（见上）
data/runs/              压测产物：一次运行一个目录（已 gitignore）
data/claude-date/       老布局的压测产物（迁移前的遗留，迁完即可删）
```

## 常用命令

```sh
bun install
bun run src/server.ts --script script.json          # 起 mock（脚本必填，默认端口 3457）
bun run scripts/perf/run.ts --script data/scenarios/long-run.json --exhausted stop   # 压测（--script 必填）
cd playground/claude-code && bun perf-demo.ts       # 换成 Claude Code 压测（默认剧本由 demo 自带）
cd playground/antigravity && bun perf-demo.ts       # Antigravity CLI（agy）压测
cd playground/opencode2   && bun perf-demo.ts       # opencode v2（`npm i -g @opencode/cli`）压测
cd playground/hermes      && bun perf-demo.ts       # Hermes Agent（Nous Research，官方 install.sh）压测
cd playground/cline       && bun perf-demo.ts       # Cline（`npm i -g cline`）压测
bun run scripts/perf/verify.ts                      # 采样口径验证实验
bun test                                            # 全部测试
bun run typecheck                                   # tsc --noEmit（含 scripts/ 与 playground/）
```

## 与 harness 集成

各家都是「让 harness 把 base URL 指向本 mock」，但接入点各不相同（**Antigravity CLI 是第四种线协议**：
Google Gemini API，其余各家走 chat / Messages / Responses 三种）：

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

### opencode v1（**已退出排名，常规批次不再跑；v2 见下一节**）

**退出原因**：它在各项指标上都远落后于其余五家（端到端 38.6s vs 1.5~19.9s、进程树 CPU 均值
69.9% / 峰值 229.3%、RSS 均值 798.9MB / 峰值 943.0MB，整段消耗约 27 核·秒 vs 其余 1.0~5.0），
故不计入排名，`docs/perf-compare.md` 与 `docs/perf-chart.html` 上都已标注。**代码、沙盒与下面的
接入说明全部保留**：要复测就按下面的方式单跑，跑完用 `--exclude opencode` 生成图表数据即可
（`gen-chart-data.ts` 的选项：某家退出常规批次后，留在 `data/runs` 里的历史产物不会自己爬回图表）。

- 二进制从 PATH 找（`Bun.which("opencode")`，实测 1.17.12）；**demo 启动前会读一次版本号，
  不是 1.x 就直接报错**——`npm i -g @opencode/cli`（v2）也提供 `opencode` 这个 bin 名，
  且 npm 全局目录通常排在 `~/.bun/bin` 前面，会把这里的 v1 静默顶掉（读数就全不作数了）；
- `playground/opencode/opencode.json` 定义 provider（`npm: "@ai-sdk/openai-compatible"`），
  该文件**随 cwd 生效**，所以必须在 `playground/opencode/` 下启动 opencode；
  baseURL 写成 `{env:LLM_MOCK_BASE_URL}`，demo 按本次端口注入，换端口不必改配置；
- **全局配置的 `plugin` 数组是合并而非替换**：项目里写 `"plugin": []` 清不掉 `~/.config/opencode/opencode.json`
  里的插件，所以压测命令固定带 `--pure`（跳过外部插件，保证冷启动可比）；
- 用 `XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME` 把数据/状态/缓存隔离到沙盒内的
  `.data/.state/.cache`（必须经 `deps.harnessEnv` 注入，别用 `process.env` 赋值——见「已知限制与坑」）；
- opencode 会在会话开始时额外发一次**标题生成请求**（小模型、走同一个 provider），也消费脚本条目；
- 排查配置是否按预期生效：`opencode debug config`（合并结果）、`opencode debug paths`（数据目录）。

### opencode v2（`@opencode/cli`，bin 名 `opencode2`；**在排名里**）

v1 的下一代：**同一个项目、同一个仓库**（`github.com/sst/opencode` 现在 308 跳到
`github.com/anomalyco/opencode`），npm 上 v1 的 `opencode-ai` 与 v2 的 `@opencode/cli` 维护者
是同一人，所以包里两个 bin 名（`opencode` 与 `opencode2`）都指向同一个 v2 二进制——**但 v1 与
v2 是两个被测对象，读数不可混**，这也是老沙盒加版本守卫、这条曲线单开一个 harness id 的原因。

- 二进制从 PATH 找（`Bun.which("opencode2")`，实测 2.0.10，`npm i -g @opencode/cli`）；
  harness 命令是 `opencode2 run --standalone --model llm-mock/llm-mock --auto '<prompt>'`；
- **`--standalone` 不是可选项**：不加会走「后台服务」模式，起一个常驻的 `serve --service`，
  压测跑完它还活着、下一轮直接复用——三次读数变成「第一轮冷、后两轮热」，端到端与启动段全不可比
  （实测残留进程）。加了之后跑完 `service status` 是 stopped、无残留。**即便加了 `--standalone`，
  它仍会拉一个子进程** `opencode.exe serve --stdio --port 0`（主 CLI 约 106MB、子进程约 565MB），
  真干活的是那个子进程——与 Codex 同类，所以计分口径固定用**进程树**（见「统一计分」）；
- 隔离靠 `XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME / XDG_CONFIG_HOME` 指到沙盒内的
  `.data/.state/.cache/.config`（实测 `opencode2 debug paths` 四路全认 XDG），必须经
  `deps.harnessEnv` 注入；另加**死代理**（`HTTPS_PROXY=https_proxy=http://127.0.0.1:9` +
  `NO_PROXY=127.0.0.1,localhost,::1`，与 codex / agy 同一套路，让遥测类请求快速失败、mock 直连）；
- provider 配置仍是 cwd 的 `opencode.json`（所以必须在 `playground/opencode2/` 下启动），
  `{env:LLM_MOCK_BASE_URL}` 插值照旧可用；**`"npm": "@ai-sdk/openai-compatible"` 这一项必须写**
  ——漏了直接报 `Error: Unsupported package for llm-mock/llm-mock:`（实测）。provider 实现编在那个
  177MB 的单文件二进制里，**运行时不下载任何 npm 包**（沙盒里没有 node_modules，死代理下照跑）；
- 工具名换了一代：v1 的 `bash` 没了，**shell 工具叫 `shell`**、参数只要 `{command}`
  （`workdir` / `timeout` / `background` 可选），所以默认剧本是自家那份
  `data/scenarios/long-run-opencode2.json`（`gen-long-run.ts --tool shell` 生成，103 条 = 101 + 2）；
- **消费规律**：序列**第一条**是会话标题生成（`messages=2`、无 tools，system 写着
  "You are a title generator"），之后每轮工具调用一条主请求，100 轮内没有上下文压缩请求——
  所以 100 轮要 101 条剧本（`--turns 101`）。实测 102 条请求 = 标题 1 + 工具轮 100 + 收尾 1；
- 排查配置用 `opencode2 debug paths`（数据目录）；注意 **`opencode2 debug config` 会把后台服务
  起起来**（实测踩过，压测前记得 `opencode2 service status` 确认没有常驻服务）。

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
- **消费规律是十家里最干净的**：100 轮剧本实收 **101 条 = 100 轮 + 尾部收尾**，没有标题生成、
  没有上下文压缩、没有预测请求（对比：pi 要 135 条、agy 要 106 条、hermes 要 104 条、opencode2
  与 cline 各要 103 条、dsh 的标题请求会吃第 2 条）——实测 3 次
  端到端 19.6~20.2s（启动 1.3s · 运转 18.2s · 收尾 0.25s）、CU 21.29~22.06（**已并入常规批次**，
  与其余五家同批测得，见 `docs/perf-compare.md`）；
- 启动时会刷新模型目录（`models.dev/api.json` → `filecdn.minimax.chat`），落成沙盒里
  4.7MB 的 `cache/models-dev-catalog.json`（`updatedAt` 每次运行都变）——它不经过 mock，
  但会给启动段带一点外部网络成分，跨机器比时长时要留意；
- `harness.log` 有内容（自行收尾时 stdout 里是最终回答，本次即收尾文本）。

### Antigravity CLI（`agy`）

- 二进制从 PATH 找（`Bun.which("agy")`，实测 1.2.7，官方脚本装到 `~/.local/bin/agy`，单文件 Go
  二进制约 181MB）；harness 命令是 `agy -p '<prompt>' --dangerously-skip-permissions`：`-p`/`--print`
  是官方的**无头模式**（跑一个 prompt、最终回答写 stdout、成功退 0）；
- 走 **Google Gemini API**（`POST /v1beta/models/{model}:streamGenerateContent?alt=sse`，mock 侧由
  `src/gemini.ts` 应答）——**唯一不属 OpenAI/Anthropic 系的那一家，也是本项目的第四种线协议**。
  端点开关是 `GOOGLE_GEMINI_BASE_URL`（官方支持的环境变量，**不带 `/v1`**：客户端在它后面自己拼
  `/v1beta/models/…`），值必须是 https 或 loopback（`127.0.0.1` / `localhost` / `[::1]`）——mock 正好
  落在允许范围内，所以不需要证书；配错端点的症状是启动即 404（它不会去试 OpenAI 那两条路径）；
- 隔离靠 **`HOME`** 指向沙盒（`playground/antigravity/.home/`）：provider 选择与登录态都在
  `$HOME/.gemini/antigravity-cli/settings.json`，会话与凭据缓存同在一个 HOME 下——**只改某个
  config dir 挡不住用户级配置**（Claude Code 的教训），这里直接换 HOME；demo 每次把沙盒里的
  `settings.json` 覆盖进 `$HOME`（改配置立刻生效）；
- 免登录靠 **`modelProvider: "gemini"` + `GEMINI_API_KEY`**（官方文档写明的 CI / headless 用法）：
  账号模式在这条路径上要开浏览器走 OAuth，起不来。key 给假值即可（mock 不校验鉴权），
  但**变量必须存在**，缺了 CLI 直接退出；
- **死代理**：agy 会碰 Google 自家的服务（自升级检查、遥测），本机到 Google 的连接是停住的，
  不处理就挂到超时上。demo 只对 harness 及其子进程注入 `HTTPS_PROXY=http://127.0.0.1:9` 让它快速
  失败，并用 `NO_PROXY` 保住本地 mock 直连（与 Codex 那份同一套路）；此沙盒不适用于依赖外部
  HTTPS 的剧本；
- 权限：headless 下审批**无处可批**，默认策略会把需要审批的工具**软拒**（agent 拿到拒绝继续跑，
  白费一轮），所以固定带 `--dangerously-skip-permissions`，剧本自觉只放只读命令；
- 工具集实测 9 个（`view_file` / **`run_command`** / `manage_task` / `write_to_file` /
  `replace_file_content` / `generate_image` / `read_url_content` / `search_web` / `ask_question`），
  声明走 `parametersJsonSchema`（JSON Schema 2020-12）而不是旧的 Gemini `parameters` 字段；
  shell 工具 `run_command` 的五个参数**全必填**——`CommandLine` / `Cwd` / `WaitMsBeforeAsync` /
  `toolSummary` / `toolAction`（缺任何一项都被工具自己拒掉），所以剧本用
  `gen-long-run.ts --args commandline` 生成（参数名是大驼峰，与其余各家的 snake_case 不同）；
- **消费规律：标题生成在最前，压缩摘要途中插队**（都要算进剧本条数）：
  1. **序列第一条**是**会话标题生成**请求（模型 `gemini-3.1-flash-lite-preview`，同一个端点、
     同一个 key，`systemInstruction` 里写着 "conversation title generator"）——它在**最前面**，
     与 peri 的预测请求（在最后）正好相反；
  2. 之后每轮工具调用一条主请求（模型 `gemini-3.1-pro-preview`，`tools=9`）；
  3. 每约 32 个请求插一条**上下文压缩**（`last=user:"Your main task now is to generate a
     continuation summary of …"`），同样取号——与 pi 的压缩同类，只是节奏更规整。
  实测 `--turns 104` 正好 100 个工具轮（104 − 3 条压缩 − 1 条收尾）；`--turns 100` 只有 96 轮、
  `103` 只有 99 轮。它没有 peri 那样的预测请求，所以尾部第二条空白收尾它用不到（留着无害）；
- `-p` 文本模式下**工具输出不进 stdout**（`harness.log` 里看不到命令回显，别据此判「工具没执行」）；
  要看执行细节加 `--output-format stream-json`；
- `--print-timeout` 实测默认 0（不限时），loop 剧本不会自行收敛——收敛要靠有限长剧本 +
  `--exhausted stop` 的收尾文本；
- **本地这批读数还是「单跑」的**：`data/runs/antigravity/` 里的产物带 `--label agy-probe`，与第五批
  （`codex-proxy-fix`）隔了一夜，图表页会画出它们并在页尾告警「混批」（机制见「统一计分」那节的
  「一张图不许混批」）。**CI 的 harness 清单已经加上它**（装 agy 与跑批两处，见
  `.github/workflows/benchmark-pages.yml`）：下一次 CI 批次就是同批的读数（agy、opencode2、
  hermes 与 cline 都在里面），发布出去的那张图自然不会有混批告警（线上站点的数据是 CI 自己现跑现生成的，
  本地 `data/runs` 进不去）。

### Hermes Agent（`hermes`）

- 二进制从 PATH 找（`Bun.which("hermes")`，实测 **v0.21.3 / 2026.9.14**，官方 `install.sh` 装到
  `~/.local/bin/hermes`）；harness 命令是 `hermes --yolo -z '<prompt>'`：`-z`/`--oneshot` 是官方的
  **脚本化一次性入口**（单 prompt 进、最终回答出，stdout 上不带 banner/spinner/工具预览），
  `--yolo` 是全局选项、关掉危险命令的审批——headless 下无人可批，与 Claude Code / agy / mcode 同理，
  剧本自觉只放只读命令；
- 走 **OpenAI Chat Completions**（`POST {base_url}/chat/completions`，主流程 `stream: true`），
  与 peri / opencode / pi / dsh / mcode 同协议；
- 隔离靠 **`HERMES_HOME`** 指向沙盒（`playground/hermes/.hermes/`）：`config.yaml`、`.env`、
  `sessions/`、`state.db`、`skills/`、`logs/` 全从它找（官方安装脚本自己的 `--hermes-home` 就是它）。
  **代码不随 HERMES_HOME 走**：`~/.local/bin/hermes` 是个把 `~/.hermes/hermes-agent` 写死的启动壳，
  所以换 HERMES_HOME 只换数据、不动代码（实测）；
- **provider 只能靠配置文件**：`model.provider: custom` + `model.base_url` + `model.default`
  （形状取自官方模板 `cli-config.yaml.example` 与它自己 eval 里的 mock 配置），**不吃环境变量插值**，
  所以 demo 每次按本次端口重写沙盒里的 `config.yaml`（与 pi 的 models.json、mcode 的 config.yaml 同理）；
  `.env` 里给个假 `OPENAI_API_KEY`（mock 不校验鉴权）；
- 环境变量沿用它自己 eval（`evals/codebase_navigability/runtime_bench.py`）的那套：
  `HERMES_SKIP_UPDATE_CHECK=1`（跳启动时的版本检查）、`NO_COLOR=1`、`TERM=dumb`；另加**死代理**
  （`HTTPS_PROXY=http://127.0.0.1:9` + `NO_PROXY` 保住本地 mock，与 codex / agy 同一套路）。
  死代理**实测不是必需的**：拿「黑洞代理」（接连接不回包）与死代理对跑，启动 7.87s vs 7.83s，
  没有差别——说明它的启动不依赖外部网络，留着是挡运行期可能出现的遥测/目录请求；
- 工具形状：shell 工具叫 **`terminal`**、参数 `{command}` 必填（另有 background / timeout / workdir /
  pty / notify 可选），所以默认剧本是自家那份 `data/scenarios/long-run-hermes.json`
  （`gen-long-run.ts --tool terminal` 生成）；
- **消费规律（两笔手续费 + 一次可选收尾，都要算进剧本条数；实测 `--turns 102` = 104 条 → 100 个
  工具轮）**：
  1. **会话标题生成**（`stream=false`、`messages=2`、无 tools，system 是 "You name chat
     sessions."）与主请求**几乎同时发出、谁先不定**（5 次实测 3 次标题在前、2 次主请求在前），
     合计吃掉开头那一条——与 opencode2 / agy 的标题请求同类（那两家固定在第一条，它这里不定）；
  2. 途中**一次上下文压缩**：上下文涨到约 170 条消息时插一条
     `messages=1`、`last=user:"You are a summarization agent creating a context checkpoint."`，
     随后历史被压到 21 条，紧接着一条把原任务重述的主请求（`messages=21`，
     `last=user:"[STILL IN PROGRESS — this is the active request, restated af…"`）
     ——**前后两条都取号**，与 pi / agy 的压缩同类；
  3. 主流程吃到收尾文本**之后**还可能再发一条技能库复盘
     （`last=user:"Review the conversation above and update the skill library."`）——它落在尾部那条
     **空白**收尾上（与 peri 的预测请求同一个位置），所以那个空白条对 hermes 也有用。实测它**不是
     每次都发**（同一剧本 4 次运行里 1 次发了，那次请求数 104），发不发都不影响轮数。
  实测 `--turns 102`（104 条）正好 100 个工具轮；少一条（`--turns 101`，103 条）就只有 99 轮。
  **数轮数别看 `last=tool` 的条数**：本轮 103 个请求里带工具结果的只有 99 条，比轮数少 1，
  因为压缩前那一轮的工具结果被折进了摘要、没有再单独回传（要看剧本被执行到第几条）；
- **启动段偏大：首个请求前固定 ~6s，且这段在跑满一个核**——逐拍实测从首次采样（t≈0.3s）起 CPU
  就贴着 **100%**（99.7~104.4%，不是空等）、RSS 前 3 秒恒定在 102~110MB（第 5 秒才涨到 135~174MB），
  整段 5.43~5.67 核·秒 ≈ 0.93 核 × 6s，按 1:1 折 **6.1~6.4 CU、占整段 CU 的 58%**（运转段 100 轮
  只占 40%）。`hermes --version` 只要 0.25s，所以不是解释器冷启动；它自己的 `logs/agent.log` 在这段
  里只在起进程后约 0.3s 记了三行「注册 browser 插件」，之后到首个请求之间没有输出，死代理与否也不
  改变它（见上一条）——**根因没定位到底，照实记成它的固定成本**。三次读数完全一致（端到端
  10.7~11.0s、RSS 均值 147~148MB / 峰值 201~203MB、CU 10.6~10.9），详细读数见 `docs/perf-compare.md`；
- 自行收尾时 `harness.log` 里有完整最终回答（退出码 0），与 pi / peri 被强杀时的空文件不同。

### Cline（`cline`）

- 二进制从 PATH 找（`Bun.which("cline")`，实测 **3.0.62**，`npm i -g cline`；官方仓库 `cline/cline`
  的 `apps/cli`，产品站 cline.bot 是营销页、issue 区在仓库）；harness 命令是
  `cline --config <沙盒> --data-dir <沙盒>/data --hooks-dir <沙盒>/hooks -c <work-dir> -P openai-compatible -m llm-mock '<prompt>'`：
  位置参数就是任务文本，默认进 act 模式、**自动批准所有工具**（`--auto-approve` 默认 true，
  headless 下没有确认弹窗），剧本自觉只放只读命令；
- 走 **OpenAI Chat Completions**（`POST {baseURL}/chat/completions`、`stream: true`，带
  `stream_options.include_usage` 与 `tool_choice: "auto"`），与 peri / pi / dsh / mcode / hermes
  同协议；provider 用内置的 `openai-compatible` 那支，`/chat/completions` 由它自己拼，所以配置里的
  baseUrl **要带 `/v1`**；
- 隔离靠 **`--config` + `--data-dir` + `--hooks-dir`** 三个位置参数（默认分别是 `~/.cline`、
  `~/.cline/data`、`~/.cline/hooks`）：provider 配置、会话库、缓存、hooks 全落沙盒。
  **不用换 HOME**——实测在 `$HOME/.cline` 放一份指向死端口的 provider 配置当诱饵，demo 的命令照样
  打到 mock（这一点与 Claude Code / agy 相反，那两家的用户级配置只按 HOME 找）；
- **provider 配置只能靠文件**：`<data-dir>/settings/providers.json`（`cline auth --provider
  openai-compatible --baseurl … --modelid …` 写出来的那份），不吃 base URL 的环境变量插值，所以
  demo 每次按本次端口重写它（与 pi 的 models.json、mcode 的 config.yaml、hermes 的 config.yaml 同理）。
  **手写这份就够**，不必调 `cline auth` 子进程（那会多起一个进程 + 一次外部请求，启动段不该混进这些）；
  apiKey 给假值即可（mock 不校验鉴权）；
- **不给它注入死代理**（Codex / agy 那份）：实测 HTTPS 出口指到 `127.0.0.1:9` 之后，5 轮小剧本的
  端到端从 1.7~2.2s 涨到 8~10s（它对着代理重试）；它自己要的外部请求只有 feature-flags 拉取（落成
  沙盒里的 `cache/feature-flags.json`，首次之后走缓存、不阻塞主流程）。demo 只关遥测与自升级检查
  （`DISABLE_TELEMETRY=1` / `CLINE_NO_AUTO_UPDATE=1`），再加 `NO_PROXY` 保住本地直连；
- **位置参数含空白才被当 prompt**：3.0.62 的解析是 `/\s/.test(arg)`，不含空白就落进「当子命令解析」
  的分支、报 `Unknown command or unquoted prompt` 并以 1 退出。仓库默认 prompt 是中文、没有空格，
  所以 demo 补一个尾随空格（只进 messages 首条 user，不影响读数）；
- 工具集 26 个，shell 工具叫 **`run_commands`**、参数是**字符串数组** `{commands: [...]}`（schema 里
  required 只有 commands、items 是 string）——**十家里唯一的数组形状**，所以剧本用
  `gen-long-run.ts --args commands` 生成，自家那份是 `data/scenarios/long-run-cline.json`；
- **消费规律：一次上下文压缩吃掉一条剧本**（默认 `--compaction agentic`）：一次 prompt 起步就是主请求
  （`messages=2`：system + user，**没有标题生成那一步**），之后每轮工具调用一条主请求；上下文长到阈值
  时它把当轮换成一条「续写摘要」请求（`messages=2`、`last=user:"Summarize this session for
  continuation. Be concise and fact…"`，**响应被当摘要用掉、当轮工具调用不再执行**），随后带着压缩后的
  上下文（实测 `messages=40`）把最后一个工具结果再发一次。标准剧本（100 轮 × 4KB）实测**每约 90 轮
  触发 1 次**：`--turns 101`（103 条）实耗 **102 条请求 = 100 个工具轮 + 1 条压缩 + 1 条收尾**，
  尾部那条空白收尾它用不到（没有 peri 那种预测请求）；200 轮实测 2 次，所以条数按「每 100 轮 +1、
  向上取整」留（CI 里写的就是 `TURNS + (TURNS + 99) / 100`）；
- **它是「Node 启动壳 + 真干活的子进程」**：npm 的 bin 是个解析器脚本（Node，约 60MB RSS、CPU 近 0），
  真干活的是它 spawn 出来的单文件二进制（进程树 `procs` 峰值 2，**97% 的 CPU 记在那一个子进程上**）
  ——与 Codex / opencode2 同类，这正是计分口径固定用**进程树**的又一个理由；
- **口径缺口：它的 CU 是下界**。工具命令由那个子进程再拉一个短命 shell（实测拿 `sleep 2` 当命令，
  `procs` 能顶到 3），这些 shell 活不过进程树的 2s 刷新窗口，CPU 又记在**子进程**（不是根进程）的
  `ri_child_*` 计数器上，而采样器只读**根进程**的计数器 → 这一小笔既没进 `tree_cpu_pct` 也没进
  `child_cpu_pct`。按本机 `sh -c` 的单价粗估（实测 2~3ms/次 × 100 轮 ≈ 0.2~0.3 核·秒，约占它整段
  CPU 的两成），读它的 CU 时按此上修、别当精确值；
- **收尾段固定 1.6~1.9s 零请求，而且它很贵**（三次实测）：主流程吃到尾部那条纯文本即自行退出
  （退出码 0），但退出前有约 1.8s 不发任何请求的空档——与 peri 的 5.0s、Codex 的 10.1s 同类，
  只是量级小得多，根因没查到底，照实记成它的固定成本。它**占整段 CU 的 33%~43%**
  （1.12~1.47 CU，几乎全是内存面积：这 1.8s 顶着约 700MB 常驻）——与 Codex 那笔 10s 空等一样，
  是「零 CPU 的空等照样花钱」的又一个实例，读它的 CU 时别只看运转段；
- `harness.log` 有内容（自行收尾时 stdout 里是最终回答）；每次请求 stderr 上会带一条 AI SDK 的
  `Deprecated: "providerOptions key 'openai-compatible'"` 警告，是它自己包里的用法告警，不影响读数。

## 已知限制与坑（压测相关）

- **`--max-turns` 在 peri 的 `-p` 模式下是空操作**，所以压测时长由 `--timeout-ms` 兜底，
  而不是轮数；`--turns` 只是原样透传给 harness；
- **peri 在 `-p` 模式下只在退出时 flush 输出**：被超时强杀时 `<runId>-harness.log` 会是空文件
  （工具会在 perf.log 里写明原因）；自行收敛时该文件有内容。**pi 同样如此**（实测自行收尾时
  harness.log 有完整回答，loop 剧本被强杀时为空）。**opencode / opencode2 / Claude Code / dsh /
  cline 是持续流式的**，被强杀也留有输出；
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
  长剧本里吃的是尾部那条空白），opencode（v1）、opencode2 与 dsh 发「会话标题生成」（dsh 那条来自
  `dsh-session-title-first-prompt-llm`，只看首条 prompt，一次会话一条；opencode / opencode2 那两条
  出现在启动期，`messages=2`、无 tools）；**pi 的
  上下文压缩也会发请求**——pi 默认开压缩（`compaction.enabled=true`，`reserveTokens` 16384 /
  `keepRecentTokens` 20000），从约 140 条消息起每轮追加一条 `messages=2` 的总结；**agy 两样都有**——
  标题生成在**序列第一条**（`gemini-3.1-flash-lite-preview`，`systemInstruction` 里写着
  "conversation title generator"），压缩摘要每约 32 个请求插一条（`last=user:"Your main task now is
  to generate a continuation summary of …"`），所以 100 轮要 104 条剧本；**opencode2 只有标题那一条**
  ——序列第一条就是它（"You are a title generator"，`messages=2`、无 tools），之后 100 轮内没有压缩
  请求，所以 100 轮要 101 条剧本；**hermes 三处都有**——标题（`stream=false`、无 tools）与主请求
  几乎同时发出、**谁先不定**（5 次实测 3 次标题在前、2 次主请求在前，合计仍只吃掉开头一条）、
  途中一次压缩（约 170 条消息时 `last=user:"You are a summarization agent creating a context
  checkpoint."`，随后历史压到 21 条）、主流程收尾之后还可能发一条技能库复盘
  （"Review the conversation above and update the skill library."，落在尾部那条空白上，且**不是每次
  都发**），所以 100 轮要 104 条剧本（`--turns 102`）；**cline 是压缩那一路**——没有标题生成，
  但默认 `--compaction agentic`，实测每约 90 轮把当轮换成一条 `messages=2` 的续写摘要请求
  （"Summarize this session for continuation…"），所以 100 轮要 103 条剧本（`--turns 101`）；
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
- **Codex 退出固定等 ~10.1s：demo 已规避**：退出时向 `https://chatgpt.com/backend-api/plugins/featured` 发请求，
  本机 DNS 污染 → 连接停在 SYN_SENT → 10s 超时。demo 仅对 harness 及其子进程注入
  `HTTPS_PROXY` / `https_proxy=http://127.0.0.1:9`，让外部 HTTPS 快速失败（本机 9 端口须未监听），
  并覆盖 `NO_PROXY` / `no_proxy` 为本地地址以保证 mock 直连；不改全局代理或 Codex 配置。
  三轮工具调用实测收尾 10.2s → 0.1s，4 个请求、退出码 0；`features.plugins=false` 单独无效。
  沙盒不适用于依赖外部 HTTPS 的剧本；历史排名不回填，新排名须重跑完整批次；
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
  Responses 的 function_call / custom_tool_call → Gemini 的 `functionCall`（`arguments` 解析成
  `args` 对象。**注意 `functionCall.id` 是配对的必需项**：OpenAI / Anthropic 那边 id 只是标签，
  这边工具结果要按它回填 `functionResponse.id`，所以适配器必须给每个调用补一个 id）；
- Gemini 那条路由的**流式与否写在路径上**（`:streamGenerateContent` / `:generateContent`），不在
  请求体里——所以 `ProtocolAdapter.isStream` / `describe` 收的第二个参数是 `req.path`（其余各协议
  从 body 判断，签名多出来的参数对它们是惰性的）；路由用普通参数 + 白名单守卫，别写成 Hono 的正则
  参数（`:p{[^/]*generateContent}` 这类**贪心量词 + 字面量不会回溯**，实测直接 404）；
- 节奏优先级：命令行 / 环境变量 > 脚本 `defaults` > 内置值；`chunkSize` 按 grapheme 切分，不拆坏 emoji；
- `usage` 未声明时按字符估算（CJK 1 token/字，其余 4 字符 1 token），要精确值就在条目里显式写；
- 不校验鉴权（`Authorization` / `x-goog-api-key` 都收，值随便给）；`/v1/models` 返回配置的模型名；`choices` 恒为 1；
- 脚本消耗比预期快时，先看 mock 的访问日志确认是哪类请求在取号；
- **harness 的「谁更省」看统一计分**（**Beta**，口径见上）：**面积**（`CU` = 1.0 × 核·秒 +
  1.0 × GB·秒）与**峰值**（不折算）两个口径一起引，别只挑一个（也别另起一套指标）；口径只在
  `scripts/perf/score.ts` 一处，改口径要显式、重跑整批。因为还是 Beta，给结论时把「CU 这么算」
  一并说清（含后代 CPU、尾部补齐两处取舍），别只报一个名次；
- 改动后跑 `bun test` + `bun run typecheck`；中文注释与文档。
