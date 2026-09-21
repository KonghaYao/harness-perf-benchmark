# harness-perf-benchmark

A controlled benchmark for measuring the **CPU and memory usage** of AI coding harnesses during long-running, tool-using tasks.

The benchmark does not call a real model. Every harness talks to the same local scripted mock, receives the same workload shape, and is measured together with its child processes. Network latency, model inference, GPU usage, and external service resources are outside the measurement scope.

> The current ranking is the **CU 2.0 Beta fixed-budget absolute score — higher is better**. Harnesses may be listed together across batches, but a score still moves with machine load, environment, task and configuration, so it is not a claim of cross-environment fairness.

**Live charts:** [konghayao.github.io/harness-perf-benchmark](https://konghayao.github.io/harness-perf-benchmark/) — one CU 2.0 score ranking on a fixed 0–100 axis, with the per-sample CPU and memory curves kept as non-ranking diagnostics.

## Current score: CU 2.0 Beta

Defined in exactly one place, `CU2_FORMULA` in `scripts/perf/score.ts`:

`Score = 100 / (1 + max(T/10, C/10, A/10, P/1))`, range 0–100.

T is end-to-end seconds, C is process-tree core-seconds, A is measured GiB-seconds of memory area, P is the process-tree RSS peak in GiB. The fixed Beta budgets are 10 s / 10 core-s / 10 GiB·s / 1 GiB, so 50 points means exactly at budget. This is not cloud pricing and not the legacy area sum, and there is no direct memory/CPU growth-multiplier penalty. The RSS peak is part of the score (budget item P); the CPU peak stays a diagnostic.

One tier of about 100 tool turns (99 counts as 100, never padded), no short/medium/long tiers. Three repeats are scored individually and the **real run whose score is the median** supplies the bar; repeats are not mixed across labels, scenario SHAs or sampling conditions, and failed runs are not dropped to build a successful subset. Actual counts, per-run scores and the runs left out travel with the data.

An un-scorable run is `null` with reasons shown (missing evidence, incomplete repeats, a tail gap over 500 ms) — never drawn as 0 or 100. Payloads or score blocks that do not declare `scoreVersion: 'cu2-beta'` are not drawn as CU 2.0 at all.

**The user has approved recomputing CU 2.0 from the existing CSVs: that is a historical recalculation, not a new benchmark run, and it does not require re-running first.** Runs without enough evidence stay un-scored. A formal conclusion still needs comparable sampling. The page prints the formula from the payload only.

## Benchmark Results — CU 1.0 historical

The area CU figures, resource readings and rankings below are kept as they were: they are **CU 1.0 history, not CU 2.0 scores**, and are not renamed or relabelled.

**Machine:** macOS · Apple Silicon · 18 cores<br>
**Sampling:** 100 ms intervals · `proc_pid_rusage` · process-tree accounting<br>
**Runs (historical rule):** 3 serial runs per harness; the duration-median run is shown<br>
**Workload:** 100 scripted tool-use turns, with approximately 4 KB of response content per turn<br>
**CU 1.0 area (historical):** 1 core-second + 1 GB-second of process-tree CPU and memory, integrated over the run

| Harness | Version | CU 1.0 area ↓ | CPU mean | CPU peak | Memory mean | Memory peak |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [pi](https://github.com/earendil-works/pi) | 0.85.1 | **1.271** | 65.5% | 128.8% | 186.2 MB | 234.4 MB |
| [Codex CLI](https://github.com/openai/codex) | 0.155.1 | 1.383 | **10.5%** | **26.0%** | 123.4 MB | 163.7 MB |
| [peri](https://github.com/KonghaYao/peri) | 3.17.0 | 2.102 | 32.6% | 43.7% | **54.7 MB** | **71.7 MB** |
| [Claude Code](https://github.com/anthropics/claude-code) | 2.1.277 | 2.828 | 71.8% | 122.4% | 310.9 MB | 351.0 MB |
| [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) | 0.1.5-rc.2 | 3.101 | 46.3% | 128.0% | 185.6 MB | 231.2 MB |
| [Cline](https://github.com/cline/cline) (`cline`) † | 3.0.62 | 3.397 | 23.3% | 138.4% | 443.5 MB | 706.1 MB |
| [Antigravity CLI](https://antigravity.google) (`agy`) † | 1.2.7 | 4.593 | 173.4% | 213.0% | 208.6 MB | 225.1 MB |
| [OpenCode v2](https://github.com/anomalyco/opencode) (`opencode2`) † | 2.0.10 | 9.595 | 48.6% | 105.2% | 576.1 MB | 849.6 MB |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) (`hermes`) † | 0.21.3 | 10.706 | 73.1% | 131.8% | 147.3 MB | 201.1 MB |
| [MiniMax Code](https://github.com/MiniMax-AI/minimax-code) | 0.4.12 | 31.995 | 98.1% | 177.8% | 617.6 MB | 892.0 MB |

Bold marks the leanest value in each column (lower is leaner in all of them).

† The six unmarked rows come from one batch (label `codex-proxy-fix`, September 19, 2026, 20:39–20:43,
three serial runs each). Antigravity CLI, OpenCode v2, Hermes Agent and Cline were measured in separate
probe batches (labels `agy-probe`, `oc2-probe`, `hermes-probe` and `cline-probe`, September 20).
**Cross-batch caveat for the historical rows:** durations and resource readings are single-machine values that move with machine load, so treat the † rows as indicative. CU 2.0 may list families together with a mixed-batch note, but that note is not a claim that these probes were collected under one comparable setup. The CI workflow installs and runs all ten under a single batch label; a formal conclusion still needs comparable sampling.

### Reading the results

- CPU is reported using a **single-core 100% scale**. Multi-threaded processes can exceed 100%.
- CPU and memory use the **process-tree** view, including harness child processes used for tool execution.
- Memory is resident set size (RSS), not virtual memory or the size of disk caches.
- The CU column here is the **CU 1.0 area** (CPU and memory integrated 1:1 over the run), kept for
  compatibility and diagnostics only; it is **not** the current CU 2.0 fixed-budget absolute score.
  The legacy ratios and rankings below are left as they were published.
- peri has the lowest mean and peak memory of the ten; MiniMax Code has the highest mean CPU and memory.
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
- **A fixed budget does not remove the environment.** Durations are load-sensitive — the same script on
  the same machine has produced 19.8 s and 34.7 s for one harness. The CU 1.0 relative scores belong to
  their original batch; CU 2.0 is absolute, so it can be listed with a mixed-batch note, but a formal
  conclusion still needs comparable sampling.

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

- `Bash` with `{command}` for peri, OpenCode v1, and Claude Code;
- `shell` with `{command}` for OpenCode v2 — the tool was renamed in v2;
- `exec` with bare JavaScript source for Codex;
- lowercase `bash` for pi and MiniMax Code;
- lowercase `bash` with `{command, description}` for DeepSeek Harness;
- `run_command` with five camelCase fields (`CommandLine`, `Cwd`, …) for Antigravity CLI;
- `terminal` with `{command}` for Hermes Agent;
- `run_commands` with `{commands: [...]}` for Cline — the only array-shaped argument among the ten.

Some harnesses issue additional internal requests, such as context compaction or session-title generation. These consume script entries too, so each harness's script is sized to them: a 100-turn run needs **102** entries (100 turns plus two completion entries) for most harnesses, **135** for pi, **106** for Antigravity CLI, **103** for OpenCode v2, **104** for Hermes Agent and **103** for Cline.

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
