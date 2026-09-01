/* eslint-disable jsdoc/require-jsdoc */

import { Parser } from 'tar';

export function createSingleFileTar(name: string, data: Uint8Array): Buffer {
    if (!name || Buffer.byteLength(name) > 100 || name.includes('/') || name.includes('\\')) {
        throw new Error(`Invalid tar entry name: ${JSON.stringify(name)}`);
    }
    const body = Buffer.from(data);
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    writeString(header, 257, 6, 'ustar');
    writeString(header, 263, 2, '00');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    writeChecksum(header, checksum);
    const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
    return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

export async function readFirstFileFromTar(archive: Uint8Array): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        let content: Buffer | null = null;
        const parser = new Parser({
            onReadEntry(entry): void {
                if (
                    content !== null ||
                    !['File', 'OldFile', 'ContiguousFile'].includes(entry.type)
                ) {
                    entry.resume();
                    return;
                }
                const chunks: Buffer[] = [];
                entry.on('data', chunk => chunks.push(Buffer.from(chunk)));
                entry.on('end', () => {
                    content = Buffer.concat(chunks);
                });
            },
        });
        parser.once('error', reject);
        parser.once('end', () => resolve(content));
        parser.end(Buffer.from(archive));
    });
}

function writeString(target: Buffer, offset: number, length: number, value: string): void {
    target.write(value, offset, length, 'utf8');
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
    const encoded = value
        .toString(8)
        .padStart(length - 1, '0')
        .concat('\0');
    target.write(encoded, offset, length, 'ascii');
}

function writeChecksum(target: Buffer, value: number): void {
    const encoded = value.toString(8).padStart(6, '0').concat('\0 ');
    target.write(encoded, 148, 8, 'ascii');
}
