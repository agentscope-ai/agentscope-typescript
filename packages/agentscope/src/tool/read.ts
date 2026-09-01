/* eslint-disable jsdoc/require-jsdoc */

import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';

import { Base64Source, DataBlock, TextBlock } from '../message';
import type { PermissionDecision, PermissionRule } from '../permission';
import { PermissionBehavior, createPermissionDecision } from '../permission';
import type { AgentState } from '../state';
import type { BackendBase } from './backend';
import { LocalBackend, normalizeNewlines } from './backend';
import { ToolBase } from './base';
import type { ToolMiddlewareBase } from './base';
import { ToolChunk } from './response';
import { fnmatchPath } from './utils';

const IMAGE_EXTENSIONS: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.ico': 'image/x-icon',
};

const PDF_MAX_PAGES_WITHOUT_RANGE = 10;
const PDF_MAX_PAGES_PER_READ = 20;
const DEFAULT_MODEL_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export interface ReadToolOptions {
    maxLineCharacters?: number;
    modelInputTypes?: string[];
    backend?: BackendBase;
    middlewares?: ToolMiddlewareBase[];
}

/** Python-compatible builtin file reader. */
export class ReadTool extends ToolBase {
    readonly name = 'Read';
    readonly inputSchema = z.object({
        file_path: z.string().describe('The absolute path to the file to read.'),
        offset: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(2000).default(2000),
        pages: z.string().nullable().optional(),
    });
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;
    override isStateInjected = true;
    readonly modelInputTypes: string[];
    private readonly maxLineCharacters: number;
    private readonly backend: BackendBase;

    constructor(options: ReadToolOptions = {}) {
        super({ middlewares: options.middlewares });
        this.maxLineCharacters = options.maxLineCharacters ?? 2000;
        this.modelInputTypes = options.modelInputTypes ?? DEFAULT_MODEL_INPUT_TYPES;
        this.backend = options.backend ?? new LocalBackend();
    }

    get description(): string {
        const imageTypes = this.modelInputTypes.filter(type => type.startsWith('image/'));
        const imageLine = imageTypes.length
            ? `\n- This tool allows you to read images (${imageTypes.join(', ')}).`
            : '';
        const pdfPresentation = this.accepts('application/pdf')
            ? 'the pages are presented to you as a document.'
            : 'text is extracted per page.';
        return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit
- Results are returned using cat -n format, with line numbers starting at 1${imageLine}
- This tool can read PDF files (.pdf). When reading a PDF ${pdfPresentation}`;
    }

    async checkPermissions(): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.PASSTHROUGH,
            message: 'File reading is read-only.',
        });
    }

    override async matchRule(
        ruleContent: string,
        toolInput: Record<string, unknown>
    ): Promise<boolean> {
        const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
        return filePath !== '' && fnmatchPath(filePath, ruleContent);
    }

    override async generateSuggestions(
        toolInput: Record<string, unknown>
    ): Promise<PermissionRule[]> {
        const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
        if (!filePath) return [];
        const parent = this.backend.dirname(filePath);
        return [
            {
                tool_name: this.name,
                rule_content: parent ? `${parent.replace(/[\\/]+$/, '')}/**` : '**',
                behavior: PermissionBehavior.ALLOW,
                source: 'suggested',
            },
        ];
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const parsed = this.inputSchema.parse(input);
        const filePath = parsed.file_path;
        if (!this.backend.isAbsolute(filePath)) {
            return errorChunk(`Error: file_path must be an absolute path, got: ${filePath}`);
        }
        if (!(await this.backend.fileExists(filePath))) {
            return errorChunk(`Error: File does not exist: ${filePath}`);
        }
        if (await this.backend.isDirectory(filePath)) {
            return errorChunk(`Error: Path is a directory, not a file: ${filePath}`);
        }

        const basename = this.backend.basename(filePath);
        const extension = basename.includes('.')
            ? `.${basename.split('.').at(-1)!.toLowerCase()}`
            : '';
        if (extension === '.pdf') return await this.readPdf(filePath, parsed.pages ?? null);
        if (IMAGE_EXTENSIONS[extension]) {
            return await this.readImage(filePath, extension);
        }
        return await this.readText(
            filePath,
            parsed.offset,
            parsed.limit,
            input._agent_state as AgentState | undefined
        );
    }

    private accepts(mediaType: string): boolean {
        return this.modelInputTypes.some(pattern => {
            if (pattern.endsWith('/*')) return mediaType.startsWith(pattern.slice(0, -1));
            return pattern === mediaType;
        });
    }

    private async readImage(filePath: string, extension: string): Promise<ToolChunk> {
        const mediaType = IMAGE_EXTENSIONS[extension];
        if (!this.accepts(mediaType)) {
            const allowed = this.modelInputTypes.filter(type => type.startsWith('image/'));
            return errorChunk(
                `Error: Unsupported image type ${mediaType}, only ${allowed.join(', ') || 'none'} are supported.`
            );
        }
        try {
            const raw = await this.backend.readFile(filePath);
            return new ToolChunk({
                content: [
                    DataBlock({
                        source: Base64Source({
                            data: raw.toString('base64'),
                            media_type: mediaType,
                        }),
                        name: this.backend.basename(filePath),
                    }),
                ],
            });
        } catch (error) {
            return errorChunk(`Error reading file: ${errorMessage(error)}`);
        }
    }

    private async readPdf(filePath: string, pages: string | null): Promise<ToolChunk> {
        try {
            const raw = await this.backend.readFile(filePath);
            const document = await PDFDocument.load(raw);
            const totalPages = document.getPageCount();
            const range = parsePageRange(pages, totalPages);
            if ('error' in range) return errorChunk(range.error);

            if (this.accepts('application/pdf')) {
                let output = raw;
                if (range.first !== 1 || range.last !== totalPages) {
                    const selected = await PDFDocument.create();
                    const indices = Array.from(
                        { length: range.last - range.first + 1 },
                        (_, index) => range.first - 1 + index
                    );
                    const copied = await selected.copyPages(document, indices);
                    copied.forEach(page => selected.addPage(page));
                    output = Buffer.from(await selected.save());
                }
                return new ToolChunk({
                    content: [
                        DataBlock({
                            source: Base64Source({
                                data: output.toString('base64'),
                                media_type: 'application/pdf',
                            }),
                            name: this.backend.basename(filePath),
                        }),
                    ],
                });
            }

            const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
            const pdf = await pdfjs.getDocument({ data: new Uint8Array(raw) }).promise;
            const text: string[] = [];
            for (let pageNumber = range.first; pageNumber <= range.last; pageNumber += 1) {
                const page = await pdf.getPage(pageNumber);
                const content = await page.getTextContent();
                const pageText = content.items
                    .map(item => ('str' in item ? item.str : ''))
                    .join(' ');
                text.push(`--- Page ${pageNumber}/${totalPages} ---\n${pageText}`);
            }
            return new ToolChunk({ content: [TextBlock({ text: text.join('\n\n') })] });
        } catch (error) {
            return errorChunk(`Error reading PDF: ${errorMessage(error)}`);
        }
    }

    private async readText(
        filePath: string,
        offset: number,
        limit: number,
        state?: AgentState
    ): Promise<ToolChunk> {
        try {
            const mtime = await this.backend.statMtime(filePath);
            let lines = state
                ? (await state.toolContext.getCache({ filePath, mtime }))?.lines
                : undefined;
            if (!lines) {
                const content = normalizeNewlines(
                    (await this.backend.readFile(filePath)).toString('utf8')
                );
                lines = content.match(/.*(?:\n|$)/g)?.filter(line => line !== '') ?? [];
                if (state) await state.toolContext.cacheFile({ filePath, lines, mtime });
            }
            const text = lines
                .slice(offset - 1, offset - 1 + limit)
                .map((line, index) => {
                    let content = line.replace(/[\r\n]+$/, '');
                    if (content.length > this.maxLineCharacters) {
                        content = `${content.slice(0, this.maxLineCharacters)}[truncated]`;
                    }
                    return `${String(offset + index).padStart(6)}\t${content}`;
                })
                .join('\n');
            return new ToolChunk({ content: [TextBlock({ text })] });
        } catch (error) {
            return errorChunk(`Error reading file: ${errorMessage(error)}`);
        }
    }
}

/**
 * Preserve the existing TypeScript factory API while returning ToolBase.
 * @param options
 */
export function Read(options: ReadToolOptions = {}): ReadTool {
    return new ReadTool(options);
}

function parsePageRange(
    pages: string | null,
    totalPages: number
): { first: number; last: number } | { error: string } {
    if (pages === null) {
        if (totalPages > PDF_MAX_PAGES_WITHOUT_RANGE) {
            return {
                error:
                    `Error: PDF has ${totalPages} pages, more than ` +
                    `${PDF_MAX_PAGES_WITHOUT_RANGE}. You must provide the pages parameter ` +
                    `(e.g. "1-5") to read specific pages, max ` +
                    `${PDF_MAX_PAGES_PER_READ} pages per request.`,
            };
        }
        return { first: 1, last: totalPages };
    }
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(pages);
    if (!match) {
        return {
            error: `Error: Invalid pages ${JSON.stringify(pages)}. Expected a page number or range like "3" or "1-5".`,
        };
    }
    const first = Number(match[1]);
    let last = Number(match[2] ?? match[1]);
    if (first < 1 || first > last || first > totalPages) {
        return {
            error: `Error: Invalid pages ${JSON.stringify(pages)}. PDF has ${totalPages} page(s).`,
        };
    }
    last = Math.min(last, totalPages);
    if (last - first + 1 > PDF_MAX_PAGES_PER_READ) {
        return {
            error: `Error: Requested ${last - first + 1} pages, at most ${PDF_MAX_PAGES_PER_READ} pages can be read per request.`,
        };
    }
    return { first, last };
}

function errorChunk(message: string): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text: message })], state: 'error' });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
