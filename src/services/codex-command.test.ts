import { describe, expect, test } from 'bun:test';
import { buildCodexExecArgs } from './codex-command';

const base = {
  codexBin: 'codex',
  imagePath: '/tmp/page.jpg',
  schemaPath: '/tmp/schema.json',
  outputPath: '/tmp/result.json',
  prompt: 'Digitize this page.',
};

describe('buildCodexExecArgs', () => {
  test('lets Codex choose the account-supported default model', () => {
    const args = buildCodexExecArgs(base);

    expect(args).not.toContain('--model');
  });

  test('honors an explicitly configured model', () => {
    const args = buildCodexExecArgs({ ...base, modelId: 'gpt-6-astra' });
    const modelFlag = args.indexOf('--model');

    expect(modelFlag).toBeGreaterThan(-1);
    expect(args[modelFlag + 1]).toBe('gpt-6-astra');
  });

  test('ignores an empty model override', () => {
    const args = buildCodexExecArgs({ ...base, modelId: '   ' });

    expect(args).not.toContain('--model');
  });
});
