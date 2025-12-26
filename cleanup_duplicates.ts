import { readdir, readFile, unlink, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const OUTPUT_DIR = 'markdown_out';
const BACKUP_DIR = 'markdown_duplicates_bak';

async function cleanup() {
  if (!existsSync(OUTPUT_DIR)) {
    console.log('Output directory not found.');
    return;
  }

  if (!existsSync(BACKUP_DIR)) {
    await mkdir(BACKUP_DIR, { recursive: true });
  }

  const files = await readdir(OUTPUT_DIR);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  const groups = new Map<string, string[]>();

  for (const f of mdFiles) {
    const fullPath = join(OUTPUT_DIR, f);
    const content = await readFile(fullPath, 'utf-8');
    
    // Extract source image from footer: **File:** `20251223_131056.jpg`
    const match = content.match(/\*\*File:\*\* `([^`]+)`/);
    if (match) {
      const sourceImage = match[1];
      if (!groups.has(sourceImage)) groups.set(sourceImage, []);
      groups.get(sourceImage)!.push(f);
    } else {
      // Fallback: use filename prefix (YYYYMMDD_HHMMSS)
      const prefixMatch = f.match(/^\d{8}_\d{6}/);
      if (prefixMatch) {
        const prefix = prefixMatch[0];
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix)!.push(f);
      }
    }
  }

  let totalRemoved = 0;
  for (const [source, group] of groups.entries()) {
    if (group.length > 1) {
      console.log(`Found ${group.length} files for ${source}:`);
      
      // Sort: keep the one WITHOUT "__" if possible, or the one with the shortest name
      group.sort((a, b) => {
        const aHasNum = a.includes('__');
        const bHasNum = b.includes('__');
        if (aHasNum && !bHasNum) return 1;
        if (!aHasNum && bHasNum) return -1;
        return a.length - b.length;
      });

      const [keep, ...remove] = group;
      console.log(`  KEEPing: ${keep}`);
      
      for (const r of remove) {
        console.log(`  MOVING to backup: ${r}`);
        await rename(join(OUTPUT_DIR, r), join(BACKUP_DIR, r));
        totalRemoved++;
      }
    }
  }

  console.log(`\nCleanup complete. Moved ${totalRemoved} duplicates to ${BACKUP_DIR}.`);
}

cleanup().catch(console.error);

