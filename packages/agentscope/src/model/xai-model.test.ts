/* eslint-disable jsdoc/require-jsdoc */

import { XAICredential } from '../credential';
import { createMsg } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolSchema } from '../type';
import { ChatResponse } from './response';
import { XAIChatModel, XAIClient } from './xai-model';

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

describe('XAIChatModel', () => {
    test('builds typed tools, forced choice and reasoning parameters', async () => {
        const { model, bodies } = createModel(
            {
                id: 'response-1',
                content: '',
                tool_calls: [],
            },
            false,
            { maxTokens: 100, thinkingEnable: true, reasoningEffort: 'high', topP: 0.8 }
        );
        await model.call({
            messages,
            tools,
            toolChoice: new ToolChoice({ mode: 'search', tools: ['search'] }),
            serverTools: [{ type: 'web_search', enable_image_search: true }],
        });
        expect(bodies[0]).toMatchObject({
            model: 'grok-test',
            max_tokens: 100,
            reasoning_effort: 'high',
            top_p: 0.8,
            tools: [
                {
                    type: 'client_side_tool',
                    function: {
                        name: 'search',
                        description: 'Search',
                        parameters: { type: 'object' },
                    },
                },
                { type: 'web_search', enable_image_search: true },
            ],
            tool_choice: { type: 'required_tool', name: 'search' },
        });
    });

    test('parses reasoning, text, tools and reasoning-inclusive usage', async () => {
        const { model } = createModel({
            id: 'response-1',
            reasoning_content: 'Think',
            content: 'Answer',
            tool_calls: [{ id: 'call-1', function: { name: 'search', arguments: '{"q":"x"}' } }],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 4,
                reasoning_tokens: 3,
                cached_prompt_text_tokens: 2,
            },
        });
        const response = (await model.call({ messages })) as ChatResponse;
        expect(response).toMatchObject({
            id: 'response-1',
            content: [
                { type: 'thinking', thinking: 'Think' },
                { type: 'text', text: 'Answer' },
                { type: 'tool_call', id: 'call-1', name: 'search', input: '{"q":"x"}' },
            ],
            usage: { inputTokens: 10, outputTokens: 7, cacheInputTokens: 2 },
        });
    });

    test('streams deltas then carries final tools and usage and closes', async () => {
        const response = {
            id: 'response-1',
            tool_calls: [{ id: 'call-1', function: { name: 'search', arguments: '{"q":"x"}' } }],
            usage: { prompt_tokens: 8, completion_tokens: 3, reasoning_tokens: 2 },
        };
        const values = asyncValues([
            { response, chunk: { reasoning_content: 'Think' } },
            { response, chunk: { content: 'Answer' } },
        ]);
        const { model, close } = createModel(values, true);
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
            id: 'response-1',
            content: [
                { type: 'thinking', thinking: 'Think' },
                { type: 'text', text: 'Answer' },
                { type: 'tool_call', id: 'call-1', name: 'search', input: '{"q":"x"}' },
            ],
            usage: { inputTokens: 8, outputTokens: 5 },
        });
        expect(close).toHaveBeenCalledTimes(1);
    });
});

function createModel(
    response: unknown,
    stream = false,
    parameters: ConstructorParameters<typeof XAIChatModel>[0]['parameters'] = {}
): {
    model: XAIChatModel;
    bodies: Record<string, unknown>[];
    close: jest.Mock<Promise<void>, []>;
} {
    const bodies: Record<string, unknown>[] = [];
    const close = jest.fn(async () => undefined);
    const client: XAIClient = {
        create: async body => {
            bodies.push(structuredClone(body));
            return response;
        },
        close,
    };
    return {
        model: new XAIChatModel({
            credential: new XAICredential({ apiKey: 'key' }),
            model: 'grok-test',
            parameters,
            stream,
            client,
        }),
        bodies,
        close,
    };
}

function asyncValues(values: unknown[]): AsyncIterable<Record<string, unknown>> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const value of values) yield value as Record<string, unknown>;
        },
    };
}
