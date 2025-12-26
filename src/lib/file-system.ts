import { join, basename } from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';

/**
 * Sanitizes a string to be used as a safe filename, preserving Unicode characters.
 */
export function sanitizeFilename(name: string): string {
  let n = name.trim();
  // Handle potential path separators
  n = n.replaceAll('\\', '/').split('/').pop() || 'document.md';
  
  // Ensure .md extension
  if (!n.toLowerCase().endsWith('.md')) {
    n += '.md';
  }

  // Preserve letters (Unicode), numbers, dots, underscores, spaces, and hyphens.
  // Replace everything else with an underscore.
  n = n.replaceAll(/[^\p{L}\p{N}._ -]/gu, '_');
  
  // Collapse multiple underscores
  n = n.replace(/_{2,}/g, '_');
  
  if (n.length === 0 || n === '.md') {
    n = 'document.md';
  }
  
  return n;
}

/**
 * Ensures a directory exists.
 */
export async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Gets a unique path in the output directory.
 * If existingFilename is provided, it will return that path instead of generating a new one,
 * effectively allowing overwrites of previously generated files.
 */
export function getOutputPath(outputDir: string, desiredFilename: string, existingFilename?: string): string {
  // If we already have a filename recorded for this image, reuse it to prevent __2, __3 duplicates.
  if (existingFilename) {
    return join(outputDir, existingFilename);
  }

  const base = sanitizeFilename(desiredFilename);
  const initialPath = join(outputDir, base);
  
  if (!existsSync(initialPath)) {
    return initialPath;
  }

  // Fallback to unique naming if we don't have an existing filename and the desired one is taken.
  const stem = base.replace(/\.md$/i, '');
  let i = 2;
  while (true) {
    const candidate = `${stem}__${i}.md`;
    const fullPath = join(outputDir, candidate);
    if (!existsSync(fullPath)) {
      return fullPath;
    }
    i++;
  }
}

