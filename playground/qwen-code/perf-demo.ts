#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  loadPerfConfig,
  type PerfConfig,
} from '../../scripts/perf/config';
import { EXIT_OK, EXIT_SETUP, USAGE, runPerf } from '../../scripts/perf/run';

const argv = process.argv.slice(2);
const sandbox = join(import.meta.dir, '.home');
const model = 'llm-mock';

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(USAGE);
  console.log('提示: 这是 Qwen Code 版 demo，使用正式 npm 包提供的 qwen 二进制。');
  console.log('      HOME / QWEN_HOME / XDG_* 都指向本目录 .home，不读取用户配置。');
  console.log('      默认剧本是 data/scenarios/long-run-qwen-code.json（run_shell_command + {command}）。');
  process.exit(EXIT_OK);
}

function sandboxEnv(): Record<string, string> {
  mkdirSync(sandbox, { recursive: true });
  return {
    HOME: sandbox,
    QWEN_HOME: join(sandbox, '.qwen'),
    XDG_CONFIG_HOME: join(sandbox, '.config'),
    XDG_CACHE_HOME: join(sandbox, '.cache'),
    XDG_DATA_HOME: join(sandbox, '.data'),
    QWEN_CODE_DISABLE_CRON: '1',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
}

try {
  const config = loadPerfConfig(argv, REPO_ROOT, {
    scriptPath: 'data/scenarios/long-run-qwen-code.json',
  });
  if (!argv.some((arg) => arg === '--work-dir' || arg.startsWith('--work-dir='))) {
    config.workDir = import.meta.dir;
  }
  if (!argv.some((arg) => arg === '--harness' || arg.startsWith('--harness='))) {
    config.harnessId = 'qwen-code';
  }
  if (!argv.some((arg) => arg === '--exhausted' || arg.startsWith('--exhausted='))) {
    config.exhausted = 'stop';
  }

  const explicitBin = argv.some((arg) => arg === '--peri' || arg.startsWith('--peri='));
  const qwenBin = explicitBin ? config.periPath : Bun.which('qwen');
  if (qwenBin === null) {
    throw new Error('PATH 里找不到 qwen，可 npm i -g @qwen-code/qwen-code@0.24.3，或显式传 --peri <path>');
  }

  process.exitCode = await runPerf(config, {
    harnessEnv: sandboxEnv,
    harnessCommand: (cfg: PerfConfig) => [
      qwenBin,
      cfg.prompt,
      '--auth-type',
      'openai',
      '--openai-base-url',
      `http://127.0.0.1:${cfg.port}/v1`,
      '--openai-api-key',
      'mock-key',
      '--model',
      model,
      '--yolo',
      '--bare',
      '--safe-mode',
      '--no-telemetry',
      '--no-chat-recording',
      '--output-format',
      'json',
      ...cfg.periArgs,
    ],
  });
} catch (error) {
  console.error(`[perf] 启动失败: ${(error as Error).message}`);
  console.error('用法见 bun perf-demo.ts --help');
  process.exitCode = EXIT_SETUP;
}
