/* eslint-disable jsdoc/require-jsdoc */

import { OpenAICredential } from '../credential';
import { createMsg } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolSchema } from '../type';
import type { OpenAICompatibleClient } from './openai-compatible';
import { OpenAIChatModel } from './openai-model';
import { ChatResponse } from './response';

const messages = [createMsg({ name: 'user', role: 'user', content: 'Hello' })];
const tools: ToolSchema[] = [
    {
        type: 'function',
        function: {
            name: 'search',
            description: 'Search',
            parameters: {
                $defs: { Query: { type: 'string' } },
                type: 'object',
                properties: { query: { $ref: '#/$defs/Query' } },
            },
        },
    },
    {
        type: 'function',
        function: { name: 'weather', description: 'Weather', parameters: { type: 'object' } },
    },
];

describe('OpenAIChatModel', () => {
    test('builds parameters, flattened filtered tools and extra body', async () => {
        const { model, bodies } = createModel(
            { choices: [] },
            {
                maxTokens: 100,
                thinkingEnable: true,
                reasoningEffort: 'high',
                temperature: 0.2,
                topP: 0.9,
                parallelToolCalls: false,
            },
            { custom: 'constructor' }
        );
        await model.call({
            messages,
            tools,
            toolChoice: new ToolChoice({ mode: 'required', tools: ['search'] }),
            extra_body: { custom: 'caller' },
        });

        expect(bodies[0]).toMatchObject({
            model: 'gpt-test',
            stream: false,
            max_completion_tokens: 100,
            reasoning_effort: 'high',
            temperature: 0.2,
            top_p: 0.9,
            parallel_tool_calls: false,
            tool_choice: 'required',
            extra_body: { custom: 'caller' },
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'search',
                        parameters: {
                            type: 'object',
                            properties: { query: { type: 'string' } },
                        },
                    },
                },
            ],
        });
    });

    test('parses reasoning, transcript, audio, tools and cached usage', async () => {
        const { model } = createModel(
            {
                id: 'response-1',
                choices: [
                    {
                        message: {
                            reasoning: 'Think',
                            audio: { transcript: 'Spoken', data: 'YXVkaW8=' },
                            tool_calls: [
                                {
                                    id: 'call-1',
                                    function: { name: 'search', arguments: '{"q":"x"}' },
                                },
                            ],
                        },
                    },
                ],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 4,
                    prompt_tokens_details: { cached_tokens: 3 },
                },
            },
            { voice: 'alloy' }
        );
        const response = (await model.call({ messages })) as ChatResponse;
        expect(response).toMatchObject({
            id: 'response-1',
            content: [
                { type: 'thinking', thinking: 'Think' },
                { type: 'text', text: 'Spoken' },
                { type: 'data', source: { data: 'YXVkaW8=', media_type: 'audio/pcm16' } },
                { type: 'tool_call', id: 'call-1', name: 'search', input: '{"q":"x"}' },
            ],
            usage: { inputTokens: 10, outputTokens: 4, cacheInputTokens: 3 },
        });
    });
});

function createModel(
    response: unknown,
    parameters: ConstructorParameters<typeof OpenAIChatModel>[0]['parameters'] = {},
    extraBody?: Record<string, unknown>
): { model: OpenAIChatModel; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const client: OpenAICompatibleClient = {
        create: async body => {
            bodies.push(structuredClone(body));
            return response;
        },
    };
    return {
        model: new OpenAIChatModel({
            credential: new OpenAICredential({ apiKey: 'key' }),
            model: 'gpt-test',
            parameters,
            extraBody,
            stream: false,
            client,
        }),
        bodies,
    };
}
