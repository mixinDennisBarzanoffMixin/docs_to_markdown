export type CodexExecArgs = {
  codexBin: string;
  imagePath: string;
  schemaPath: string;
  outputPath: string;
  prompt: string;
  modelId?: string;
};

export function buildCodexExecArgs({
  codexBin,
  imagePath,
  schemaPath,
  outputPath,
  prompt,
  modelId,
}: CodexExecArgs): string[] {
  const args = [
    codexBin,
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--config',
    'model_reasoning_effort="low"',
    '--config',
    'service_tier="priority"',
    '--sandbox',
    'read-only',
  ];

  const explicitModel = modelId?.trim();
  if (explicitModel) {
    args.push('--model', explicitModel);
  }

  args.push(
    '--image',
    imagePath,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    prompt,
  );

  return args;
}
