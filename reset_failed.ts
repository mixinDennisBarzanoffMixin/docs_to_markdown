import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const STATE_FILE = '.docproc_state.json';

async function resetFailed() {
  if (!existsSync(STATE_FILE)) {
    console.error(`State file ${STATE_FILE} not found.`);
    return;
  }

  try {
    const content = await readFile(STATE_FILE, 'utf-8');
    const state = JSON.parse(content);

    if (!state.files) {
      console.log('No files found in state.');
      return;
    }

    let resetCount = 0;
    const fileEntries = Object.entries(state.files);

    for (const [filename, fileState] of fileEntries) {
      if ((fileState as any).status === 'failed') {
        console.log(`Resetting failed file: ${filename}`);
        (fileState as any).status = 'pending';
        // Clear error but keep attempts or reset them? 
        // User said "marks the failed entries as not started", 
        // which usually implies resetting attempts to 0.
        (fileState as any).attempts = 0;
        delete (fileState as any).error;
        delete (fileState as any).lastAttemptAt;
        resetCount++;
      }
    }

    if (resetCount > 0) {
      state.updatedAt = new Date().toISOString();
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`\nSuccessfully reset ${resetCount} failed entries to 'pending'.`);
    } else {
      console.log('No failed entries found.');
    }
  } catch (error) {
    console.error('Error processing state file:', error);
  }
}

resetFailed().catch(console.error);


