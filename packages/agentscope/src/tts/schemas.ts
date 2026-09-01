/* eslint-disable jsdoc/require-jsdoc */

import type { JSONSchema } from '../model/card';

export const DASHSCOPE_TTS_PARAMETER_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        voice: {
            type: 'string',
            default: 'Cherry',
            title: 'Voice',
            description: 'The voice to use for synthesis.',
        },
    },
    required: [],
};

export const COSYVOICE_TTS_PARAMETER_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        voice: {
            type: 'string',
            default: 'longanhuan',
            title: 'Voice',
            description: 'The voice to use for synthesis.',
        },
        realtime: {
            type: 'boolean',
            default: false,
            title: 'Realtime',
            description: 'Whether to enable streaming input mode.',
        },
    },
    required: [],
};

export const GEMINI_TTS_PARAMETER_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        voice: {
            type: 'string',
            default: 'Kore',
            title: 'Voice',
            description: 'The voice to use for synthesis.',
        },
    },
    required: [],
};

export const OPENAI_TTS_PARAMETER_SCHEMA: JSONSchema = {
    type: 'object',
    properties: {
        voice: {
            type: 'string',
            default: 'alloy',
            title: 'Voice',
            description: 'The voice to use for synthesis.',
        },
        response_format: {
            type: 'string',
            default: 'mp3',
            enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
            title: 'Response Format',
            description: 'The audio format of the synthesized speech.',
        },
        instructions: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            default: null,
            title: 'Instructions',
            description:
                'Additional instructions for controlling the voice (only supported by some models, e.g. gpt-4o-mini-tts).',
        },
    },
    required: [],
};

export function ttsParameterSchema(provider: string, model: string): JSONSchema {
    if (provider === 'openai') return OPENAI_TTS_PARAMETER_SCHEMA;
    if (provider === 'gemini') return GEMINI_TTS_PARAMETER_SCHEMA;
    if (provider === 'dashscope' && model.startsWith('cosyvoice-')) {
        return COSYVOICE_TTS_PARAMETER_SCHEMA;
    }
    if (provider === 'dashscope') return DASHSCOPE_TTS_PARAMETER_SCHEMA;
    return { type: 'object', properties: {}, required: [] };
}

export function ttsModelOrder(provider: string, model: string): number {
    const order: Record<string, string[]> = {
        dashscope: [
            'qwen3-tts-flash',
            'qwen3-tts-flash-realtime',
            'cosyvoice-v3-flash',
            'cosyvoice-v3-plus',
        ],
        gemini: ['gemini-2.5-pro-preview-tts', 'gemini-2.5-flash-preview-tts'],
        openai: ['tts-1-hd', 'gpt-4o-mini-tts', 'tts-1'],
    };
    const index = order[provider]?.indexOf(model) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
