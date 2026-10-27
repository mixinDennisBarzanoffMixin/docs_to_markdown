export type Config = {
  aiProvider: 'codex' | 'vertex';
  inputDir: string;
  imageRefPrefix: string;
  outputDir: string;
  stateFile: string;
  batchSize: number;
  modelId?: string;
  auto: boolean;
  // Vertex
  vertexProject?: string;
  vertexLocation?: string;
  vertexApiKey?: string;
};

function validateConfig(config: Partial<Config>): asserts config is Config {
  const errors: string[] = [];

  if (config.aiProvider !== 'codex' && config.aiProvider !== 'vertex') {
    errors.push('AI_PROVIDER must be "codex" or "vertex".');
  }

  if (!config.inputDir || typeof config.inputDir !== 'string' || !config.inputDir.trim()) {
    errors.push('INPUT_DIR is missing or invalid.');
  }

  if (!config.imageRefPrefix || typeof config.imageRefPrefix !== 'string') {
    errors.push('IMAGE_REF_PREFIX is missing or invalid.');
  }

  if (!config.outputDir || typeof config.outputDir !== 'string' || !config.outputDir.trim()) {
    errors.push('OUTPUT_DIR is missing or invalid.');
  }

  if (!config.stateFile || typeof config.stateFile !== 'string' || !config.stateFile.trim()) {
    errors.push('STATE_FILE is missing or invalid.');
  }

  if (!Number.isFinite(config.batchSize) || config.batchSize! <= 0) {
    errors.push('BATCH_SIZE must be a positive integer.');
  }

  if (
    config.aiProvider === 'vertex' &&
    (!config.modelId || typeof config.modelId !== 'string' || !config.modelId.trim())
  ) {
    errors.push('MODEL_ID is missing or invalid for the Vertex provider.');
  }

  if (errors.length > 0) {
    throw new Error('Config validation error(s):\n' + errors.join('\n'));
  }
}

export function loadConfigFromEnv(): Config {
  const batchSize = Number.parseInt(process.env.BATCH_SIZE ?? '20', 10);
  const auto = process.env.AUTO === 'true' || process.env.AUTO === '1';
  const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
  const codexAuthPath = `${codexHome}/auth.json`;
  const inputDir = process.env.INPUT_DIR ?? 'documents_in';
  const inferredProvider = process.env.AI_PROVIDER === 'vertex' || process.env.AI_PROVIDER === 'codex'
    ? process.env.AI_PROVIDER
    : Bun.file(codexAuthPath).size > 0
      ? 'codex'
      : 'vertex';

  const config: Partial<Config> = {
    aiProvider: inferredProvider,
    inputDir,
    imageRefPrefix: process.env.IMAGE_REF_PREFIX ?? `../${inputDir}`,
    outputDir: process.env.OUTPUT_DIR ?? 'markdown_out',
    stateFile: process.env.STATE_FILE ?? '.docproc_state.json',
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 20,
    // Use Luna for OCR unless the caller explicitly selects another model.
    modelId: process.env.MODEL_ID?.trim() ||
      (inferredProvider === 'vertex' ? 'gemini-2.5-flash' : 'gpt-6-luna'),
    auto,
    vertexProject:
      process.env.GOOGLE_VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? undefined,
    vertexLocation:
      process.env.GOOGLE_VERTEX_LOCATION ?? process.env.GCLOUD_LOCATION ?? undefined,
    vertexApiKey: process.env.GOOGLE_VERTEX_API_KEY ?? undefined,
  };

  validateConfig(config);

  return config;
}
