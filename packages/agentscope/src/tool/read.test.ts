import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { PDFDocument } from 'pdf-lib';

import { PermissionBehavior } from '../permission';
import { AgentState } from '../state';
import { Read, ReadTool } from './read';
import { ToolChunk } from './response';

describe('Read', () => {
    let temporaryDirectory: string;
    let read: ReadTool;

    beforeEach(async () => {
        read = Read();
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'read-test-'));
    });

    afterEach(async () => {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    const getText = (response: ToolChunk): string => {
        const block = response.content.find(value => value.type === 'text');
        return block?.type === 'text' ? block.text : '';
    };

    test('reads text with line numbers, normalized newlines, offset, and limit', async () => {
        const filePath = path.join(temporaryDirectory, 'test.txt');
        await fs.writeFile(filePath, 'a\r\nb\rc\nd');
        const response = await read.call({ file_path: filePath, offset: 2, limit: 2 });
        expect(response.state).toBe('running');
        expect(getText(response)).toBe('     2\tb\n     3\tc');
    });

    test('returns Python-compatible input errors', async () => {
        expect(getText(await read.call({ file_path: 'relative.txt' }))).toBe(
            'Error: file_path must be an absolute path, got: relative.txt'
        );
        const missing = path.join(temporaryDirectory, 'missing.txt');
        expect(getText(await read.call({ file_path: missing }))).toBe(
            `Error: File does not exist: ${missing}`
        );
        expect(getText(await read.call({ file_path: temporaryDirectory }))).toBe(
            `Error: Path is a directory, not a file: ${temporaryDirectory}`
        );
    });

    test('returns empty text and truncates long lines', async () => {
        const empty = path.join(temporaryDirectory, 'empty.txt');
        await fs.writeFile(empty, '');
        expect(getText(await read.call({ file_path: empty }))).toBe('');
        const long = path.join(temporaryDirectory, 'long.txt');
        await fs.writeFile(long, 'x'.repeat(2100));
        expect(getText(await read.call({ file_path: long })).endsWith('[truncated]')).toBe(true);
    });

    test('reads supported images as base64 data and rejects unsupported images', async () => {
        const image = path.join(temporaryDirectory, 'image.png');
        await fs.writeFile(image, Buffer.from([1, 2, 3]));
        expect((await read.call({ file_path: image })).content[0]).toMatchObject({
            type: 'data',
            name: 'image.png',
            source: { type: 'base64', data: 'AQID', media_type: 'image/png' },
        });
        const unsupported = Read({ modelInputTypes: [] });
        expect(getText(await unsupported.call({ file_path: image }))).toContain(
            'Unsupported image type image/png'
        );
    });

    test('returns native PDF data and enforces page limits', async () => {
        const pdfPath = path.join(temporaryDirectory, 'document.pdf');
        const document = await PDFDocument.create();
        for (let index = 0; index < 11; index += 1) document.addPage();
        await fs.writeFile(pdfPath, await document.save());

        const nativeReader = Read({ modelInputTypes: ['application/pdf'] });
        expect(getText(await nativeReader.call({ file_path: pdfPath }))).toContain(
            'must provide the pages parameter'
        );
        const selected = await nativeReader.call({ file_path: pdfPath, pages: '2-3' });
        expect(selected.content[0]).toMatchObject({
            type: 'data',
            source: { media_type: 'application/pdf' },
        });
        const selectedDocument = await PDFDocument.load(
            Buffer.from(
                selected.content[0].type === 'data' && selected.content[0].source.type === 'base64'
                    ? selected.content[0].source.data
                    : '',
                'base64'
            )
        );
        expect(selectedDocument.getPageCount()).toBe(2);
    });

    test('uses state cache and exposes permission hooks', async () => {
        const filePath = path.join(temporaryDirectory, 'cached.txt');
        await fs.writeFile(filePath, 'cached');
        const state = new AgentState();
        await read.call({ file_path: filePath, _agent_state: state });
        expect(state.toolContext.readFileCache).toHaveLength(1);
        expect((await read.checkPermissions()).behavior).toBe(PermissionBehavior.PASSTHROUGH);
        expect(await read.matchRule(`${temporaryDirectory}/**`, { file_path: filePath })).toBe(
            true
        );
        expect(await read.generateSuggestions({ file_path: filePath })).toEqual([
            {
                tool_name: 'Read',
                rule_content: `${temporaryDirectory}/**`,
                behavior: PermissionBehavior.ALLOW,
                source: 'suggested',
            },
        ]);
    });
});
