/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

import { AnthropicCredential } from '../credential';
import { createMsg } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolSchema } from '../type';
import { AnthropicChatModel, AnthropicClient } from './anthropic-model';
import { ChatResponse } from './response';

const messages = [createMsg({ name: 'user', role: 'user', content: 'Hello' })];
const tools: ToolSchema[] = [
    {
        type: 'function',
        function: {
            name: 'search',
            description: 'Search',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'weather',
            description: 'Weather',
            parameters: { type: 'object', properties: {} },
        },
    },
];

describe('AnthropicChatModel', () => {
    test('parses text, thinking, redacted thinking, tools and usage', async () => {
        const { model } = createModel({
            id: 'response-1',
            content: [
                { type: 'thinking', thinking: 'Reason', signature: 'signed' },
                { type: 'redacted_thinking', data: 'secret' },
                { type: 'text', text: 'Answer' },
                { type: 'tool_use', id: 'call-1', name: 'search', input: { q: 'agent' } },
            ],
            usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 3,
            },
        });
        const response = (await model.call({ messages })) as ChatResponse;
        expect(response).toMatchObject({
            id: 'response-1',
            isLast: true,
            content: [
                { type: 'thinking', thinking: 'Reason', signature: 'signed' },
                { type: 'thinking', thinking: '', redacted_thinking_data: 'secret' },
                { type: 'text', text: 'Answer' },
                { type: 'tool_call', id: 'call-1', name: 'search', input: '{"q":"agent"}' },
            ],
            usage: {
                inputTokens: 10,
                outputTokens: 5,
                cacheCreationInputTokens: 2,
                cacheInputTokens: 3,
            },
        });
    });

    test('builds modern thinking and nested effort parameters', async () => {
        const { model, bodies } = createModel(
            { content: [], usage: null },
            {
                maxTokens: 100,
                thinkingMode: 'enabled',
                thinkingBudget: 200,
                thinkingDisplay: 'summarized',
                reasoningEffort: 'xhigh',
            }
        );
        await model.call({ messages });
        expect(bodies[0]).toMatchObject({
            model: 'claude-test',
            max_tokens: 1224,
            stream: false,
            thinking: { type: 'enabled', budget_tokens: 200, display: 'summarized' },
            output_config: { effort: 'xhigh' },
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        });
    });

    test('caller options override generated thinking and effort', async () => {
        const { model, bodies } = createModel(
            { content: [] },
            { thinkingMode: 'adaptive', reasoningEffort: 'high' }
        );
        await model.call({
            messages,
            thinking: { type: 'disabled' },
            output_config: { effort: 'low' },
        });
        expect(bodies[0]).toMatchObject({
            thinking: { type: 'disabled' },
            output_config: { effort: 'low' },
        });
    });

    test('formats literal, forced and filtered tool choices', async () => {
        const { model, bodies } = createModel({ content: [] });
        await model.call({
            messages,
            tools,
            toolChoice: new ToolChoice({ mode: 'required', tools: ['weather'] }),
        });
        expect(bodies[0]).toMatchObject({
            tools: [
                {
                    name: 'weather',
                    description: 'Weather',
                    input_schema: { type: 'object', properties: {} },
                },
            ],
            tool_choice: { type: 'any' },
        });

        await model.call({
            messages,
            tools,
            toolChoice: new ToolChoice({ mode: 'search' }),
        });
        expect(bodies[1]).toMatchObject({ tool_choice: { type: 'tool', name: 'search' } });
        expect((bodies[1].tools as unknown[]).length).toBe(2);
    });

    test('accumulates streamed text, thinking signature, tool JSON and final usage', async () => {
        const events = asyncValues([
            {
                type: 'message_start',
                message: { id: 'stream-1', usage: { input_tokens: 7, output_tokens: 0 } },
            },
            {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Why' },
            },
            {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'sig' },
            },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
            {
                type: 'content_block_start',
                index: 2,
                content_block: { type: 'tool_use', id: 'call-1', name: 'search' },
            },
            {
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'input_json_delta', partial_json: '{"q"' },
            },
            {
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'input_json_delta', partial_json: ':"x"}' },
            },
            { type: 'message_delta', usage: { output_tokens: 4 } },
        ]);
        const client: AnthropicClient = { create: async () => events };
        const model = new AnthropicChatModel({
            credential: new AnthropicCredential({ apiKey: 'key' }),
            model: 'claude-test',
            stream: true,
            client,
        });
        const stream = (await model.call({ messages })) as AsyncGenerator<
            ChatResponse,
            ChatResponse
        >;
        const yielded: ChatResponse[] = [];
        let complete: ChatResponse | undefined;
        while (true) {
            const item = await stream.next();
            if (item.done) {
                complete = item.value;
                break;
            }
            yielded.push(item.value);
        }
        expect(yielded.map(item => item.content)).toHaveLength(6);
        expect(complete).toMatchObject({
            id: 'stream-1',
            isLast: true,
            content: [
                { type: 'thinking', thinking: 'Why', signature: 'sig' },
                { type: 'text', text: 'Hi' },
                { type: 'tool_call', id: 'call-1', name: 'search', input: '{"q":"x"}' },
            ],
            usage: { inputTokens: 7, outputTokens: 4 },
        });
    });
});

/**
 *
 * @param response
 * @param parameters
 */
function createModel(
    response: unknown,
    parameters: ConstructorParameters<typeof AnthropicChatModel>[0]['parameters'] = {}
): { model: AnthropicChatModel; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const client: AnthropicClient = {
        create: async body => {
            bodies.push(structuredClone(body));
            return response;
        },
    };
    return {
        model: new AnthropicChatModel({
            credential: new AnthropicCredential({ apiKey: 'key' }),
            model: 'claude-test',
            stream: false,
            parameters,
            client,
        }),
        bodies,
    };
}

/**
 *
 * @param values
 */
async function* asyncValues(
    values: Record<string, unknown>[]
): AsyncGenerator<Record<string, unknown>> {
    for (const value of values) yield value;
}
