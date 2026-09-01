/* eslint-disable jsdoc/require-jsdoc */

import { EventType, type AgentEvent } from '../event';
import { getTextContent, type Msg } from '../message';

export function extractReMeQueryText(
    inputs: Msg | Msg[] | AgentEvent | null | undefined
): string | null {
    if (inputs == null || isResumptionEvent(inputs)) return null;
    const values = Array.isArray(inputs) ? inputs : [inputs];
    const texts = values.flatMap(value => {
        if (!isMessage(value) || value.role !== 'user') return [];
        const text = getTextContent(value);
        return text ? [text] : [];
    });
    return texts.length ? texts.join('\n') : null;
}

export function extractReMeMemoryTexts(raw: unknown): string[] {
    if (raw == null) return [];
    let results: unknown = raw;
    if (isRecord(raw)) {
        const metadata = raw.metadata;
        results =
            isRecord(metadata) && 'results' in metadata ? metadata.results : (raw.results ?? raw);
    }
    if (!Array.isArray(results)) return [];
    return results.flatMap(item => {
        if (typeof item === 'string') return [item];
        if (!isRecord(item)) return [];
        const text = item.text || item.memory || item.content;
        return text ? [String(text)] : [];
    });
}

export function isReMeMessage(value: unknown): value is Msg {
    if (!isRecord(value)) return false;
    return (
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
        Array.isArray(value.content)
    );
}

function isResumptionEvent(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return (
        value.type === EventType.USER_CONFIRM_RESULT ||
        value.type === EventType.EXTERNAL_EXECUTION_RESULT
    );
}

function isMessage(value: unknown): value is Msg {
    return isReMeMessage(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
