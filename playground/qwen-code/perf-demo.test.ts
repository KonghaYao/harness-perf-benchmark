import { describe, expect, it } from 'bun:test';
import { displayName } from '../../scripts/perf/harness-id';

const entry = `${import.meta.dir}/perf-demo.ts`;

describe('Qwen Code 压测入口', () => {
  it('查看帮助不需要本机安装 qwen', async () => {
    const result = Bun.spawn([process.execPath, entry, '--help'], {
      env: { ...process.env, PATH: '/nonexistent-qwen-bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(result.stdout).text();
    expect(await result.exited).toBe(0);
    expect(output).toContain('long-run-qwen-code.json');
    expect(output).toContain('QWEN_HOME');
  });

  it('PATH 里没有 qwen 时明确失败，不静默换被测对象', async () => {
    const result = Bun.spawn([process.execPath, entry], {
      env: { ...process.env, PATH: '/nonexistent-qwen-bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const errors = await new Response(result.stderr).text();
    expect(await result.exited).toBe(1);
    expect(errors).toContain('PATH 里找不到 qwen');
    expect(errors).toContain('@qwen-code/qwen-code');
  });

  it('用规范展示名汇总 Qwen 结果', () => {
    expect(displayName('qwen-code')).toBe('Qwen Code');
  });
});
