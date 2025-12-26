import sharp from 'sharp';
import { readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname } from 'path';

const INPUT_DIR = 'documents_in';
const OUTPUT_DIR = 'documents_compressed';

async function compress() {
  if (!existsSync(INPUT_DIR)) {
    console.error(`Input directory ${INPUT_DIR} not found.`);
    return;
  }

  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }

  const files = await readdir(INPUT_DIR);
  const imageFiles = files.filter(f => {
    const ext = extname(f).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
  });

  console.log(`🗜️  Starting compression of ${imageFiles.length} images...`);

  for (const file of imageFiles) {
    const inputPath = join(INPUT_DIR, file);
    const outputPath = join(OUTPUT_DIR, file);

    try {
      await sharp(inputPath)
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60, mozjpeg: true })
        .toFile(outputPath);
      
      console.log(`✓ Compressed: ${file}`);
    } catch (error) {
      console.error(`✗ Error compressing ${file}:`, error);
    }
  }

  console.log(`\n✅ Done! Compressed images are in: ${OUTPUT_DIR}`);
}

compress().catch(console.error);

