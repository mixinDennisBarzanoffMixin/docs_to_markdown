import type { ProcessorState, FileState } from './types';
import { logger } from './lib/logger';

/**
 * Creates a fresh, empty processor state.
 */
export function createEmptyState(): ProcessorState {
  const now = new Date().toISOString();
  return { version: 1, createdAt: now, updatedAt: now, files: {} };
}

/**
 * Loads the processor state from a JSON file.
 * Returns an empty state if the file doesn't exist or is invalid.
 */
export async function loadState(stateFile: string): Promise<ProcessorState> {
  const file = Bun.file(stateFile);
  if (!(await file.exists())) {
    logger.info(`State file not found at ${stateFile}, initializing empty state.`);
    return createEmptyState();
  }

  try {
    const content = await file.text();
    const parsed = JSON.parse(content) as ProcessorState;
    
    if (!parsed || parsed.version !== 1 || !parsed.files) {
      logger.warn(`State file at ${stateFile} has invalid format, returning empty state.`);
      return createEmptyState();
    }
    
    return parsed;
  } catch (err) {
    logger.error(`Failed to load state file at ${stateFile}:`, err);
    return createEmptyState();
  }
}

/**
 * Persists the processor state to a JSON file.
 */
export async function saveState(stateFile: string, state: ProcessorState): Promise<void> {
  try {
    state.updatedAt = new Date().toISOString();
    const content = JSON.stringify(state, null, 2);
    await Bun.write(stateFile, content);
  } catch (err) {
    logger.error(`Failed to save state file at ${stateFile}:`, err);
  }
}

/**
 * Retrieves the state for a specific file, initializing it if it doesn't exist.
 */
export function getOrInitFileState(state: ProcessorState, filename: string): FileState {
  if (!state.files[filename]) {
    state.files[filename] = {
      status: 'pending',
      attempts: 0,
    };
  }
  return state.files[filename];
}

/**
 * Resets any files marked as 'processing' back to 'pending'.
 * This is useful for recovering from interruptions.
 */
export function resetInFlightToPending(state: ProcessorState): void {
  let count = 0;
  for (const filename of Object.keys(state.files)) {
    if (state.files[filename]?.status === 'processing') {
      state.files[filename].status = 'pending';
      count++;
    }
  }
  if (count > 0) {
    logger.info(`Reset ${count} stuck files from 'processing' to 'pending'.`);
  }
}
