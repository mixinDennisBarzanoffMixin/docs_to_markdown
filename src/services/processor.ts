import { createVertex } from '@ai-sdk/google-vertex';
import { generateText, tool, zodSchema, stepCountIs } from 'ai';
import { join, basename } from 'path';
import { z } from 'zod';
import type { Config } from '../types';
import { logger } from '../lib/logger';
import { getOutputPath, sanitizeFilename } from '../lib/file-system';

export class DocumentProcessor {
  constructor(private config: Config) {}
  private lastDocumentDate = '';
  private lastDocumentTitle = '';

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
  }): Promise<{ outputFile: string; content: string }> {
    const { filename, previousContext, existingOutputFile, abortSignal } = params;
    
    logger.info(`[PROCESS START] Processing file: ${filename}`, { 
      existingOutputFile, 
      previousContextExists: !!previousContext,
      abortSignalExists: !!abortSignal 
    });

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      logger.warn(`[TIMEOUT] Timeout reached for file: ${filename}`);
      timeoutController.abort();
    }, 60000); // 60 second timeout

    const combinedSignal = abortSignal 
      ? (AbortSignal as any).any([abortSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      logger.debug(`[SETUP] Creating Vertex client for file: ${filename}`, {
        vertexApiKey: !!this.config.vertexApiKey,
        project: this.config.vertexProject,
        location: this.config.vertexLocation,
        modelId: this.config.modelId
      });
      const vertex = createVertex({
        apiKey: this.config.vertexApiKey,
        project: this.config.vertexProject,
        location: this.config.vertexLocation,
      });

      logger.debug(`[MODEL] Instantiating model for file: ${filename}`, { modelId: this.config.modelId });
      const model = vertex(this.config.modelId as any);

      logger.debug(`[FILE READ] Reading image file: ${filename} from ${this.config.inputDir}`);
      const file = Bun.file(join(this.config.inputDir, filename));
      const imageBuffer = await file.arrayBuffer();
      logger.debug(`[FILE READ] Finished reading image file: ${filename} as buffer of size ${imageBuffer.byteLength}`);
      let savedContent = '';
      let savedOutputFile = '';
      let alreadySaved = false;

      logger.info(`[GENERATION START] Starting generateText() for ${filename}`);
      const res = await generateText({
        model,
        abortSignal: combinedSignal,
        system: `You are a document digitization expert. Digitize documents to clean Markdown.
Use rich formatting (# H1, ## H2, **bold**, tables, ---).

## Continuity & Context
The documents are processed in order. You will be provided with the end of the previous document if available.
Use this context to determine if this document is a continuation of the same court case or a new one.
Consistency in names, case numbers, and terminology is essential.

## Instructions
1. Convert the current document image to clean Markdown IN THE LANGUAGE OF THE DOCUMENT.
2. Decide if this page starts a new document or continues the previous one.
3. Call 'save_markdown' with:
   - document_date: best date found on this page; if continuation and no date is present, keep previous document date.
   - document_title: 2-7 words, descriptive title in document language.
   - page_subtitle: 2-7 words for this specific page section (must differ across pages of same document).
   - is_new_document: true for a new document, false for continuation.
   - content: full markdown extraction.

Naming policy:
- Date must be first in filename (YYYY.MM.DD).
- Do not use image filename as a naming hint.`,
        messages: [
          ...((this.lastDocumentDate || this.lastDocumentTitle) ? [{
            role: 'user',
            content: `Previously inferred document metadata:\n- date: ${this.lastDocumentDate || 'unknown'}\n- title: ${this.lastDocumentTitle || 'unknown'}\nUse this only for continuity decision making.`
          } as const] : []),
          ...(previousContext ? [{
            role: 'user',
            content: `Context from previous document(s):\n---\n${previousContext}\n---\n(End of context)`
          } as const] : []),
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
            inputSchema: zodSchema(z.object({ 
              document_date: z.string().describe('Document date found in content (prefer DD.MM.YYYY or YYYY-MM-DD).'),
              document_title: z.string().describe('Descriptive title. Do not include extension.'),
              page_subtitle: z.string().describe('Page-specific subtitle for this page (2-7 words).'),
              is_new_document: z.boolean().describe('true if this page starts a new document; false if continuation.'),
              content: z.string().describe('The full extracted markdown content.')
            })),
            execute: async (input) => {
              logger.debug(`[TOOL INVOKED] save_markdown called for ${filename} with input:`, input);
              if (alreadySaved) {
                logger.warn(`[MULTIPLE AGENT SAVE] Model tried to save again for ${filename}, ignoring.`, {
                  alreadySaved,
                  savedOutputFile
                });
                return { success: true, outputFile: savedOutputFile };
              }

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
              
              const imagePath = `../${this.config.inputDir}/${filename}`;
              const sourceRef = `\n\n---\n**Source File:** \`${filename}\`  \n![Source Image](<${imagePath}>)\n`;
              
              savedContent = input.content;
              const contentWithRef = savedContent + sourceRef;
              
              logger.info(`[WRITING FILE] Saving markdown for ${filename} to ${fullPath}`);
              // Use Bun.write for writing
              await Bun.write(fullPath, contentWithRef);
              
              savedOutputFile = finalFilename;
              alreadySaved = true;
              this.lastDocumentDate = effectiveDate;
              this.lastDocumentTitle = effectiveTitle;

              logger.info(`[SAVED] Markdown for ${filename} stored as ${finalFilename}`);
              return { success: true, outputFile: finalFilename };
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
        return { outputFile: savedOutputFile, content: savedContent };
      }
      
      logger.debug(`[TOOL RESULT LOOKUP] Searching for 'save_markdown' tool result for ${filename}`);
      const tr = res.toolResults.find(r => r.toolName === 'save_markdown');
      if (tr?.type === 'tool-result' && (tr.output as any)?.outputFile) {
        logger.info(`[FINAL RETURN] Returning for ${filename} from tool result`, { outputFile: (tr.output as any).outputFile });
        return { outputFile: (tr.output as any).outputFile, content: savedContent };
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

