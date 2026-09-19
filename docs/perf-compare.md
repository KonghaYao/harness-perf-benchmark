# 压测对比：peri vs opencode

用 llm-mock 以受控负载测量两个 harness 的资源开销。测量时间 2026-09-19，机器 macOS（Apple Silicon），
采样间隔 100ms（`proc_pid_rusage`，CPU 为**单核 100%** 口径，不采 GPU）。

## 结论速览

1. **内存差 6~7 倍**：opencode 常驻基线约 800MB（启动 10s 内建立），peri 约 120MB；
   大输出场景 opencode 峰值 1.27~1.37GB，peri 0.51~0.69GB。
2. **CPU 形态不同**：opencode 持续多核并行（峰值 240~286%），peri 以单核为主（峰值 80~164%）。
3. **吞吐**：同样 60s 的大输出场景，peri 完成 209~244 次请求，opencode 167~184 次；小响应场景 peri 快一倍。
4. **收敛行为**：小响应场景 peri 约 47s 后自行收敛退出（exit 0）；opencode 持续工作直到被超时终止。

## 测试条件

- **mock**：llm-mock 本仓库，剧本 `--exhausted loop` 持续供压（不成为瓶颈）。
- **场景 A（小响应）**：`scripts/perf-scenario.json` —— 4 条短 Bash 工具调用循环，每条响应 < 200 字符。
- **场景 B（大输出）**：`data/scenarios/large-md.json`（`bun run scripts/perf/gen-large-md.ts` 生成）——
  4 × 65KB markdown（标题/列表/代码块/表格/中英混排）+ Bash 调用循环。
- **采样工具**：`scripts/perf/run.ts`，每 100ms 一次；RSS 分主进程与进程树。
- **peri 0.2.0**（`../perihelion/target/debug/peri`）：
  `peri -p '<prompt>' --max-turns 25 --dangerously-skip-permissions --no-session-persistence`，
  工作目录 `playground/peri`，会话库隔离在沙盒内。
- **opencode 1.17.12**（`~/.bun/bin/opencode`）：
  `opencode run '<prompt>' --model llm-mock/llm-mock --pure`，
  工作目录 `playground/opencode`（`opencode.json` 定义 mock provider），XDG 数据目录隔离在沙盒内。
- 两者均冷启动；每格为 2 次独立测量，取范围。

## 结果

### 场景 A：小响应循环

| 指标 | peri | opencode |
| --- | --- | --- |
| 时长 | **47.2s**（自然收敛，exit 0） | **60.0s**（超时终止） |
| CPU 均值 / 峰值 | 45.9~46.0% / 80.3~82.6% | 52.1~54.3% / **240.0~246.7%** |
| RSS 均值 / 峰值 | 118.8~119.5MB / 131.9~133.9MB | **811.4~822.2MB / 886.5~903.0MB** |
| 请求数（速率） | 501（10.6 次/秒） | 282~311（4.7~5.2 次/秒） |
| 启动 10s 时 RSS | ~113MB | **~797MB** |
| 进程树增量 | +48MB（一个 MCP python 子进程） | ≈0（无额外子进程） |

### 场景 B：大 markdown 输出（4 × 65KB）

| 指标 | peri | opencode |
| --- | --- | --- |
| 时长 | 60.0s（超时终止） | 60.0s（超时终止） |
| CPU 均值 / 峰值 | **90.5~101.6%** / 152.6~164.2% | 73.8~75.3% / **258.5~285.5%** |
| RSS 均值 / 峰值 | 365.1~472.5MB / 508.0~692.6MB | **1047.1~1213.6MB / 1273.3~1374.9MB** |
| 请求数（速率） | 209~244（3.5~4.1 次/秒） | 167~184（2.8~3.1 次/秒） |
| 启动 10s 时 RSS | ~280MB | ~994MB |

## 时间线特征（每 10s 抽样）

```
通道                        t=0.1s   10.1s    20.1s    30.1s    40.1s    50.1s
peri    ·小响应 CPU         25.2%    41.8%    69.1%    56.3%    71.4%     —
peri    ·小响应 RSS         40.9MB   113.3MB  121.1MB  127.0MB  130.9MB   —
opencode·小响应 CPU         52.2%    52.4%    63.7%    53.2%    49.2%    55.5%
opencode·小响应 RSS         53.6MB   797.4MB  856.0MB  870.4MB  889.6MB  766.2MB
peri    ·大输出 CPU         24.7%   102.1%   102.9%   102.1%    99.9%   105.6%
peri    ·大输出 RSS         41.9MB   280.2MB  438.6MB  517.6MB  607.5MB  615.8MB
opencode·大输出 CPU        115.1%    85.7%    41.2%    50.5%    91.9%    49.0%
opencode·大输出 RSS         90.0MB   993.7MB 1125.0MB 1204.0MB  994.4MB  981.8MB
```

- **opencode 的内存台阶发生在启动阶段**：10s 内从 ~54MB 冲到 ~797MB，之后缓慢增长；
  大输出下在 1.0~1.2GB 区间**回落再涨**（GC 回收可见），peri 则是单调爬升（上下文累积）。
- **CPU 形态**：peri 在大输出下稳定贴着单核满载（~100%）；opencode 在 41~92% 间大幅波动，
  但峰值冲到 2.4~2.9 核——处理是间歇 + 并发的。
- peri 进程树稳定多一个子进程（MCP，+48~56MB）；opencode `--pure` 下没有常驻子进程。

## 解读

- opencode 是 Bun/TS 应用，常驻基线高、且启动会做会话/快照/技能索引等初始化（其数据目录已隔离，
  排除了历史数据影响）；peri 是 Rust 单二进制，基线约 120MB。
- opencode 的 CPU 峰值 >200% 说明其工作是多线程/异步分摊的；peri 的峰值 152~164% 也超过单核，
  但主体仍是一核打满的串行处理。
- 大输出场景下两者单位请求的 CPU 成本接近（peri ≈0.25 核秒/请求，opencode ≈0.24），
  差异主要在内存规模与处理节奏，而非处理效率本身。

## 复现

```sh
cd playground/peri      && bun perf-demo.ts --timeout-ms 60000                                  # peri · 小响应
cd playground/peri      && bun perf-demo.ts --script data/scenarios/large-md.json --timeout-ms 60000   # peri · 大输出
cd playground/opencode  && bun perf-demo.ts --timeout-ms 60000                                  # opencode · 小响应
cd playground/opencode  && bun perf-demo.ts --script data/scenarios/large-md.json --timeout-ms 60000   # opencode · 大输出
```

产物在 `data/claude-date/<runId>-{perf.log,samples.csv,harness.log,mock.log}`（本报告数据取自
`20260919-103339 / 104341 / 104432 / 104539 / 104643 / 104754 / 104858` 等 run）。

## 局限

- 单机、每格 2 次测量；peri 大输出两次差异偏大（RSS 峰值 508MB vs 693MB），已在表中以范围呈现。
- 两个 harness 的启动参数各自取"能跑通的最小集合"，未刻意对齐功能（如 peri 无插件系统、
  opencode 用 `--pure` 跳过插件），对比的是各自的真实形态。
- 采样对象为 harness 主进程 + 进程树；GPU 未测；mock 自身开销（约 2% 单核）不参与统计。
