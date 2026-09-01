/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

import type { ContentBlock, DataBlock } from '../../message';

const VALID_MODALITIES = new Set(['image', 'audio', 'video']);

/**
 * Convert an AgentScope content block to an OTel GenAI message part.
 * @param block
 */
export function convertBlockToPart(block: ContentBlock): Record<string, unknown> | null {
    if (block.type === 'text') return { type: 'text', content: block.text };
    if (block.type === 'thinking') return { type: 'reasoning', content: block.thinking };
    if (block.type === 'tool_call') {
        let args: unknown = block.input;
        try {
            args = JSON.parse(block.input);
        } catch {
            // Keep malformed model output verbatim.
        }
        return { type: 'tool_call', id: block.id, name: block.name, arguments: args };
    }
    if (block.type === 'tool_result') {
        return {
            type: 'tool_call_response',
            id: block.id,
            response:
                typeof block.output === 'string' ? block.output : serializeToString(block.output),
        };
    }
    if (block.type === 'data') return convertMediaBlock(block);
    return null;
}

/**
 * Serialize tracing values without allowing instrumentation to fail the request.
 * @param value
 */
export function serializeToString(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify(toSerializable(value));
    }
}

/**
 *
 * @param block
 */
function convertMediaBlock(block: DataBlock): Record<string, unknown> {
    const prefix = block.source.media_type.split('/')[0];
    const modality = VALID_MODALITIES.has(prefix) ? prefix : 'unknown';
    if (block.source.type === 'url') {
        return { type: 'uri', uri: block.source.url, modality };
    }
    return {
        type: 'blob',
        content: block.source.data,
        media_type: block.source.media_type,
        modality,
    };
}

/**
 *
 * @param value
 */
function toSerializable(value: unknown): unknown {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.map(toSerializable);
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
                key,
                toSerializable(item),
            ])
        );
    }
    return String(value);
}
