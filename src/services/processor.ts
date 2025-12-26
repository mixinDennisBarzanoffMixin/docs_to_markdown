import { createVertex } from '@ai-sdk/google-vertex';
import { generateText, tool, zodSchema, stepCountIs } from 'ai';
import { join, basename } from 'path';
import { z } from 'zod';
import type { Config } from '../types';
import { logger } from '../lib/logger';
import { getOutputPath, sanitizeFilename } from '../lib/file-system';

export class DocumentProcessor {
  constructor(private config: Config) {}

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
      const imageBasename = filename.replace(/\.[^.]+$/, '');

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
2. Call 'save_markdown' with a descriptive title IN THE LANGUAGE OF THE DOCUMENT.
   - Title: 2-5 words, describing document type/subject.
   - Content: Full markdown extraction.`,
        messages: [
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
              filename: z.string().describe('Descriptive title for the file (e.g. "Court_Decision"). Do not include image ID or .md extension.'), 
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
              const titlePart = sanitizeFilename(input.filename).replace(/\.md$/i, '');
              const desiredFilename = `${imageBasename}__${titlePart}.md`;
              
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

