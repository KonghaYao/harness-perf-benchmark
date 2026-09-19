# 压测对比：四种 harness

用 llm-mock 以受控负载测量各 harness 自身的资源开销。测量时间 2026-09-19，机器 macOS（Apple Silicon），
采样间隔 100ms（`proc_pid_rusage`，CPU 为**单核 100%** 口径，不采 GPU），每轮 30s / 约 300 个样本。

被测对象与接入方式：

| harness | 版本 | 线协议 | 接入点 | 沙盒隔离 |
| --- | --- | --- | --- | --- |
| peri | 3.17.0（PATH） | OpenAI Chat Completions | `--settings <JSON>` | `--db-path` 会话库 |
| opencode | 1.17.12 | OpenAI Chat Completions | 随 cwd 的 `opencode.json` + `{env:LLM_MOCK_BASE_URL}` | `XDG_*` |
| Claude Code | 2.1.277 | Anthropic Messages | `ANTHROPIC_BASE_URL` 等环境变量 | `HOME` + `CLAUDE_CONFIG_DIR` |
| Codex | 0.155.1 | OpenAI Responses | `CODEX_HOME/config.toml` 的 provider | `CODEX_HOME` |

统一口径：每个 harness 都在自己的 playground 沙盒里、用同一份剧本与同一个 `--timeout-ms 30000` 跑
（`cd playground/<名> && bun perf-demo.ts …`）。剧本节奏刻意压小（`delayMs=10 / chunkDelayMs=1 /
chunkSize=4`），mock 不是瓶颈；测的是 harness 主进程 + 进程树。

## 复现

```sh
# 短响应 + 短工具调用循环（scripts/perf-scenario.json，--exhausted loop）
cd playground/peri        && bun perf-demo.ts --timeout-ms 30000
cd playground/opencode    && bun perf-demo.ts --timeout-ms 30000
cd playground/claude-code && bun perf-demo.ts --timeout-ms 30000
cd playground/codex       && bun perf-demo.ts --timeout-ms 30000   # 默认用 scripts/codex-scenario.json

# 超大 markdown 输出（4×65KB，先跑生成器；codex 的工具形状与其它三家不同，要单独生成一份）
bun run scripts/perf/gen-large-md.ts --size-kb 64 --responses 4   # → data/scenarios/large-md.json
bun run scripts/perf/gen-large-md.ts --tool exec --out data/scenarios/large-md-codex.json
cd playground/peri        && bun perf-demo.ts --script data/scenarios/large-md.json --timeout-ms 30000
cd playground/claude-code && bun perf-demo.ts --script data/scenarios/large-md.json --timeout-ms 30000
cd playground/codex       && bun perf-demo.ts --script data/scenarios/large-md-codex.json --timeout-ms 30000
```

产物在 `data/claude-date/`：`<runId>-{perf.log,samples.csv,harness.log,mock.log}`。

## 结论速览

- **短剧本（工具调用循环）**：peri 最省（16.1% 单核 / 81MB 常驻），opencode 最重
  （53.7% / 825MB，峰值冲到 263% 单核），Claude Code 居中（33.4% / 361MB），
  Codex 读数最低（7.5% / 154MB 进程树）但节奏也最慢（30s 只走了 271 次请求）。
- **超大 markdown（4×65KB 流）**：peri / opencode / Claude Code 的 CPU 都抬到 67%~77%，
  常驻内存显著上涨（peri 81MB → 575MB，Claude Code 361MB → 479MB，opencode 825MB → 857MB）；
  Codex 17.6% / 188MB。三家同量级的读数说明这一档负载主要压在「大流量 SSE 解析 + markdown 渲染 +
  上下文回传」上，而不是各自的工具调度。
- 内存随轮次单调上涨是**预期**：每轮都把历史（上一轮的 65KB 正文 + 工具结果）随请求回传，
  RSS 里既有渲染缓冲也有会话累积。
- Codex 的 CLI 是一层 Node 启动器（`~/.bun/bin/codex` 是 `node` 脚本，真正干活的是它 spawn 出来的
  原生二进制），所以「主进程」读数（0.1% / 42MB）没有意义——**看进程树那一列**。
- 本次测量的机器上还有别的负载（VS Code、perihelion 的 e2e 测试），每轮起跑时的 load average 在
  4.1~8.9 之间，绝对读数偏保守；四家在同样条件下测得，横向比较可用，要更干净的数字请在空闲机器上按上节重跑。

## 结果

### 短剧本：Bash 工具调用循环（30s，`--exhausted loop`）

| harness | mock 请求数 | CPU 均值 | CPU 峰值 | RSS 均值 | RSS 峰值 |
| --- | --- | --- | --- | --- | --- |
| peri 3.17.0 | 501 | 16.1% | 28.7% | 80.9MB | 95.5MB |
| opencode 1.17.12 | 174 | 53.7% | 263.2% | 825.4MB | 903.3MB |
| Claude Code 2.1.277 | 655 | 33.4% | 96.2% | 360.8MB | 397.2MB |
| Codex 0.155.1 | 271 | 7.5% | 19.4% | 153.7MB | 166.8MB |

### 大输出：4×65KB markdown + 工具调用（30s，`--exhausted loop`，chunkSize=64 / chunkDelayMs=0）

| harness | mock 请求数 | CPU 均值 | CPU 峰值 | RSS 均值 | RSS 峰值 |
| --- | --- | --- | --- | --- | --- |
| peri 3.17.0 | 424 | 67.2% | 87.4% | 575.0MB | 963.0MB |
| opencode 1.17.12 | 94 | 76.7% | 235.5% | 857.4MB | 1028.1MB |
| Claude Code 2.1.277 | 807 | 66.8% | 144.0% | 479.4MB | 554.5MB |
| Codex 0.155.1 | 237 | 17.6% | 53.5% | 188.4MB | 230.6MB |

两表的 CPU / RSS 都是**进程树**口径（peri / opencode / Claude Code 的主进程与进程树读数一致，
只有 Codex 需要区分：它的主进程是启动器）。

## 读数怎么读（别踩的坑）

- **请求数不同 = 节奏不同**，不要拿 CPU 均值去除以请求数当「单次请求开销」：各 harness 每轮做的事
  不一样（Codex 每轮工具调用都要新起一个 `/bin/zsh -lc`，而这台机器的 `.zshrc` 里还有 emsdk 初始化；
  opencode 每轮并发处理更重）。要对比单位成本得先统一轮次与工具形态，那是另一组实验。
- **进程树包含工具调用的子进程**：Claude Code / Codex 每次工具调用都 spawn shell，peri 是自己执行，
  opencode 走自己的权限管线。这些差异会体现在 CPU 与 `procs` 列上（`samples.csv` 里有原始逐拍数据）。
- **peri 被强杀时 `harness.log` 是空的**（`-p` 模式只在自行退出时 flush），属已知限制；
  Claude Code 那几轮的退出码 143 就是被工具 SIGTERM 回收，不是崩溃。
- 想看逐拍曲线直接读 `samples.csv`（`ts,elapsed_ms,cpu_pct,rss_kb,tree_cpu_pct,tree_rss_kb,procs`）；
  采样口径的验证实验见 `bun run scripts/perf/verify.ts`。
