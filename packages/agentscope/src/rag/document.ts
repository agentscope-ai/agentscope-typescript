/* eslint-disable jsdoc/require-returns */

import type { DataBlock, TextBlock } from '../message';

/** A natural parser boundary that chunkers must not cross. */
export interface Section {
    content: TextBlock | DataBlock;
    source: string;
    metadata: Record<string, unknown>;
}

/** A final indexable unit produced from one section. */
export interface Chunk {
    content: TextBlock | DataBlock;
    source: string;
    chunk_index: number;
    total_chunks: number;
    metadata: Record<string, unknown>;
}

/**
 * Create a section with Python-compatible metadata defaults.
 * @param input
 */
export function Section(
    input: Omit<Section, 'metadata'> & Partial<Pick<Section, 'metadata'>>
): Section {
    return {
        content: input.content,
        source: input.source,
        metadata: { ...(input.metadata ?? {}) },
    };
}

/**
 * Create a chunk with Python-compatible metadata defaults.
 * @param input
 */
export function Chunk(input: Omit<Chunk, 'metadata'> & Partial<Pick<Chunk, 'metadata'>>): Chunk {
    return {
        content: input.content,
        source: input.source,
        chunk_index: input.chunk_index,
        total_chunks: input.total_chunks,
        metadata: { ...(input.metadata ?? {}) },
    };
}
