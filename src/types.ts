export type FileStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type FileState = {
  status: FileStatus;
  attempts: number;
  outputFile?: string;
  error?: string;
  lastAttemptAt?: string;
  completedAt?: string;
};

export type ProcessorState = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  files: Record<string, FileState>;
};

export type Config = {
  inputDir: string;
  outputDir: string;
  stateFile: string;
  batchSize: number;
  concurrency: number;
  modelId: string;
  auto: boolean;
  vertexProject?: string;
  vertexLocation?: string;
  vertexApiKey?: string;
};

export type RunStats = {
  discovered: number;
  pending: number;
  completed: number;
  failed: number;
  skipped: number;
  succeededThisRun: number;
  failedThisRun: number;
};

export type FileProgressEvent =
  | { type: 'run-start'; config: Config }
  | { type: 'scan-complete'; files: string[]; stats: RunStats }
  | { type: 'batch-start'; batchIndex: number; totalBatches: number; files: string[]; stats: RunStats }
  | { type: 'file-start'; filename: string; attempt: number; batchIndex: number; indexInBatch: number; batchSize: number; stats: RunStats }
  | { type: 'file-success'; filename: string; outputFile: string; stats: RunStats }
  | { type: 'file-failed'; filename: string; error: string; stats: RunStats }
  | { type: 'run-finish'; stats: RunStats };

export interface ProcessorHooks {
  onEvent?: (event: FileProgressEvent) => void;
  abortSignal?: AbortSignal;
}

