# harness-perf-benchmark

A controlled benchmark for measuring the **CPU and memory usage** of AI coding harnesses during long-running, tool-using tasks.

The benchmark does not call a real model. Every harness talks to the same local scripted mock, receives the same workload shape, and is measured together with its child processes. Network latency, model inference, GPU usage, and external service resources are outside the measurement scope.

> Results are relative to this benchmark batch and its test environment. They should not be treated as absolute numbers across different machines, operating systems, harness versions, or configurations.

## Benchmark Results

**Test batch:** September 19, 2026 · macOS · Apple Silicon · 18 cores<br>
**Sampling:** 100 ms intervals · `proc_pid_rusage` · process-tree accounting<br>
**Runs:** 3 serial runs per harness; the median run is shown<br>
**Workload:** 100 scripted tool-use turns, with approximately 4 KB of response content per turn

| Harness | Version | CPU mean | CPU peak | Memory mean | Memory peak |
| --- | ---: | ---: | ---: | ---: | ---: |
| [pi](https://github.com/earendil-works/pi) | 0.85.1 | 64.8% | 131.6% | 183.1 MB | 226.3 MB |
| [peri](https://github.com/KonghaYao/peri) | 3.17.0 | 32.4% | 43.5% | **55.4 MB** | **72.7 MB** |
| [Claude Code](https://github.com/anthropics/claude-code) | 2.1.277 | 67.0% | 141.5% | 285.2 MB | 333.9 MB |
| [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) | 0.1.5-rc.2 | 46.9% | 150.2% | 190.5 MB | 230.0 MB |
| [Codex CLI](https://github.com/openai/codex) | 0.155.1 | 3.9% | **25.1%** | 135.4 MB | 165.2 MB |
| [MiniMax Code](https://github.com/MiniMax-AI/minimax-code) | 0.4.12 | **97.8%** | 182.8% | **618.7 MB** | **895.6 MB** |

### Reading the results

- CPU is reported using a **single-core 100% scale**. Multi-threaded processes can exceed 100%.
- CPU and memory use the **process-tree** view, including harness child processes used for tool execution.
- Memory is resident set size (RSS), not virtual memory or the size of disk caches.
- In this batch, peri had the lowest mean and peak memory usage. MiniMax Code had the highest mean CPU and memory usage.
- Codex's main process is not representative of its full workload; its child processes are included in the process-tree measurements.

### OpenCode was removed from the leaderboard

[OpenCode](https://github.com/anomalyco/opencode) is still supported by the repository's sandbox and can be benchmarked separately, but it is not included in the current leaderboard.

Its benchmark result was substantially worse than the other harnesses: **69.9% mean CPU / 229.3% peak CPU** and **798.9 MB mean memory / 943.0 MB peak memory**. These values were far above the rest of the batch, so OpenCode was removed from the regular ranking rather than compressing the useful comparison between the remaining harnesses. Its integration code remains available for independent reproduction.

## Methodology

### Harnesses and integrations

| Harness | Source repository | Protocol | Benchmark integration |
| --- | --- | --- | --- |
| peri | [KonghaYao/peri](https://github.com/KonghaYao/peri) | OpenAI Chat Completions | Runtime settings and an isolated session database |
| OpenCode | [anomalyco/opencode](https://github.com/anomalyco/opencode) | OpenAI Chat Completions | Project config, environment substitution, and isolated XDG directories |
| Claude Code | [anthropics/claude-code](https://github.com/anthropics/claude-code) | Anthropic Messages | Isolated `HOME` and `CLAUDE_CONFIG_DIR` |
| Codex CLI | [openai/codex](https://github.com/openai/codex) | OpenAI Responses | Isolated `CODEX_HOME` and provider override |
| pi | [earendil-works/pi](https://github.com/earendil-works/pi) | OpenAI Chat Completions | Isolated `PI_CODING_AGENT_DIR` and generated model config |
| DeepSeek Harness (`dsh`) | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | OpenAI Chat Completions | Isolated `DSH_HOME` and provider environment variables |
| MiniMax Code | [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | OpenAI Chat Completions | Isolated `MINIMAX_DATA_DIR` and generated provider config |

Each harness runs in its own playground sandbox. The mock protocol adapter and tool schema match the harness under test; this avoids treating unsupported tool names or protocol mismatches as performance data.

### Sampling

- macOS `proc_pid_rusage` is used by default. CPU is calculated from the difference between cumulative readings over each sampling interval.
- The sampler records root-process CPU/RSS, process-tree CPU/RSS, process count, and CPU accumulated by short-lived child processes.
- Short-lived tool processes may disappear before the next process-tree refresh. Their accumulated CPU is therefore captured through the parent process's child-process counters when available.
- Raw samples are written to `samples.csv`. Each run also writes `run.json`, `perf.log`, `harness.log`, and `mock.log` under `data/runs/<harness>/<runId>/`.
- The sampler validation experiment can be run with:

```sh
bun run scripts/perf/verify.ts
```

### Workload generation

The workload is generated rather than hand-maintained. It contains a finite sequence of assistant responses and tool calls, followed by explicit completion responses so that a harness can finish naturally.

The tool shape is adapted to each harness:

- `Bash` with `{command}` for peri, OpenCode, and Claude Code;
- `exec` with JavaScript source for Codex;
- lowercase `bash` for pi and MiniMax Code;
- lowercase `bash` with `{command, description}` for DeepSeek Harness.

Some harnesses issue additional internal requests, such as context compaction or session-title generation. The benchmark accounts for these requests when sizing each harness's script.

## Reproduce the benchmark

### Generate workload scripts

```sh
# peri / Claude Code / OpenCode
bun run scripts/perf/gen-long-run.ts \
  --turns 100 \
  --out data/scenarios/long-run.json

# Codex CLI
bun run scripts/perf/gen-long-run.ts \
  --turns 100 \
  --args exec \
  --out data/scenarios/long-run-codex.json

# pi: reserve entries for automatic context compaction
bun run scripts/perf/gen-long-run.ts \
  --turns 133 \
  --tool bash \
  --out data/scenarios/long-run-pi.json

# DeepSeek Harness
bun run scripts/perf/gen-long-run.ts \
  --turns 100 \
  --tool bash \
  --args command+description \
  --out data/scenarios/long-run-dsh.json

# MiniMax Code
bun run scripts/perf/gen-long-run.ts \
  --turns 100 \
  --tool bash \
  --out data/scenarios/long-run-minimax-code.json
```

### Run a harness

Each playground entry point starts the local mock, injects an isolated configuration, launches its harness, samples the process tree, and writes one run directory. The corresponding harness binary must be available on `PATH`.

```sh
cd playground/peri         && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/opencode     && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/claude-code  && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/codex        && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/pi           && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/deepseek     && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/minimax-code && bun perf-demo.ts --exhausted stop --timeout-ms 600000
```

To use the generic runner directly:

```sh
bun run scripts/perf/run.ts \
  --script data/scenarios/long-run.json \
  --exhausted stop \
  --timeout-ms 600000
```

The generic runner requires `--script`; use the harness-specific playground entry points when running anything other than peri.

## Quick Start

This project uses Bun and has Hono as its only runtime dependency:

```sh
bun install
bun run src/server.ts --script script.json
```

The script path is required. The mock listens on port `3457` by default:

```sh
curl -s http://localhost:3457/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Inspect the project"}]}'
```
