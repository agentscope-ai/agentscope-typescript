/* eslint-disable jsdoc/require-jsdoc */

import { EventType, type AgentEvent } from '../event';
import { getTextContent, type Msg } from '../message';

export function extractMem0QueryText(
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

export function mem0ExtractedAnything(raw: unknown): boolean {
    if (Array.isArray(raw)) return raw.length > 0;
    if (!raw || typeof raw !== 'object') return false;
    const results = (raw as { results?: unknown }).results;
    return Array.isArray(results) && results.length > 0;
}

export function extractMem0MemoryTexts(raw: unknown): string[] {
    if (raw == null) return [];
    const results =
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as { results?: unknown }).results
            : raw;
    if (!Array.isArray(results)) return [];
    return results.flatMap(item => {
        if (typeof item === 'string') return [item];
        if (!item || typeof item !== 'object') return [];
        const value =
            (item as { memory?: unknown; text?: unknown }).memory ??
            (item as { text?: unknown }).text;
        return value ? [String(value)] : [];
    });
}

export function isMem0Message(value: unknown): value is Msg {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<Msg>;
    return (
        typeof candidate.name === 'string' &&
        (candidate.role === 'user' ||
            candidate.role === 'assistant' ||
            candidate.role === 'system') &&
        Array.isArray(candidate.content)
    );
}

function isResumptionEvent(value: unknown): boolean {
    if (!value || typeof value !== 'object' || !('type' in value)) return false;
    const type = (value as { type?: unknown }).type;
    return type === EventType.USER_CONFIRM_RESULT || type === EventType.EXTERNAL_EXECUTION_RESULT;
}

function isMessage(value: unknown): value is Msg {
    return isMem0Message(value);
}
