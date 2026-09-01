import { EmbeddingModelCard, ModelCard, TTSModelCard } from './card';
import { listModelCards, listRawModelCards } from './card-registry';

const BASE_SCHEMA = {
    type: 'object',
    properties: {
        max_tokens: { type: 'integer', minimum: 1 },
        thinking_enable: { type: 'boolean' },
        thinking_budget: { type: 'integer' },
        thinking_mode: { type: ['string', 'null'] },
        thinking_display: { type: ['string', 'null'] },
        voice: { type: 'string' },
        removable: { type: 'string' },
    },
    required: ['max_tokens', 'voice', 'removable'],
};

describe('model cards', () => {
    test('bundles every Python YAML card with stable kind counts', () => {
        const records = listRawModelCards();
        expect(records).toHaveLength(104);
        expect(new Set(records.map(record => record.sourcePath)).size).toBe(104);
        expect(listRawModelCards({ kind: 'chat' })).toHaveLength(84);
        expect(listRawModelCards({ kind: 'embedding' })).toHaveLength(11);
        expect(listRawModelCards({ kind: 'tts' })).toHaveLength(9);
        expect(listRawModelCards({ kind: 'chat', provider: 'anthropic' })).toHaveLength(10);
        expect(listRawModelCards({ kind: 'tts', provider: 'dashscope' })).toHaveLength(4);
    });

    test('validates every generated card', () => {
        const cards = listModelCards();
        expect(cards).toHaveLength(104);
        expect(cards.every(card => card.name.length > 0 && card.label.length > 0)).toBe(true);
        expect(cards.filter(card => card.type === 'chat_model')).toHaveLength(84);
        expect(cards.filter(card => card.type === 'embedding_model')).toHaveLength(11);
        expect(cards.filter(card => card.type === 'tts_model')).toHaveLength(9);
    });

    test('merges chat parameter overrides and capability filters like Python', () => {
        const card = new ModelCard(
            {
                name: 'text-only',
                label: 'Text Only',
                context_size: 100,
                output_size: 20,
                parameter_overrides: {
                    max_tokens: { minimum: 2 },
                    removable: { hidden: true },
                },
            },
            BASE_SCHEMA
        );
        expect(card.toJSON()).toEqual({
            type: 'chat_model',
            name: 'text-only',
            label: 'Text Only',
            status: 'active',
            deprecated_at: null,
            input_types: ['text/plain'],
            output_types: ['text/plain'],
            context_size: 100,
            output_size: 20,
            parameter_schema: {
                type: 'object',
                properties: {
                    max_tokens: { type: 'integer', minimum: 2, maximum: 20 },
                },
                required: ['max_tokens', 'voice', 'removable'],
            },
            parameters_overrides: {
                max_tokens: { minimum: 2 },
                removable: { hidden: true },
            },
        });
    });

    test('requires embedding dimensions and preserves supported dimensions', () => {
        expect(() => new EmbeddingModelCard({ name: 'bad', label: 'Bad' }, BASE_SCHEMA)).toThrow(
            "field 'dimensions' must be a positive integer"
        );
        const card = new EmbeddingModelCard(
            {
                name: 'embed',
                label: 'Embed',
                dimensions: 1024,
                supported_dimensions: [1024, 512],
            },
            BASE_SCHEMA
        );
        expect(card.dimensions).toBe(1024);
        expect(card.supportedDimensions).toEqual([1024, 512]);
    });

    test('injects TTS voices and removes hidden required fields', () => {
        const card = new TTSModelCard(
            {
                name: 'speech',
                label: 'Speech',
                voices: ['alloy', 'nova'],
                parameter_overrides: { removable: { hidden: true } },
            },
            BASE_SCHEMA
        );
        expect(card.parameterSchema).toEqual({
            type: 'object',
            properties: {
                max_tokens: { type: 'integer', minimum: 1 },
                thinking_enable: { type: 'boolean' },
                thinking_budget: { type: 'integer' },
                thinking_mode: { type: ['string', 'null'] },
                thinking_display: { type: ['string', 'null'] },
                voice: { type: 'string', default: 'alloy', enum: ['alloy', 'nova'] },
            },
            required: ['max_tokens', 'voice'],
        });
    });
});
