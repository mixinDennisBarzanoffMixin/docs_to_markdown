import { readdir } from 'fs/promises';
import { join, basename, extname } from 'path';
import { existsSync } from 'fs';
const INPUT_DIR = process.env.INPUT_DIR ?? 'documents_in';
/** Document (or bundle) date, not “today”: e.g. 2026.03.06 → `2026.03.06_<slug>_page-0000.jpg`. Omit to skip date prefix. */
const IMAGE_DATE_PREFIX = (process.env.IMAGE_DATE_PREFIX ?? '').replace(/_$/, '');
const DENSITY = Number.parseInt(process.env.PDF_DENSITY ?? '200', 10) || 200;

function pdfBasenameToSlug(name: string): string {
  let s = name.replace(/\.pdf$/i, '').trim();
  while (/\s*\(\d+\)\s*$/.test(s)) {
    s = s.replace(/\s*\(\d+\)\s*$/, '').trim();
  }
  s = s.replace(/\s+/g, '_');
  s = s.replace(/[^\p{L}\p{N}._-]/gu, '_');
  s = s.replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
  return s.length > 0 ? s : 'document';
}

function outputPatternForSlug(slug: string): string {
  const middle = IMAGE_DATE_PREFIX ? `${IMAGE_DATE_PREFIX}_${slug}` : slug;
  return `${middle}_page-%04d.jpg`;
}

async function rasterizePdf(pdfPath: string, slug: string): Promise<void> {
  const pattern = join(INPUT_DIR, outputPatternForSlug(slug));
  const proc = Bun.spawn(['magick', '-density', String(DENSITY), pdfPath, pattern], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`magick exited with ${code} for ${basename(pdfPath)}`);
  }
}

async function main() {
  if (!existsSync(INPUT_DIR)) {
    console.error(`Input directory not found: ${INPUT_DIR}`);
    process.exit(1);
  }

  if (!Bun.which('magick')) {
    console.error('ImageMagick `magick` not found. Install with: brew install imagemagick');
    process.exit(1);
  }

  const files = await readdir(INPUT_DIR);
  const pdfs = files.filter(f => /\.pdf$/i.test(f)).sort((a, b) => a.localeCompare(b));

  if (pdfs.length === 0) {
    console.log(`No PDF files in ${INPUT_DIR}.`);
    return;
  }

  console.log(`Rasterizing ${pdfs.length} PDF(s) → ${INPUT_DIR}/ (density ${DENSITY})`);
  if (IMAGE_DATE_PREFIX) {
    console.log(`DATE_PREFIX: ${IMAGE_DATE_PREFIX}`);
  }

  for (const f of pdfs) {
    const slug = pdfBasenameToSlug(basename(f, extname(f)));
    const pdfPath = join(INPUT_DIR, f);
    console.log(`  ${f} → ${outputPatternForSlug(slug).replace(INPUT_DIR + '/', '')}`);
    await rasterizePdf(pdfPath, slug);
  }

  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
