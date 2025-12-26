# Document to Markdown Processor

A CLI tool that uses Google Vertex AI (Gemini) to process document images and convert them to Markdown.

## Features

- Batched processing of images from `documents_in/`
- Automatic file naming by the AI
- Resumable processing (tracks processed files in `processed_state.json`)
- Built with Bun

## Setup

1. **Install Dependencies**
   ```bash
   bun install
   ```

2. **Configure Environment**
   Create a `.env` file with your Google Cloud credentials.

   ```bash
   cp .env.example .env
   ```

   **Variables:**
   - `GOOGLE_VERTEX_LOCATION`: Region (e.g., `us-central1`).
   - `MODEL_ID`: Model to use (default: `gemini-1.5-flash`). Set to your preferred model (e.g. `gemini-2.0-flash-exp`).

   *Note: Ensure you have the [Vertex AI API enabled](https://console.cloud.google.com/vertex-ai) in your Google Cloud project.*

3. **Add Images**
   Place your document images (`.jpg`, `.png`, `.webp`) in the `documents_in` folder.

## Usage

Run the processor:

```bash
bun run index.ts
```

The tool will:
1. Scan `documents_in` for new images.
2. Send each image to Gemini.
3. Generate a markdown file in `markdown_out` with a descriptive name.
4. Mark the file as processed so it won't be re-run if you restart.

## Resuming

If the process is interrupted, just run `bun run index.ts` again. It will skip already processed files.

## Utility Scripts

### Cleanup Duplicates
If the process was run multiple times or encountered naming collisions, you might find duplicate markdown files. This script identifies duplicates based on the source image referenced in the markdown footer and moves extras to a backup folder.

```bash
bun run cleanup:duplicates
```

### Reset Failed Entries
If some files failed to process (e.g., due to API errors), you can reset their status to try again.

```bash
bun run reset:failed
```

```bash
bun run process:images
```

### Compress Images
Compresses images from `documents_in` to `documents_compressed` with high efficiency (resizing and quality reduction) to save space.

```bash
bun run compress:images
```

### Create Word Document
Combines all processed markdown files from `markdown_out` into a single `.docx` file, stripping out all image references and metadata footers.

```bash
bun run create:doc
```
