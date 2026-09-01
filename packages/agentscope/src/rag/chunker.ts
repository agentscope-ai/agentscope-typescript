/* eslint-disable jsdoc/require-jsdoc */

import { TextBlock } from '../message';
import type { DataBlock } from '../message';
import type { Chunk, Section } from './document';

/** Base contract for reusable, format-independent RAG chunkers. */
export abstract class ChunkerBase<TParameters extends object = Record<string, never>> {
    abstract readonly chunkerType: string;
    readonly parameters: TParameters;

    protected constructor(parameters: TParameters) {
        this.parameters = parameters;
    }

    abstract chunk(sections: Section[]): Promise<Chunk[]>;
}

export interface ApproxTokenChunkerParameters {
    chunk_size?: number;
    overlap?: number;
}

/** Split text using Python's UTF-8-byte approximate-token strategy. */
export class ApproxTokenChunker extends ChunkerBase<Required<ApproxTokenChunkerParameters>> {
    readonly chunkerType = 'approx_token';

    constructor(parameters: ApproxTokenChunkerParameters = {}) {
        const chunkSize = parameters.chunk_size ?? 512;
        const overlap = parameters.overlap ?? 50;
        if (!Number.isInteger(chunkSize) || chunkSize < 1) {
            throw new Error('chunk_size must be greater than or equal to 1.');
        }
        if (!Number.isInteger(overlap) || overlap < 0) {
            throw new Error('overlap must be greater than or equal to 0.');
        }
        if (overlap >= chunkSize) {
            throw new Error(
                `overlap must be less than chunk_size, got overlap=${overlap}, chunk_size=${chunkSize}.`
            );
        }
        super({ chunk_size: chunkSize, overlap });
    }

    get chunkSize(): number {
        return this.parameters.chunk_size;
    }

    get chunk_size(): number {
        return this.parameters.chunk_size;
    }

    get overlap(): number {
        return this.parameters.overlap;
    }

    async chunk(sections: Section[]): Promise<Chunk[]> {
        const chunks: Chunk[] = [];
        for (const section of sections) {
            const contents: Array<ReturnType<typeof TextBlock> | DataBlock> =
                section.content.type === 'text'
                    ? this.splitText(section.content.text).map(text => TextBlock({ text }))
                    : [section.content];
            for (const content of contents) {
                chunks.push({
                    content,
                    source: section.source,
                    chunk_index: 0,
                    total_chunks: 0,
                    metadata: { ...section.metadata },
                });
            }
        }
        for (const [index, chunk] of chunks.entries()) {
            chunk.chunk_index = index;
            chunk.total_chunks = chunks.length;
        }
        return chunks;
    }

    splitText(text: string): string[] {
        if (ApproxTokenChunker.approxCountTokens(text) <= this.chunkSize) return [text];

        const characters = [...text];
        const byteOffsets = [0];
        for (const character of characters) {
            byteOffsets.push(byteOffsets.at(-1)! + Buffer.byteLength(character, 'utf8'));
        }

        const chunkBytes = this.chunkSize * 4;
        const overlapBytes = this.overlap * 4;
        const pieces: string[] = [];
        let start = 0;
        while (start < characters.length) {
            let end = upperBound(byteOffsets, byteOffsets[start] + chunkBytes) - 1;
            end = Math.max(end, start + 1);
            pieces.push(characters.slice(start, end).join(''));
            if (end >= characters.length) break;
            const nextStart = upperBound(byteOffsets, byteOffsets[end] - overlapBytes) - 1;
            start = Math.max(nextStart, start + 1);
        }
        return pieces;
    }

    static approxCountTokens(text: string): number {
        return Math.floor(Buffer.byteLength(text, 'utf8') / 4);
    }
}

function upperBound(values: number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (values[middle] <= target) low = middle + 1;
        else high = middle;
    }
    return low;
}
