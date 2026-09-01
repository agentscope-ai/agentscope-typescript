/* eslint-disable jsdoc/require-jsdoc */

import { OpenAICredential } from '../credential';
import { createMsg } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolSchema } from '../type';
import type { OpenAICompatibleClient } from './openai-compatible';
import { OpenAIResponseModel } from './openai-response-model';
import { ChatResponse } from './response';

const messages = [createMsg({ name: 'user', role: 'user', content: 'Hello' })];
const tools: ToolSchema[] = [
    {
        type: 'function',
        function: { name: 'search', description: 'Search', parameters: { type: 'object' } },
    },
    {
        type: 'function',
        function: { name: 'weather', description: 'Weather', parameters: { type: 'object' } },
    },
];

describe('OpenAIResponseModel', () => {
    test('builds Responses parameters, strips audio and uses allowed tools', async () => {
        const { model, bodies } = createModel({ output: [] }, false, {
            maxTokens: 100,
            thinkingEnable: true,
            reasoningEffort: 'high',
            temperature: 0.4,
        });
        await model.call({
            messages,
            tools,
            toolChoice: new ToolChoice({ mode: 'required', tools: ['search'] }),
            modalities: ['audio'],
            audio: { voice: 'alloy' },
        });
        expect(bodies[0]).toMatchObject({
            model: 'o4-test',
            stream: false,
            max_output_tokens: 100,
            temperature: 0.4,
            reasoning: { effort: 'high' },
            tools: [
                { type: 'function', name: 'search' },
                { type: 'function', name: 'weather' },
            ],
            tool_choice: {
                type: 'allowed_tools',
                mode: 'required',
                tools: [{ type: 'function', name: 'search' }],
            },
        });
        expect(bodies[0]).not.toHaveProperty('modalities');
        expect(bodies[0]).not.toHaveProperty('audio');
    });

    test('parses reasoning raw item, text, function calls and usage', async () => {
        const { model } = createModel({
            id: 'response-1',
            output: [
                {
                    id: 'reasoning-1',
                    type: 'reasoning',
                    status: null,
                    summary: [{ type: 'summary_text', text: 'First' }, { text: 'Second' }],
                },
                { type: 'message', content: [{ type: 'output_text', text: 'Answer' }] },
                {
                    type: 'function_call',
                    call_id: 'call-1',
                    name: 'search',
                    arguments: '{"q":"x"}',
                },
            ],
            usage: {
                input_tokens: 9,
                output_tokens: 4,
                input_tokens_details: { cached_tokens: 2 },
            },
        });
        const response = (await model.call({ messages })) as ChatResponse;
        expect(response).toMatchObject({
            id: 'response-1',
            content: [
                {
                    type: 'thinking',
                    thinking: 'First Second',
                    reasoning_item_id: 'reasoning-1',
                    reasoning_item_raw: {
                        id: 'reasoning-1',
                        type: 'reasoning',
                        summary: [{ type: 'summary_text', text: 'First' }, { text: 'Second' }],
                    },
                },
                { type: 'text', text: 'Answer' },
                { type: 'tool_call', id: 'call-1', name: 'search', input: '{"q":"x"}' },
            ],
            usage: { inputTokens: 9, outputTokens: 4, cacheInputTokens: 2 },
        });
    });

    test('streams reasoning, text, function arguments and completed metadata', async () => {
        const events = asyncValues([
            {
                type: 'response.reasoning_summary_text.delta',
                item_id: 'reasoning-1',
                delta: 'Think',
            },
            { type: 'response.output_text.delta', delta: 'Answer' },
            {
                type: 'response.output_item.added',
                item: {
                    type: 'function_call',
                    id: 'function-1',
                    call_id: 'call-1',
                    name: 'search',
                },
            },
            {
                type: 'response.function_call_arguments.delta',
                item_id: 'function-1',
                delta: '{"q":"x"}',
            },
            {
                type: 'response.completed',
                response: {
                    output: [
                        { id: 'reasoning-1', type: 'reasoning', summary: [{ text: 'Think' }] },
                    ],
                    usage: { input_tokens: 5, output_tokens: 3 },
                },
            },
        ]);
        const { model } = createModel(events, true);
        const stream = (await model.call({ messages })) as AsyncGenerator<
            ChatResponse,
            ChatResponse
        >;
        let complete: ChatResponse | undefined;
        while (true) {
            const item = await stream.next();
            if (item.done) {
                complete = item.value;
                break;
            }
        }
        expect(complete).toMatchObject({
            content: [
                {
                    type: 'thinking',
                    thinking: 'Think',
                    reasoning_item_id: 'reasoning-1',
                },
                { type: 'text', text: 'Answer' },
                { type: 'tool_call', id: 'call-1', name: 'search', input: '{"q":"x"}' },
            ],
            usage: { inputTokens: 5, outputTokens: 3 },
        });
    });
});

function createModel(
    response: unknown,
    stream = false,
    parameters: ConstructorParameters<typeof OpenAIResponseModel>[0]['parameters'] = {}
): { model: OpenAIResponseModel; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const client: OpenAICompatibleClient = {
        create: async body => {
            bodies.push(structuredClone(body));
            return response;
        },
    };
    return {
        model: new OpenAIResponseModel({
            credential: new OpenAICredential({ apiKey: 'key' }),
            model: 'o4-test',
            parameters,
            stream,
            client,
        }),
        bodies,
    };
}

function asyncValues(values: unknown[]): AsyncIterable<Record<string, unknown>> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const value of values) yield value as Record<string, unknown>;
        },
    };
}
