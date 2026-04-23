export type Config = {
  inputDir: string;
  outputDir: string;
  stateFile: string;
  batchSize: number;
  concurrency: number;
  modelId: string;
  auto: boolean;
  // Vertex
  vertexProject?: string;
  vertexLocation?: string;
  vertexApiKey?: string;
};

function validateConfig(config: Partial<Config>): asserts config is Config {
  const errors: string[] = [];

  if (!config.inputDir || typeof config.inputDir !== 'string' || !config.inputDir.trim()) {
    errors.push('INPUT_DIR is missing or invalid.');
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

  if (!Number.isFinite(config.concurrency) || config.concurrency! <= 0) {
    errors.push('CONCURRENCY must be a positive integer.');
  }

  if (!config.modelId || typeof config.modelId !== 'string' || !config.modelId.trim()) {
    errors.push('MODEL_ID is missing or invalid.');
  }

  if (errors.length > 0) {
    throw new Error('Config validation error(s):\n' + errors.join('\n'));
  }
}

export function loadConfigFromEnv(): Config {
  const batchSize = Number.parseInt(process.env.BATCH_SIZE ?? '20', 10);
  const concurrency = Number.parseInt(process.env.CONCURRENCY ?? '1', 10);
  const auto = process.env.AUTO === 'true' || process.env.AUTO === '1';

  const config: Partial<Config> = {
    inputDir: process.env.INPUT_DIR ?? 'documents_in',
    outputDir: process.env.OUTPUT_DIR ?? 'markdown_out',
    stateFile: process.env.STATE_FILE ?? '.docproc_state.json',
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 20,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1,
    modelId: process.env.MODEL_ID ?? 'gemini-2.5-flash',
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
