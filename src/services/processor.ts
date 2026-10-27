import { createVertex } from '@ai-sdk/google-vertex';
import { generateText, tool, zodSchema, stepCountIs } from 'ai';
import { mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename, extname, resolve, delimiter } from 'path';
import { z } from 'zod';
import type { Config } from '../types';
import { logger } from '../lib/logger';
import { getInputRenamePath, getOutputPath, sanitizeFilename } from '../lib/file-system';
import { buildCodexExecArgs } from './codex-command';

const markdownResultSchema = z.object({
  document_date: z.string().describe('Document date found in content (prefer DD.MM.YYYY or YYYY-MM-DD).'),
  document_title: z.string().describe('Descriptive title. Do not include extension.'),
  page_subtitle: z.string().describe('Page-specific subtitle for this page (2-7 words).'),
  is_new_document: z.boolean().describe('true if this page starts a new document; false if continuation.'),
  content: z.string().describe('The full extracted markdown content.'),
});

type MarkdownResult = z.infer<typeof markdownResultSchema>;

export class DocumentProcessor {
  constructor(private config: Config) {}
  private lastDocumentDate = '';
  private lastDocumentTitle = '';

  private createVertexModel() {
    const vertex = createVertex({
      apiKey: this.config.vertexApiKey,
      project: this.config.vertexProject,
      location: this.config.vertexLocation,
    });

    return vertex(this.config.modelId! as any);
  }

  private buildInstructions(previousContext: string | undefined, outputMode: 'tool' | 'json'): string {
    const outputInstruction = outputMode === 'tool'
      ? `3. Call 'save_markdown' with:
   - document_date: best date found on this page; if continuation and no date is present, keep previous document date.
   - document_title: 2-7 words, descriptive title in document language.
   - page_subtitle: 2-7 words for this specific page section (must differ across pages of same document).
   - is_new_document: true for a new document, false for continuation.
   - content: full markdown extraction.`
      : `3. Return structured JSON with:
   - document_date: best date found on this page; if continuation and no date is present, keep previous document date.
   - document_title: 2-7 words, descriptive title in document language.
   - page_subtitle: 2-7 words for this specific page section (must differ across pages of same document).
   - is_new_document: true for a new document, false for continuation.
   - content: full markdown extraction.`;

    const parts = [
      `You are a document digitization expert. Digitize documents to clean Markdown.
Use rich formatting (# H1, ## H2, **bold**, tables, ---).

## Continuity & Context
The documents are processed in order. You will be provided with the end of the previous document if available.
Use this context to determine if this document is a continuation of the same court case or a new one.
Consistency in names, case numbers, and terminology is essential.

## Instructions
1. Convert the current document image to clean Markdown IN THE LANGUAGE OF THE DOCUMENT.
2. Decide if this page starts a new document or continues the previous one.
${outputInstruction}

Naming policy:
- Date must be first in filename (YYYY.MM.DD).
- Do not use image filename as a naming hint.`,
    ];

    if (this.lastDocumentDate || this.lastDocumentTitle) {
      parts.push(`Previously inferred document metadata:
- date: ${this.lastDocumentDate || 'unknown'}
- title: ${this.lastDocumentTitle || 'unknown'}
Use this only for continuity decision making.`);
    }

    if (previousContext) {
      parts.push(`Context from previous document(s):
---
${previousContext}
---
(End of context)`);
    }

    return parts.join('\n\n');
  }

  private async saveMarkdown(
    filename: string,
    input: MarkdownResult,
    existingOutputFile?: string,
  ): Promise<{ outputFile: string; inputFile: string; content: string }> {
    this.assertUsefulOcrResult(input);
    logger.info(`[SAVING LOGIC] Preparing to save markdown for file: ${filename}`);
    const normalizedDate = this.normalizeDateForFilename(input.document_date);
    const hasParsedDate = normalizedDate !== 'unknown-date';
    const parsedTitle = sanitizeFilename(input.document_title).replace(/\.md$/i, '');
    const parsedSubtitle = sanitizeFilename(input.page_subtitle).replace(/\.md$/i, '');

    // Safety override: if model marks continuation but the page has a different explicit date,
    // treat it as a new document boundary.
    const shouldForceNewDocument =
      !input.is_new_document &&
      hasParsedDate &&
      !!this.lastDocumentDate &&
      normalizedDate !== this.lastDocumentDate;

    const resolvedIsNewDocument = input.is_new_document || shouldForceNewDocument;

    const effectiveDate = resolvedIsNewDocument
      ? (hasParsedDate ? normalizedDate : 'unknown-date')
      : (this.lastDocumentDate || (hasParsedDate ? normalizedDate : 'unknown-date'));

    const effectiveTitle = resolvedIsNewDocument
      ? (parsedTitle || this.lastDocumentTitle || 'untitled_document')
      : (this.lastDocumentTitle || parsedTitle || 'untitled_document');

    const subtitlePart = parsedSubtitle || 'untitled_page';
    const desiredFilename = `${effectiveDate}_${effectiveTitle}_${subtitlePart}.md`;

    const fullPath = getOutputPath(this.config.outputDir, desiredFilename, existingOutputFile);
    const finalFilename = basename(fullPath);
    const imageExtension = extname(filename) || '.jpg';
    const desiredImageFilename = finalFilename.replace(/\.md$/i, imageExtension.toLowerCase());
    const finalImagePath = getInputRenamePath(this.config.inputDir, filename, desiredImageFilename);
    const finalImageFilename = basename(finalImagePath);

    const imagePrefix = this.config.imageRefPrefix.replace(/\/$/, '');
    const imagePath = `${imagePrefix}/${finalImageFilename}`;
    const sourceRef = `\n\n---\n**Source File:** \`${finalImageFilename}\`  \n![Source Image](<${imagePath}>)\n`;

    const contentWithRef = input.content + sourceRef;

    logger.info(`[WRITING FILE] Saving markdown for ${filename} to ${fullPath}`);
    await Bun.write(fullPath, contentWithRef);

    if (finalImageFilename !== filename) {
      await rename(join(this.config.inputDir, filename), finalImagePath);
    }

    this.lastDocumentDate = effectiveDate;
    this.lastDocumentTitle = effectiveTitle;

    logger.info(`[SAVED] Markdown for ${filename} stored as ${finalFilename}`, { sourceFile: finalImageFilename });
    return { outputFile: finalFilename, inputFile: finalImageFilename, content: input.content };
  }

  private assertUsefulOcrResult(input: MarkdownResult): void {
    const text = `${input.document_title}\n${input.page_subtitle}\n${input.content}`.toLowerCase();
    const refusalMarkers = [
      'bitte lade die seite',
      'bitte laden sie die seite',
      'bitte erneut einreichen',
      'nicht lesbar',
      'nicht verarbeitbar',
      'keine zuverlässige texterkennung',
      'cannot access the attached image',
      'cannot read the attached image',
      'please re-upload',
    ];

    if (refusalMarkers.some(marker => text.includes(marker))) {
      throw new Error('OCR model returned an image-access/refusal response instead of document text.');
    }
  }

  private async processFileWithCodexCli(params: {
    filename: string;
    previousContext?: string;
    existingOutputFile?: string;
    abortSignal?: AbortSignal;
  }): Promise<{ outputFile: string; inputFile: string; content: string }> {
    const { filename, previousContext, existingOutputFile, abortSignal } = params;
    const workDir = await mkdtemp(join(tmpdir(), 'docs-to-markdown-codex-'));
    const schemaPath = join(workDir, 'schema.json');
    const outputPath = join(workDir, 'result.json');
    // Codex may stage an ephemeral working context while processing attachments.
    // Pass an absolute path so the image remains resolvable in that context.
    const imagePath = resolve(this.config.inputDir, filename);
    const localCodexBin = join(process.cwd(), 'node_modules', '.bin', 'codex');
    // Package scripts prepend node_modules/.bin; search outside those first.
    const installedCliPath = (process.env.PATH ?? '').split(delimiter)
      .filter(p => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(p)).join(delimiter);
    const codexBin = process.env.CODEX_BIN?.trim() || Bun.which('codex', { PATH: installedCliPath }) ||
      (existsSync(localCodexBin) ? localCodexBin : 'codex');
    if (!existsSync(imagePath)) {
      throw new Error(`Input image does not exist: ${imagePath}`);
    }

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_date: { type: 'string' },
        document_title: { type: 'string' },
        page_subtitle: { type: 'string' },
        is_new_document: { type: 'boolean' },
        content: { type: 'string' },
      },
      required: ['document_date', 'document_title', 'page_subtitle', 'is_new_document', 'content'],
    };

    const prompt = `${this.buildInstructions(previousContext, 'json')}

Please convert the attached document image to markdown and return only the requested JSON shape.`;

    try {
      await writeFile(schemaPath, JSON.stringify(schema), 'utf8');

      const proc = Bun.spawn(
        buildCodexExecArgs({
          codexBin,
          modelId: this.config.modelId,
          imagePath,
          schemaPath,
          outputPath,
          prompt,
        }),
        {
          cwd: process.cwd(),
          stdout: 'pipe',
          stderr: 'pipe',
          signal: abortSignal,
          env: process.env,
        },
      );

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      if (exitCode !== 0) {
        throw new Error(`codex exec failed with exit code ${exitCode}: ${stderr || stdout}`);
      }

      const raw = await readFile(outputPath, 'utf8');
      const parsed = markdownResultSchema.parse(JSON.parse(raw));
      return await this.saveMarkdown(filename, parsed, existingOutputFile);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private normalizeDateForFilename(dateText: string): string {
    const raw = (dateText ?? '').trim();
    const m = raw.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})|(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
    if (!m) return 'unknown-date';

    let year = '';
    let month = '';
    let day = '';

    if (m[1] && m[2] && m[3]) {
      day = m[1].padStart(2, '0');
      month = m[2].padStart(2, '0');
      year = m[3].length === 2 ? `20${m[3]}` : m[3];
    } else if (m[4] && m[5] && m[6]) {
      year = m[4];
      month = m[5].padStart(2, '0');
      day = m[6].padStart(2, '0');
    }

    return `${year}.${month}.${day}`;
  }

  /**
   * Processes a single document image using Vertex AI.
   */
  async processFile(params: {
    filename: string;
    previousContext?: string;
    existingOutputFile?: string;
    abortSignal?: AbortSignal;
  }): Promise<{ outputFile: string; inputFile: string; content: string }> {
    const { filename, previousContext, existingOutputFile, abortSignal } = params;
    
    logger.info(`[PROCESS START] Processing file: ${filename}`, { 
      existingOutputFile, 
      previousContextExists: !!previousContext,
      abortSignalExists: !!abortSignal 
    });

    if (this.config.aiProvider === 'codex') {
      return await this.processFileWithCodexCli({
        filename,
        previousContext,
        existingOutputFile,
        abortSignal,
      });
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      logger.warn(`[TIMEOUT] Timeout reached for file: ${filename}`);
      timeoutController.abort();
    }, 60000); // 60 second timeout

    const combinedSignal = abortSignal 
      ? (AbortSignal as any).any([abortSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      logger.debug(`[SETUP] Creating AI client for file: ${filename}`, {
        aiProvider: this.config.aiProvider,
        vertexApiKey: !!this.config.vertexApiKey,
        project: this.config.vertexProject,
        location: this.config.vertexLocation,
        modelId: this.config.modelId
      });
      logger.debug(`[MODEL] Instantiating model for file: ${filename}`, { modelId: this.config.modelId });
      const model = this.createVertexModel();

      logger.debug(`[FILE READ] Reading image file: ${filename} from ${this.config.inputDir}`);
      const file = Bun.file(join(this.config.inputDir, filename));
      const imageBuffer = await file.arrayBuffer();
      logger.debug(`[FILE READ] Finished reading image file: ${filename} as buffer of size ${imageBuffer.byteLength}`);
      let savedContent = '';
      let savedOutputFile = '';
      let savedInputFile = filename;
      let alreadySaved = false;

      logger.info(`[GENERATION START] Starting generateText() for ${filename}`);
      const res = await generateText({
        model,
        abortSignal: combinedSignal,
        system: this.buildInstructions(previousContext, 'tool'),
        messages: [
          { 
            role: 'user', 
            content: [
              { type: 'text', text: 'Please convert this document image to markdown.' }, 
              { type: 'image', image: imageBuffer }
            ] 
          }
        ],
        tools: {
          save_markdown: tool({
            description: 'Save the extracted markdown to disk.',
            inputSchema: zodSchema(markdownResultSchema),
            execute: async (input) => {
              logger.debug(`[TOOL INVOKED] save_markdown called for ${filename} with input:`, input);
              if (alreadySaved) {
                logger.warn(`[MULTIPLE AGENT SAVE] Model tried to save again for ${filename}, ignoring.`, {
                  alreadySaved,
                  savedOutputFile
                });
                return { success: true, outputFile: savedOutputFile };
              }

              const saved = await this.saveMarkdown(filename, input, existingOutputFile);
              savedContent = saved.content;
              savedOutputFile = saved.outputFile;
              savedInputFile = saved.inputFile;
              alreadySaved = true;

              return { success: true, outputFile: savedOutputFile, inputFile: savedInputFile };
            },
          }),
        },
        toolChoice: 'required',
        stopWhen: stepCountIs(1),
      });

      logger.debug(`[AGENT RESPONSE] Received result from generateText() for ${filename}`, {
        toolResults: res.toolResults && res.toolResults.length
      });

      if (savedOutputFile) {
        logger.info(`[FINAL RETURN] Returning (early) for ${filename} (savedOutputFile)`, { savedOutputFile });
        return { outputFile: savedOutputFile, inputFile: savedInputFile, content: savedContent };
      }
      
      logger.debug(`[TOOL RESULT LOOKUP] Searching for 'save_markdown' tool result for ${filename}`);
      const tr = res.toolResults.find(r => r.toolName === 'save_markdown');
      if (tr?.type === 'tool-result' && (tr.output as any)?.outputFile) {
        logger.info(`[FINAL RETURN] Returning for ${filename} from tool result`, { outputFile: (tr.output as any).outputFile });
        return {
          outputFile: (tr.output as any).outputFile,
          inputFile: (tr.output as any).inputFile || savedInputFile,
          content: savedContent
        };
      }

      logger.error(`[ERROR] Model finished without successfully calling save_markdown tool for ${filename}`);
      throw new Error('Model finished without successfully calling save_markdown tool.');
    } catch (error: any) {
      if (error.name === 'AbortError' || combinedSignal.aborted) {
        logger.error(`[ABORTED/TIMEOUT] Aborted or timed out processing ${filename}`);
        throw new Error(`Timeout or abort while processing ${filename}`);
      } else {
        logger.error(`[AGENT ERROR] Error processing file ${filename}: ${error.message}`, {
          error,
          filename
        });
      }
      throw error;
    } finally {
      logger.debug(`[CLEANUP] Clearing timeout for file: ${filename}`);
      clearTimeout(timeoutId);
    }
  }
}
