/* eslint-disable jsdoc/require-jsdoc */

import { posix } from 'node:path';

import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

import { Base64Source, DataBlock, TextBlock } from '../message';
import { Section } from './document';
import {
    ParserBase,
    type ParserInput,
    guessImageMediaType,
    readBinaryInput,
    tableToJSON,
    tableToMarkdown,
} from './parser';

type XMLNode = Record<string, unknown>;
type TableFormat = 'markdown' | 'json';

const orderedParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    parseTagValue: false,
    trimValues: false,
});
const objectParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
});

interface Relationship {
    id: string;
    target: string;
    contentType?: string;
}

function validateTableFormat(format: string): asserts format is TableFormat {
    if (format !== 'markdown' && format !== 'json') {
        throw new Error(
            `The table_format must be one of 'markdown' or 'json', got ${JSON.stringify(format)}.`
        );
    }
}

function asNodes(value: unknown): XMLNode[] {
    return Array.isArray(value) ? (value as XMLNode[]) : [];
}

function childNodes(node: XMLNode, tag: string): XMLNode[] {
    return asNodes(node[tag]);
}

function attributes(node: XMLNode): Record<string, string> {
    const value = node[':@'];
    return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

function findChildren(nodes: XMLNode[], tag: string): XMLNode[] {
    const found: XMLNode[] = [];
    for (const node of nodes) {
        if (tag in node) found.push(node);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) found.push(...findChildren(value as XMLNode[], tag));
        }
    }
    return found;
}

function orderedText(
    nodes: XMLNode[],
    textTags: Set<string>,
    breakTags = new Set<string>()
): string {
    let result = '';
    for (const node of nodes) {
        for (const [tag, value] of Object.entries(node)) {
            if (tag === '#text') {
                result += String(value);
            } else if (breakTags.has(tag)) {
                result += '\n';
            } else if (Array.isArray(value)) {
                const nested = orderedText(value as XMLNode[], textTags, breakTags);
                if (textTags.has(tag)) result += nested;
                else result += nested;
            }
        }
    }
    return result;
}

async function zipText(zip: JSZip, path: string): Promise<string> {
    const entry = zip.file(path);
    if (!entry) throw new Error(`Missing archive entry: ${path}`);
    return entry.async('string');
}

async function relationships(zip: JSZip, path: string): Promise<Map<string, Relationship>> {
    const entry = zip.file(path);
    if (!entry) return new Map();
    const parsed = objectParser.parse(await entry.async('string')) as XMLNode;
    const root = parsed.Relationships as XMLNode | undefined;
    const raw = root?.Relationship;
    const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return new Map(
        (rows as XMLNode[]).map(row => {
            const id = String(row['@_Id']);
            return [
                id,
                {
                    id,
                    target: String(row['@_Target']),
                    contentType: row['@_Type'] ? String(row['@_Type']) : undefined,
                },
            ];
        })
    );
}

function archiveTarget(baseFile: string, target: string): string {
    if (target.startsWith('/')) return posix.normalize(target.slice(1));
    return posix.normalize(posix.join(posix.dirname(baseFile), target));
}

async function imageBlock(
    zip: JSZip,
    path: string,
    filename: string
): Promise<ReturnType<typeof DataBlock>> {
    const entry = zip.file(path);
    if (!entry) throw new Error(`Missing embedded image: ${path}`);
    const bytes = await entry.async('nodebuffer');
    const mediaType = guessImageMediaType(bytes);
    return DataBlock({
        source: Base64Source({ media_type: mediaType, data: bytes.toString('base64') }),
        name: filename,
    });
}

function renderTable(table: string[][], format: TableFormat): string {
    return format === 'markdown' ? tableToMarkdown(table) : tableToJSON(table);
}

export interface WordParserOptions {
    include_image?: boolean;
    separate_table?: boolean;
    table_format?: TableFormat;
}

/** Parse DOCX content in body order, preserving tables and images. */
export class WordParser extends ParserBase {
    static readonly supportedMediaTypes = [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ] as const;
    static readonly supportedExtensions = ['.docx'] as const;
    readonly includeImage: boolean;
    readonly separateTable: boolean;
    readonly tableFormat: TableFormat;

    constructor(options: WordParserOptions = {}) {
        super();
        validateTableFormat(options.table_format ?? 'markdown');
        this.includeImage = options.include_image ?? true;
        this.separateTable = options.separate_table ?? false;
        this.tableFormat = options.table_format ?? 'markdown';
    }

    async parse(file: ParserInput, filename: string): Promise<Section[]> {
        const zip = await JSZip.loadAsync(await readBinaryInput(file));
        const parsed = orderedParser.parse(await zipText(zip, 'word/document.xml')) as XMLNode[];
        const body = findChildren(parsed, 'w:body')[0];
        const rels = await relationships(zip, 'word/_rels/document.xml.rels');
        const sections: Section[] = [];
        const textBuffer: string[] = [];
        const flushText = (): void => {
            if (!textBuffer.length) return;
            sections.push(
                Section({ content: TextBlock({ text: textBuffer.join('\n') }), source: filename })
            );
            textBuffer.length = 0;
        };

        for (const element of body ? childNodes(body, 'w:body') : []) {
            if (element['w:p']) {
                const paragraph = childNodes(element, 'w:p');
                const text = orderedText(
                    paragraph,
                    new Set(['w:t']),
                    new Set(['w:br', 'w:cr'])
                ).trim();
                if (text) textBuffer.push(text);
                if (this.includeImage) {
                    const refs = [
                        ...findChildren(paragraph, 'a:blip').map(
                            node => attributes(node)['@_r:embed']
                        ),
                        ...findChildren(paragraph, 'v:imagedata').map(
                            node => attributes(node)['@_r:id']
                        ),
                    ].filter(Boolean);
                    if (refs.length) flushText();
                    for (const ref of refs) {
                        const relationship = rels.get(ref);
                        if (!relationship) continue;
                        const block = await imageBlock(
                            zip,
                            archiveTarget('word/document.xml', relationship.target),
                            filename
                        );
                        sections.push(
                            Section({
                                content: block,
                                source: filename,
                                metadata: { media_type: block.source.media_type },
                            })
                        );
                    }
                }
            } else if (element['w:tbl']) {
                const table = this.extractWordTable(childNodes(element, 'w:tbl'));
                const rendered = renderTable(table, this.tableFormat);
                if (!rendered) continue;
                if (this.separateTable) {
                    flushText();
                    sections.push(
                        Section({ content: TextBlock({ text: rendered }), source: filename })
                    );
                } else {
                    textBuffer.push(rendered);
                }
            }
        }
        flushText();
        return sections;
    }

    private extractWordTable(nodes: XMLNode[]): string[][] {
        return findChildren(nodes, 'w:tr').map(row => {
            const cells: string[] = [];
            for (const cell of findChildren([row], 'w:tc')) {
                const paragraphs = findChildren([cell], 'w:p')
                    .map(paragraph =>
                        orderedText([paragraph], new Set(['w:t']), new Set(['w:br', 'w:cr']))
                    )
                    .filter(Boolean);
                cells.push(paragraphs.join('\n'));
                const gridSpan = findChildren([cell], 'w:gridSpan')[0];
                const span = Number(gridSpan ? (attributes(gridSpan)['@_w:val'] ?? 1) : 1);
                cells.push(...Array(Math.max(0, span - 1)).fill(''));
            }
            return cells;
        });
    }
}

export interface PPTParserOptions {
    include_image?: boolean;
    separate_table?: boolean;
    table_format?: TableFormat;
    slide_prefix?: string | null;
    slide_suffix?: string | null;
}

/** Parse PPTX shapes in slide order with explicit slide boundaries. */
export class PPTParser extends ParserBase {
    static readonly supportedMediaTypes = [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ] as const;
    static readonly supportedExtensions = ['.pptx'] as const;
    readonly includeImage: boolean;
    readonly separateTable: boolean;
    readonly tableFormat: TableFormat;
    readonly slidePrefix: string | null;
    readonly slideSuffix: string | null;

    constructor(options: PPTParserOptions = {}) {
        super();
        validateTableFormat(options.table_format ?? 'markdown');
        this.includeImage = options.include_image ?? true;
        this.separateTable = options.separate_table ?? false;
        this.tableFormat = options.table_format ?? 'markdown';
        this.slidePrefix =
            options.slide_prefix === undefined ? '<slide index={index}>' : options.slide_prefix;
        this.slideSuffix = options.slide_suffix === undefined ? '</slide>' : options.slide_suffix;
    }

    async parse(file: ParserInput, filename: string): Promise<Section[]> {
        const zip = await JSZip.loadAsync(await readBinaryInput(file));
        const presentation = orderedParser.parse(
            await zipText(zip, 'ppt/presentation.xml')
        ) as XMLNode[];
        const presentationRels = await relationships(zip, 'ppt/_rels/presentation.xml.rels');
        const slideRefs = findChildren(presentation, 'p:sldId').map(
            node => attributes(node)['@_r:id']
        );
        const sections: Section[] = [];
        for (const [index, ref] of slideRefs.entries()) {
            const relationship = presentationRels.get(ref);
            if (!relationship) continue;
            const slidePath = archiveTarget('ppt/presentation.xml', relationship.target);
            sections.push(...(await this.parseSlide(zip, slidePath, index + 1, filename)));
        }
        return sections;
    }

    private async parseSlide(
        zip: JSZip,
        slidePath: string,
        slide: number,
        filename: string
    ): Promise<Section[]> {
        const parsed = orderedParser.parse(await zipText(zip, slidePath)) as XMLNode[];
        const tree = findChildren(parsed, 'p:spTree')[0];
        const relPath = posix.join(
            posix.dirname(slidePath),
            '_rels',
            `${posix.basename(slidePath)}.rels`
        );
        const rels = await relationships(zip, relPath);
        const sections: Section[] = [];
        const textBuffer: string[] = [];
        const prefix = this.slidePrefix?.replaceAll('{index}', String(slide)) ?? '';
        if (prefix) textBuffer.push(prefix);
        const flush = (): void => {
            if (!textBuffer.length) return;
            sections.push(
                Section({
                    content: TextBlock({ text: textBuffer.join('\n') }),
                    source: filename,
                    metadata: { slide },
                })
            );
            textBuffer.length = 0;
        };

        for (const shape of tree ? childNodes(tree, 'p:spTree') : []) {
            if (shape['p:pic'] && this.includeImage) {
                const picture = childNodes(shape, 'p:pic');
                const ref = findChildren(picture, 'a:blip')
                    .map(node => attributes(node)['@_r:embed'])
                    .find(Boolean);
                const relationship = ref ? rels.get(ref) : undefined;
                if (relationship) {
                    flush();
                    const block = await imageBlock(
                        zip,
                        archiveTarget(slidePath, relationship.target),
                        filename
                    );
                    sections.push(
                        Section({
                            content: block,
                            source: filename,
                            metadata: { slide, media_type: block.source.media_type },
                        })
                    );
                    continue;
                }
            }
            if (shape['p:graphicFrame']) {
                const tables = findChildren(childNodes(shape, 'p:graphicFrame'), 'a:tbl');
                if (tables.length) {
                    const rendered = renderTable(
                        this.extractPptTable([tables[0]]),
                        this.tableFormat
                    );
                    if (rendered) {
                        if (this.separateTable) {
                            flush();
                            sections.push(
                                Section({
                                    content: TextBlock({ text: rendered }),
                                    source: filename,
                                    metadata: { slide },
                                })
                            );
                        } else textBuffer.push(rendered);
                    }
                    continue;
                }
            }
            if (shape['p:sp']) {
                const paragraphs = findChildren(childNodes(shape, 'p:sp'), 'a:p')
                    .map(paragraph =>
                        orderedText([paragraph], new Set(['a:t']), new Set(['a:br'])).trim()
                    )
                    .filter(Boolean);
                if (paragraphs.length) textBuffer.push(paragraphs.join('\n'));
            }
        }
        if (this.slideSuffix !== null) textBuffer.push(this.slideSuffix);
        flush();
        return sections;
    }

    private extractPptTable(nodes: XMLNode[]): string[][] {
        return findChildren(nodes, 'a:tr').map(row =>
            findChildren([row], 'a:tc').map(cell =>
                orderedText([cell], new Set(['a:t']), new Set(['a:br']))
                    .trim()
                    .replace(/\r\n?|\v/g, '\n')
            )
        );
    }
}

export interface ExcelParserOptions {
    include_sheet_names?: boolean;
    include_cell_coordinates?: boolean;
    include_image?: boolean;
    separate_sheet?: boolean;
    table_format?: TableFormat;
}

/** Parse OOXML Excel workbooks sheet by sheet. */
export class ExcelParser extends ParserBase {
    static readonly supportedMediaTypes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
    ] as const;
    static readonly supportedExtensions = ['.xls', '.xlsx'] as const;
    readonly includeSheetNames: boolean;
    readonly includeCellCoordinates: boolean;
    readonly includeImage: boolean;
    readonly separateSheet: boolean;
    readonly tableFormat: TableFormat;

    constructor(options: ExcelParserOptions = {}) {
        super();
        validateTableFormat(options.table_format ?? 'markdown');
        this.includeSheetNames = options.include_sheet_names ?? true;
        this.includeCellCoordinates = options.include_cell_coordinates ?? false;
        this.includeImage = options.include_image ?? false;
        this.separateSheet = options.separate_sheet ?? false;
        this.tableFormat = options.table_format ?? 'markdown';
    }

    async parse(file: ParserInput, filename: string): Promise<Section[]> {
        const zip = await JSZip.loadAsync(await readBinaryInput(file));
        const workbook = objectParser.parse(await zipText(zip, 'xl/workbook.xml')) as XMLNode;
        const workbookRels = await relationships(zip, 'xl/_rels/workbook.xml.rels');
        const sharedStrings = await this.readSharedStrings(zip);
        const sheetsNode = (workbook.workbook as XMLNode)?.sheets as XMLNode | undefined;
        const rawSheets = sheetsNode?.sheet;
        const sheets = (
            Array.isArray(rawSheets) ? rawSheets : rawSheets ? [rawSheets] : []
        ) as XMLNode[];
        const sections: Section[] = [];
        for (const sheet of sheets) {
            const name = String(sheet['@_name']);
            const relationship = workbookRels.get(String(sheet['@_r:id']));
            if (!relationship) continue;
            const path = archiveTarget('xl/workbook.xml', relationship.target);
            sections.push(...(await this.parseSheet(zip, path, name, filename, sharedStrings)));
        }
        if (this.separateSheet) return sections;
        const text = sections
            .filter(section => section.content.type === 'text')
            .map(section => (section.content.type === 'text' ? section.content.text : ''));
        return [
            ...(text.length
                ? [Section({ content: TextBlock({ text: text.join('\n') }), source: filename })]
                : []),
            ...sections.filter(section => section.content.type !== 'text'),
        ];
    }

    private async readSharedStrings(zip: JSZip): Promise<string[]> {
        const entry = zip.file('xl/sharedStrings.xml');
        if (!entry) return [];
        const parsed = orderedParser.parse(await entry.async('string')) as XMLNode[];
        return findChildren(parsed, 'si').map(node => orderedText([node], new Set(['t'])));
    }

    private async parseSheet(
        zip: JSZip,
        path: string,
        sheet: string,
        filename: string,
        shared: string[]
    ): Promise<Section[]> {
        const parsed = objectParser.parse(await zipText(zip, path)) as XMLNode;
        const worksheet = parsed.worksheet as XMLNode;
        const sheetData = worksheet?.sheetData as XMLNode | undefined;
        const rawRows = sheetData?.row;
        const rows = (Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : []) as XMLNode[];
        const table = rows.map(row => {
            const rawCells = row.c;
            const cells = (
                Array.isArray(rawCells) ? rawCells : rawCells ? [rawCells] : []
            ) as XMLNode[];
            const values: string[] = [];
            for (const cell of cells) {
                const coordinate = String(cell['@_r'] ?? 'A1');
                const column = columnIndex(coordinate);
                while (values.length < column) values.push('');
                values[column] = cellValue(cell, shared).trim().replace(/\r\n?/g, '\n');
            }
            return values;
        });
        if (!table.length || !table.some(row => row.some(Boolean))) return [];
        const text = this.renderExcelTable(table, sheet);
        const sections = [
            Section({
                content: TextBlock({ text }),
                source: filename,
                metadata: { sheet },
            }),
        ];
        if (this.includeImage)
            sections.push(...(await this.sheetImages(zip, path, worksheet, sheet, filename)));
        return sections;
    }

    private renderExcelTable(table: string[][], sheet: string): string {
        const width = Math.max(...table.map(row => row.length));
        const normalized = table.map(row => [...row, ...Array(width - row.length).fill('')]);
        const lines: string[] = this.includeSheetNames ? [`Sheet: ${sheet}`] : [];
        if (this.tableFormat === 'json') {
            lines.push('<system-info>A table loaded as a JSON array:</system-info>');
            normalized.forEach((row, rowIndex) => {
                if (this.includeCellCoordinates) {
                    lines.push(
                        JSON.stringify(
                            Object.fromEntries(
                                row.map((cell, column) => [
                                    `${excelColumn(column)}${rowIndex + 1}`,
                                    cell,
                                ])
                            )
                        )
                    );
                } else lines.push(JSON.stringify(row));
            });
            return lines.join('\n');
        }
        const format = (cell: string, row: number, column: number): string => {
            const escaped = cell.replace(/\|/g, '\\|');
            return this.includeCellCoordinates
                ? `[${excelColumn(column)}${row + 1}] ${escaped}`
                : escaped;
        };
        lines.push(
            `| ${normalized[0].map((cell, column) => format(cell, 0, column)).join(' | ')} |`
        );
        lines.push(`| ${Array(width).fill('---').join(' | ')} |`);
        normalized
            .slice(1)
            .forEach((row, index) =>
                lines.push(
                    `| ${row.map((cell, column) => format(cell, index + 1, column)).join(' | ')} |`
                )
            );
        return `${lines.join('\n')}\n`;
    }

    private async sheetImages(
        zip: JSZip,
        sheetPath: string,
        worksheet: XMLNode,
        sheet: string,
        filename: string
    ): Promise<Section[]> {
        const drawing = worksheet.drawing as XMLNode | undefined;
        if (!drawing?.['@_r:id']) return [];
        const relPath = posix.join(
            posix.dirname(sheetPath),
            '_rels',
            `${posix.basename(sheetPath)}.rels`
        );
        const sheetRels = await relationships(zip, relPath);
        const drawingRel = sheetRels.get(String(drawing['@_r:id']));
        if (!drawingRel) return [];
        const drawingPath = archiveTarget(sheetPath, drawingRel.target);
        const parsed = orderedParser.parse(await zipText(zip, drawingPath)) as XMLNode[];
        const drawingRels = await relationships(
            zip,
            posix.join(posix.dirname(drawingPath), '_rels', `${posix.basename(drawingPath)}.rels`)
        );
        const images: Array<{ row: number; section: Section }> = [];
        for (const anchor of [
            ...findChildren(parsed, 'xdr:oneCellAnchor'),
            ...findChildren(parsed, 'xdr:twoCellAnchor'),
        ]) {
            const ref = findChildren([anchor], 'a:blip')
                .map(node => attributes(node)['@_r:embed'])
                .find(Boolean);
            const relationship = ref ? drawingRels.get(ref) : undefined;
            if (!relationship) continue;
            const block = await imageBlock(
                zip,
                archiveTarget(drawingPath, relationship.target),
                filename
            );
            const row =
                Number(orderedText(findChildren([anchor], 'xdr:row'), new Set(['xdr:row']))) || 0;
            images.push({
                row,
                section: Section({
                    content: block,
                    source: filename,
                    metadata: { sheet, media_type: block.source.media_type },
                }),
            });
        }
        return images.sort((left, right) => left.row - right.row).map(item => item.section);
    }
}

function cellValue(cell: XMLNode, shared: string[]): string {
    const type = String(cell['@_t'] ?? '');
    const raw = cell.v ?? '';
    const value =
        typeof raw === 'object' && raw !== null && '#text' in raw
            ? String((raw as XMLNode)['#text'])
            : String(raw);
    if (type === 's') return shared[Number(value)] ?? '';
    if (type === 'inlineStr') {
        const inline = cell.is as XMLNode | undefined;
        return inline ? objectText(inline) : '';
    }
    return value;
}

function objectText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(objectText).join('');
    if (typeof value === 'object')
        return Object.entries(value as XMLNode)
            .filter(([key]) => key === 't' || !key.startsWith('@_'))
            .map(([, nested]) => objectText(nested))
            .join('');
    return '';
}

function columnIndex(coordinate: string): number {
    const letters = coordinate.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A';
    let value = 0;
    for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
    return value - 1;
}

function excelColumn(index: number): string {
    let value = index + 1;
    let result = '';
    while (value > 0) {
        value--;
        result = String.fromCharCode(65 + (value % 26)) + result;
        value = Math.floor(value / 26);
    }
    return result;
}
