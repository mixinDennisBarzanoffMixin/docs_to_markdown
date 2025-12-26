import { readdir } from 'fs/promises';
import type { Config, RunStats, ProcessorHooks, ProcessorState } from '../types';
import { loadState, saveState, resetInFlightToPending, getOrInitFileState } from '../state';
import { logger } from '../lib/logger';
import { ensureDir } from '../lib/file-system';
import { DocumentProcessor } from './processor';

export class BatchOrchestrator {
  private processor: DocumentProcessor;
  private state!: ProcessorState;
  private images: string[] = [];
  private succeededThisRun = 0;
  private failedThisRun = 0;
  private globalPreviousContext = '';

  constructor(private config: Config, private hooks: ProcessorHooks = {}) {
    this.processor = new DocumentProcessor(config);
  }

  /**
   * Main entry point to start the processing run.
   */
  async run(): Promise<RunStats> {
    const { onEvent, abortSignal } = this.hooks;
    onEvent?.({ type: 'run-start', config: this.config });

    logger.info('Starting BatchOrchestrator run', { config: this.config });

    // Ensure directories exist
    await ensureDir(this.config.inputDir);
    await ensureDir(this.config.outputDir);

    // Load state and clean up any previous messy exits
    this.state = await loadState(this.config.stateFile);
    resetInFlightToPending(this.state);

    // Discover and sort images
    const all = await readdir(this.config.inputDir);
    this.images = all
      .filter(f => /\.(jpg|jpeg|png|webp|heic|gif|bmp|tiff?)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    logger.info(`Discovered ${this.images.length} images.`);

    // Initialize state for newly discovered files
    for (const f of this.images) {
      const fs = getOrInitFileState(this.state, f);
      // Auto-retry failed files that haven't hit the attempt limit
      if (fs.status === 'failed' && fs.attempts < 3) {
        fs.status = 'pending';
      }
    }

    await saveState(this.config.stateFile, this.state);

    const pendingFiles = this.images.filter(f => this.state.files[f]?.status === 'pending');
    const stats = this.computeStats();
    
    onEvent?.({ type: 'scan-complete', files: this.images, stats });

    if (pendingFiles.length === 0) {
      logger.info('No pending files to process.');
      onEvent?.({ type: 'run-finish', stats });
      return stats;
    }

    const batches = this.chunk(pendingFiles, this.config.batchSize);
    logger.info(`Processing ${pendingFiles.length} files in ${batches.length} batches.`);

    for (let bIndex = 0; bIndex < batches.length; bIndex++) {
      if (abortSignal?.aborted) {
        logger.info('Run aborted by user.');
        break;
      }

      const batch = batches[bIndex];
      if (!batch) continue;

      onEvent?.({ 
        type: 'batch-start', 
        batchIndex: bIndex + 1, 
        totalBatches: batches.length, 
        files: batch, 
        stats: this.computeStats() 
      });

      logger.info(`Starting batch ${bIndex + 1}/${batches.length} (${batch.length} files)`);
      await this.processBatch(batch, bIndex + 1);

      if (!this.config.auto) {
        logger.info('Manual mode: finished one batch, stopping.');
        break;
      }
    }

    const finalStats = this.computeStats();
    logger.info('Run completed.', finalStats);
    onEvent?.({ type: 'run-finish', stats: finalStats });
    return finalStats;
  }

  /**
   * Processes a single batch of files with defined concurrency.
   */
  private async processBatch(batch: string[], batchIndex: number) {
    const { onEvent, abortSignal } = this.hooks;
    let cursor = 0;
    const inFlight = new Set<Promise<void>>();

    while (cursor < batch.length || inFlight.size > 0) {
      if (abortSignal?.aborted) break;

      // Systemic failure check: if 3 consecutive failures in a batch and no successes, stop.
      const batchProcessed = batch.slice(0, cursor);
      const batchFailures = batchProcessed.filter(f => this.state.files[f]?.status === 'failed').length;
      if (batchFailures >= 3 && this.succeededThisRun === 0 && inFlight.size === 0 && cursor > 0) {
        logger.error('Batch failing consistently. Stopping run for safety.');
        break;
      }

      // Fill up the concurrency slots
      while (inFlight.size < this.config.concurrency && cursor < batch.length && !abortSignal?.aborted) {
        const filename = batch[cursor]!;
        const indexInBatch = ++cursor;

        const fs = getOrInitFileState(this.state, filename);
        if (fs.status === 'completed') continue;

        fs.status = 'processing';
        fs.attempts += 1;
        fs.lastAttemptAt = new Date().toISOString();

        onEvent?.({ 
          type: 'file-start', 
          filename, 
          attempt: fs.attempts, 
          batchIndex, 
          indexInBatch, 
          batchSize: batch.length, 
          stats: this.computeStats() 
        });

        // Capture context at the moment of start (though it's updated as we go)
        const contextToPass = this.globalPreviousContext;

        const p = (async () => {
          await saveState(this.config.stateFile, this.state);
          try {
            const { outputFile, content } = await this.processor.processFile({ 
              filename, 
              previousContext: contextToPass,
              existingOutputFile: fs.outputFile,
              abortSignal 
            });
            
            fs.status = 'completed';
            fs.outputFile = outputFile;
            fs.completedAt = new Date().toISOString();
            fs.error = undefined;
            this.succeededThisRun++;
            
            // Update continuity context
            this.globalPreviousContext = content.slice(-2000);
            
            onEvent?.({ type: 'file-success', filename, outputFile, stats: this.computeStats() });
          } catch (e: any) {
            fs.status = 'failed';
            fs.error = e.message || String(e);
            this.failedThisRun++;
            onEvent?.({ type: 'file-failed', filename, error: fs.error!, stats: this.computeStats() });
          } finally {
            await saveState(this.config.stateFile, this.state);
          }
        })();

        const wrapped = p.finally(() => inFlight.delete(wrapped));
        inFlight.add(wrapped);

        if (this.config.concurrency === 1) await wrapped;
      }

      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    }
  }

  /**
   * Calculates current statistics from state and runtime counters.
   */
  private computeStats(): RunStats {
    const values = Object.values(this.state.files);
    const completed = values.filter(v => v.status === 'completed').length;
    const failed = values.filter(v => v.status === 'failed').length;
    // Count both pending and currently processing as pending for the UI progress bar
    const pending = values.filter(v => v.status === 'pending' || v.status === 'processing').length;

    return {
      discovered: this.images.length,
      pending,
      completed,
      failed,
      skipped: 0,
      succeededThisRun: this.succeededThisRun,
      failedThisRun: this.failedThisRun,
    };
  }

  /**
   * Helper to chunk an array into smaller pieces.
   */
  private chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }
    return out;
  }
}

