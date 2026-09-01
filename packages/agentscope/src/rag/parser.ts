/* eslint-disable jsdoc/require-jsdoc */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { Base64Source, DataBlock, TextBlock } from '../message';
import { Section } from './document';

export type ParserInput = Buffer | Uint8Array | string;

/** Base contract for one file-format parser. */
export abstract class ParserBase {
    static readonly supportedMediaTypes: readonly string[] = [];
    static readonly supportedExtensions: readonly string[] = [];

    abstract parse(file: ParserInput, filename: string): Promise<Section[]>;
}

/** Parse unstructured text from bytes, a path, or a decoded string. */
export class TextParser extends ParserBase {
    static readonly supportedMediaTypes = [
        'text/plain',
        'text/markdown',
        'text/csv',
        'text/html',
        'text/x-rst',
        'application/json',
        'application/xml',
        'application/x-yaml',
    ] as const;
    static readonly supportedExtensions = [
        '.csv',
        '.htm',
        '.html',
        '.json',
        '.markdown',
        '.md',
        '.rst',
        '.txt',
        '.xml',
        '.yaml',
        '.yml',
    ] as const;

    constructor(readonly encoding = 'utf-8') {
        super();
    }

    async parse(file: ParserInput, filename: string): Promise<Section[]> {
        let text: string;
        if (typeof file === 'string' && !existsSync(file)) {
            text = file;
        } else {
            const bytes = typeof file === 'string' ? await readFile(file) : file;
            try {
                if (
                    this.encoding.toLowerCase() === 'ascii' &&
                    Buffer.from(bytes).some(byte => byte > 0x7f)
                ) {
                    throw new TypeError('The input is not valid ASCII.');
                }
                text = new TextDecoder(this.encoding, { fatal: true }).decode(bytes);
            } catch (error) {
                throw new Error(
                    `Failed to decode ${JSON.stringify(filename)} as ${JSON.stringify(this.encoding)}: ${String(error)}`,
                    { cause: error }
                );
            }
        }
        return [Section({ content: TextBlock({ text }), source: filename })];
    }
}

/** Wrap an image as one multimodal section without OCR. */
export class ImageParser extends ParserBase {
    static readonly supportedMediaTypes = [
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/bmp',
        'image/webp',
    ] as const;
    static readonly supportedExtensions = [
        '.bmp',
        '.gif',
        '.jpeg',
        '.jpg',
        '.png',
        '.webp',
    ] as const;

    async parse(file: ParserInput, filename: string): Promise<Section[]> {
        const bytes = await readBinaryInput(file);
        const mediaType = guessImageMediaType(bytes);
        return [
            Section({
                content: DataBlock({
                    source: Base64Source({ data: bytes.toString('base64'), media_type: mediaType }),
                    name: filename,
                }),
                source: filename,
                metadata: { media_type: mediaType },
            }),
        ];
    }
}

/** Parse each PDF page into a hard section boundary. */
export class PDFParser extends ParserBase {
    static readonly supportedMediaTypes = ['application/pdf'] as const;
    static readonly supportedExtensions = ['.pdf'] as const;

    async parse(file: ParserInput, filename: string): Promise<Section[]> {
        const bytes = await readBinaryInput(file);
        try {
            const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
            const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
            const sections: Section[] = [];
            for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
                const page = await pdf.getPage(pageIndex);
                const content = await page.getTextContent();
                let text = '';
                for (const item of content.items) {
                    if (!('str' in item)) continue;
                    text += item.str;
                    text += item.hasEOL ? '\n' : ' ';
                }
                sections.push(
                    Section({
                        content: TextBlock({ text: text.trimEnd() + (text ? '\n' : '') }),
                        source: filename,
                        metadata: { page: pageIndex },
                    })
                );
            }
            return sections;
        } catch (error) {
            throw new Error(
                `Failed to parse ${JSON.stringify(filename)} as PDF: ${String(error)}`,
                { cause: error }
            );
        }
    }
}

export async function readBinaryInput(file: ParserInput): Promise<Buffer> {
    if (typeof file === 'string') return readFile(file);
    return Buffer.from(file);
}

export function guessImageMediaType(data: Uint8Array): string {
    const buffer = Buffer.from(data);
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (
        buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
        buffer.subarray(0, 6).toString('ascii') === 'GIF89a'
    )
        return 'image/gif';
    if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
    if (
        buffer.length > 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    )
        return 'image/webp';
    return 'image/jpeg';
}

function formatMarkdownTableCell(cell: string): string {
    return cell
        .replace(/\r\n?/g, '\n')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\n/g, '<br>');
}

export function tableToMarkdown(table: string[][]): string {
    if (!table.length || !table[0].length) return '';
    const columns = table[0].length;
    const rows = [
        `| ${table[0].map(formatMarkdownTableCell).join(' | ')} |`,
        `| ${Array(columns).fill('---').join(' | ')} |`,
    ];
    for (const row of table.slice(1)) {
        const cells = [...row, ...Array(Math.max(0, columns - row.length)).fill('')]
            .slice(0, columns)
            .map(formatMarkdownTableCell);
        rows.push(`| ${cells.join(' | ')} |`);
    }
    return `${rows.join('\n')}\n`;
}

export function tableToJSON(table: string[][]): string {
    return `<system-info>A table loaded as a JSON array:</system-info>\n${JSON.stringify(table)}`;
}
