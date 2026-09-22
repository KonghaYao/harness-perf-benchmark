# harness-perf-benchmark

A controlled benchmark for measuring the **CPU and memory usage** of AI coding harnesses during long-running, tool-using tasks.

The benchmark does not call a real model. Every harness talks to the same local scripted mock, receives the same workload shape, and is measured together with its child processes. Network latency, model inference, GPU usage, and external service resources are outside the measurement scope.

> Results are relative to their benchmark batch and its test environment. They should not be treated as absolute numbers across different machines, operating systems, harness versions, or configurations.

**Live charts:** [konghayao.github.io/harness-perf-benchmark](https://konghayao.github.io/harness-perf-benchmark/) — the results below as interactive bars (unified score CU, peak CPU, peak memory) with per-sample CPU and memory curves.

## Benchmark Results

**Machine:** macOS · Apple Silicon · 18 cores<br>
**Sampling:** 100 ms intervals · `proc_pid_rusage` · process-tree accounting<br>
**Runs:** 3 serial runs per harness; the median run is shown<br>
**Workload:** 100 scripted tool-use turns, with approximately 4 KB of response content per turn<br>
**Score:** CU = 1 core-second + 1 GB-second of process-tree CPU and memory, integrated over the run

| Harness | Version | CU ↓ | CPU mean | CPU peak | Memory mean | Memory peak |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [ccode](https://github.com/MoyaMryia/ccode) (`ccode-cli`) † | c8fb352 | **0.114** | 47.2% | 99% | **3.8 MB** | **4.4 MB** |
| [pi](https://github.com/earendil-works/pi) | 0.85.1 | 1.271 | 65.5% | 128.8% | 186.2 MB | 234.4 MB |
| [Codex CLI](https://github.com/openai/codex) | 0.155.1 | 1.383 | **10.5%** | **26.0%** | 123.4 MB | 163.7 MB |
| [peri](https://github.com/KonghaYao/peri) | 3.17.0 | 2.102 | 32.6% | 43.7% | 54.7 MB | 71.7 MB |
| [Claude Code](https://github.com/anthropics/claude-code) | 2.1.277 | 2.828 | 71.8% | 122.4% | 310.9 MB | 351.0 MB |
| [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) | 0.1.5-rc.2 | 3.101 | 46.3% | 128.0% | 185.6 MB | 231.2 MB |
| [Cline](https://github.com/cline/cline) (`cline`) † | 3.0.62 | 3.397 | 23.3% | 138.4% | 443.5 MB | 706.1 MB |
| [Kimi Code](https://www.kimi.com/code/) (`kimi`) † | 2.0.0 | 4.364 | 63.5% | 176.8% | 491.9 MB | 603.6 MB |
| [Antigravity CLI](https://antigravity.google) (`agy`) † | 1.2.7 | 4.593 | 173.4% | 213.0% | 208.6 MB | 225.1 MB |
| [OpenCode v2](https://github.com/anomalyco/opencode) (`opencode2`) † | 2.0.10 | 9.595 | 48.6% | 105.2% | 576.1 MB | 849.6 MB |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) (`hermes`) † | 0.21.3 | 10.706 | 73.1% | 131.8% | 147.3 MB | 201.1 MB |
| [MiniMax Code](https://github.com/MiniMax-AI/minimax-code) | 0.4.12 | 31.995 | 98.1% | 177.8% | 617.6 MB | 892.0 MB |

Bold marks the leanest value in each column (lower is leaner in all of them).

† The six unmarked rows come from one batch (label `codex-proxy-fix`, September 19, 2026, 20:39–20:43,
three serial runs each). Antigravity CLI, OpenCode v2, Hermes Agent and Cline were measured in separate
probe batches (labels `agy-probe`, `oc2-probe`, `hermes-probe` and `cline-probe`, September 20), Kimi
Code in its own (label `kimi-probe`, September 21), and ccode on a Linux box (label `265k-linux`,
September 22, Intel Core Ultra 7 265K, procfs sampler at a 10 ms interval — see the peak note below).
**Only CU compares across batches** — it is an absolute quantity, while the other columns are
single-machine readings that move with machine load, so for the † rows treat them as indicative. ccode's
single-sample CPU peak is the one number here that is an artefact rather than a reading: on a 10 ms
sampler one tick is a whole 100%, so any run that does work inside a sample lands on 99%. Its CU is
unaffected — CU integrates the run's cumulative CPU readings, it does not use the peak column at all — so
for this row read CU and the memory columns, not the peak. The CI workflow installs and runs all thirteen
published harnesses under a single batch label, so the next batch it publishes puts every row on the same
footing.

### Reading the results

- CPU is reported using a **single-core 100% scale**. Multi-threaded processes can exceed 100%.
- CPU and memory use the **process-tree** view, including harness child processes used for tool execution.
- Memory is resident set size (RSS), not virtual memory or the size of disk caches.
- CU is an **area**, not a peak: CPU and memory integrated over the whole run, weighted 1:1. The
  coefficients are this project's own choice (documented in `scripts/perf/score.ts`) and the metric is
  **Beta** — use it to order harnesses inside one batch, not as a verdict.
- peri has the lowest mean and peak memory among the twelve established runtimes here; MiniMax Code has
  the highest mean CPU and memory. (ccode is lower than both — see its row.)
- **The process tree is what makes some rows readable.** Codex's main process is only a launcher — the
  work happens in binaries it spawns — and OpenCode v2 has the same shape, with ~95% of its CPU in a
  worker process (`opencode.exe serve --stdio`). Reading the main process alone would undercount both.
- Antigravity CLI is the only harness here on the **Gemini wire protocol** (the mock serves it from
  `src/gemini.ts`), and the only one whose mean CPU exceeds a single core.
- **Hermes Agent spends its CU before it sends anything.** Its first request comes ~6 s after start-up,
  and during those 6 s it pins one core at ~100% (no idle waiting): that segment alone is 58% of its CU,
  against 40% for the 100 tool rounds. Three runs agree within 2%, so it reads as a harness
  characteristic rather than machine noise.
- **Cline is a launcher plus a worker, and its CU is a lower bound.** The npm `cline` bin is a small Node
  resolver (60 MB, ~0 CPU); the work happens in the single-file binary it spawns — 97% of the measured CPU
  is accounted to that child, so the process tree is what makes the row readable. Each shell command is
  spawned by *that child*, i.e. a grandchild of the measured root: it dies inside the 2 s process-tree
  refresh, and its CPU lands on the child's counters, which the sampler does not read — so ~0.2–0.3
  core-seconds per 100 rounds (the local `sh -c` price, about a fifth of the measured CPU) is missing from
  the row. Cline also holds ~1.8 s of *request-free* time at the end of the run before exiting — 33–43%
  of its whole CU, because the CPU stops there while ~700 MB of RSS stays resident (the same lesson as
  Codex's 10 s exit wait: an idle tail is not free).
- **Kimi Code is the fastest harness here end-to-end** — 3.5–3.8 s for the same 100-round script, with
  only ~2.5 s of that in the running segment — but it is not the leanest: it holds ~490 MB of RSS on
  average (~600 MB peak) and runs multi-threaded (mean ~65% of a core, peaks above 170%), so its CU
  (4.36) lands between Cline and Antigravity CLI. Its shell commands are children of the measured root,
  so their ~0.24 core-seconds per run are captured through the child-process counters (the channel Cline's
  grandchildren escape).
- **ccode is the leanest row on the chart, and it is a different kind of program.** It is a single static
  binary (C89 + POSIX, TLS compiled in, no interpreter and no dependency tree), so it starts, runs 100
  tool rounds and exits in 0.26 s with a 4.4 MB RSS peak — a rounded-out memory floor rather than a
  trimmed-down runtime. Two things follow from being that fast. First, its CU (0.114) is dominated by the
  running segment with no measurable start-up or tail cost, while everything else here pays either a
  runtime warm-up or a request-free exit wait. Second, it spends ~47% of one core on average with short
  bursts that a 10 ms sampler cannot resolve, which is why its peak column is the one row to read with
  the footnote above. It makes exactly 100 requests for the 100 rounds with no tail request: with a cap it
  stops at `--max-turns` before the mock's closing entry (this batch passed `--turns 100`); with no cap it
  consumes the closing entry too, which is what the CI's default invocation does.
- **Only CU is comparable across batches.** Durations are load-sensitive — the same script on the same
  machine has produced 19.8 s and 34.7 s for one harness — and any relative score is computed inside a
  single batch by construction.

## Methodology

### Harnesses and integrations

| Harness | Source | Protocol | Benchmark integration |
| --- | --- | --- | --- |
| peri | [KonghaYao/peri](https://github.com/KonghaYao/peri) | OpenAI Chat Completions | Runtime settings and an isolated session database |
| OpenCode v1 | [anomalyco/opencode](https://github.com/anomalyco/opencode) | OpenAI Chat Completions | Project config, environment substitution, and isolated XDG directories |
| OpenCode v2 (`opencode2`) | [anomalyco/opencode](https://github.com/anomalyco/opencode) | OpenAI Chat Completions | The same, plus a dead proxy and a mandatory `--standalone` service mode |
| Claude Code | [anthropics/claude-code](https://github.com/anthropics/claude-code) | Anthropic Messages | Isolated `HOME` and `CLAUDE_CONFIG_DIR` |
| Codex CLI | [openai/codex](https://github.com/openai/codex) | OpenAI Responses | Isolated `CODEX_HOME` and provider override |
| pi | [earendil-works/pi](https://github.com/earendil-works/pi) | OpenAI Chat Completions | Isolated `PI_CODING_AGENT_DIR` and generated model config |
| DeepSeek Harness (`dsh`) | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | OpenAI Chat Completions | Isolated `DSH_HOME` and provider environment variables |
| MiniMax Code | [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | OpenAI Chat Completions | Isolated `MINIMAX_DATA_DIR` and generated provider config |
| Antigravity CLI (`agy`) | [antigravity.google](https://antigravity.google) | **Google Gemini API** | Isolated `HOME`, Gemini endpoint override, placeholder key, dead proxy |
| Hermes Agent (`hermes`) | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | OpenAI Chat Completions | Isolated `HERMES_HOME` and generated provider config |
| Cline (`cline`) | [cline/cline](https://github.com/cline/cline) | OpenAI Chat Completions | Isolated `--config` / `--data-dir` / `--hooks-dir` directories and a generated provider file |
| Kimi Code (`kimi`) | [kimi.com/code](https://www.kimi.com/code/) | OpenAI Chat Completions | Isolated `KIMI_CODE_HOME`, generated `config.toml` provider (`type = "openai"`), `-p` headless mode |
| [Qwen Code](https://github.com/QwenLM/qwen-code) (`qwen`) | latest npm release | OpenAI Chat Completions | Isolated `HOME` / `QWEN_HOME` / XDG directories, one-shot headless mode with `--bare --safe-mode` |
| ccode (`ccode-cli`) | [MoyaMryia/ccode](https://github.com/MoyaMryia/ccode) | OpenAI Chat Completions | Isolated `CCODE_SESSION_DIR`, provider from environment variables (`CCODE_API_BASE` / `_API_KEY` / `_MODEL`), `--write --auto-approve -p` headless mode |

Each harness runs in its own playground sandbox. The mock protocol adapter and tool schema match the harness under test; this avoids treating unsupported tool names or protocol mismatches as performance data. Credentials are placeholders — the mock does not validate them, so no real key is ever involved.

OpenCode v1 and v2 are listed separately on purpose: v2 is the next generation of the same project but a
different harness — its shell tool was renamed, it spawns a worker process, and it needs its own script.
The v1 sandbox remains in the repository for reproduction, with its own script, and verifies that the
binary it finds is really 1.x before starting (a bare `opencode` is ambiguous now that v2 installs one
too).

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

- `Bash` with `{command}` for peri, OpenCode v1, Claude Code, and Kimi Code;
- lowercase `bash` with `{command}` for ccode (same shape as pi and MiniMax Code);
- `shell` with `{command}` for OpenCode v2 — the tool was renamed in v2;
- `exec` with bare JavaScript source for Codex;
- lowercase `bash` for pi and MiniMax Code;
- lowercase `bash` with `{command, description}` for DeepSeek Harness;
- `run_command` with five camelCase fields (`CommandLine`, `Cwd`, …) for Antigravity CLI;
- `terminal` with `{command}` for Hermes Agent;
- `run_commands` with `{commands: [...]}` for Cline — the only array-shaped argument among the twelve.

Some harnesses issue additional internal requests, such as context compaction or session-title generation. These consume script entries too, so each harness's script is sized to them: a 100-turn run needs **102** entries (100 turns plus two completion entries) for most harnesses, **135** for pi, **106** for Antigravity CLI, **103** for OpenCode v2, **104** for Hermes Agent and **103** for Cline. ccode also takes the 102-entry script but stops at its own turn cap before the closing entry, so it consumes 100.

## Reproduce the benchmark

### Generate workload scripts

```sh
# peri / Claude Code / OpenCode v1
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

# Antigravity CLI: run_command takes five required fields
bun run scripts/perf/gen-long-run.ts \
  --turns 104 \
  --args commandline \
  --out data/scenarios/long-run-antigravity.json

# OpenCode v2: the shell tool is named `shell`; 101 turns cover 100 tool rounds
bun run scripts/perf/gen-long-run.ts \
  --turns 101 \
  --tool shell \
  --out data/scenarios/long-run-opencode2.json

# Hermes Agent: the shell tool is named `terminal`; 102 turns cover 100 tool rounds
# (a session-title request and one compaction round each eat one entry)
bun run scripts/perf/gen-long-run.ts \
  --turns 102 \
  --tool terminal \
  --out data/scenarios/long-run-hermes.json

# Cline: the shell tool is `run_commands` and takes an array of commands; 101 turns
# cover 100 tool rounds (one context compaction eats an entry)
bun run scripts/perf/gen-long-run.ts \
  --turns 101 \
  --args commands \
  --out data/scenarios/long-run-cline.json

# Kimi Code
bun run scripts/perf/gen-long-run.ts \
  --turns 100 \
  --out data/scenarios/long-run-kimi.json

# Qwen Code
bun run scripts/perf/gen-long-run.ts \
  --turns 100 \
  --tool run_shell_command \
  --out data/scenarios/long-run-qwen-code.json

# ccode: lowercase `bash` + {command}, same shape as pi; 100 turns cover 100 tool rounds
# (it stops at --max-turns before the closing entry, so it does not need extra entries)
bun run scripts/perf/gen-long-run.ts \
  --turns 100 \
  --tool bash \
  --out data/scenarios/long-run-ccode.json
```

### Run a harness

Each playground entry point starts the local mock, injects an isolated configuration, launches its harness, samples the process tree, and writes one run directory. The corresponding harness binary must be available on `PATH`.

```sh
cd playground/peri         && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/claude-code  && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/codex        && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/pi           && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/deepseek     && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/minimax-code && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/antigravity  && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/opencode2    && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/hermes       && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/cline        && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/ccode        && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/kimi         && bun perf-demo.ts --exhausted stop --timeout-ms 600000
cd playground/qwen-code    && bun perf-demo.ts --exhausted stop --timeout-ms 600000
# cd playground/opencode  && bun perf-demo.ts --exhausted stop --timeout-ms 600000   # OpenCode v1: kept for reproduction
```

Each demo runs its own default script, so `--script` is normally left out. The OpenCode v1 line is
commented out because that sandbox is kept for reproducing the earlier generation rather than for batch
runs — it refuses to start on anything but a 1.x binary, for the reason given under
[Harnesses and integrations](#harnesses-and-integrations).

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
