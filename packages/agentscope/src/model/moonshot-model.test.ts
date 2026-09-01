/* eslint-disable jsdoc/require-jsdoc */

import { MoonshotCredential } from '../credential';
import { createMsg } from '../message';
import { MoonshotChatModel } from './moonshot-model';
import type { OpenAICompatibleClient } from './openai-compatible';

const messages = [createMsg({ name: 'user', role: 'user', content: 'Hello' })];

describe('MoonshotChatModel', () => {
    test('uses Kimi K3 completion and reasoning parameter names', async () => {
        const { model, bodies } = createModel('kimi-k3', {
            maxTokens: 200,
            reasoningEffort: 'max',
            thinkingEnable: true,
        });
        await model.call({ messages });
        expect(bodies[0]).toMatchObject({
            max_completion_tokens: 200,
            reasoning_effort: 'max',
        });
        expect(bodies[0]).not.toHaveProperty('extra_body');
    });

    test('uses thinking extra body for non-K3 models and preserves overrides', async () => {
        const { model, bodies } = createModel('kimi-k2.6', {
            maxTokens: 200,
            thinkingEnable: true,
        });
        await model.call({
            messages,
            extra_body: { thinking: { type: 'disabled' } },
        });
        expect(bodies[0]).toMatchObject({
            max_tokens: 200,
            extra_body: { thinking: { type: 'disabled' } },
        });
    });
});

function createModel(
    modelName: string,
    parameters: ConstructorParameters<typeof MoonshotChatModel>[0]['parameters']
): { model: MoonshotChatModel; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const client: OpenAICompatibleClient = {
        create: async body => {
            bodies.push(structuredClone(body));
            return { choices: [] };
        },
    };
    return {
        model: new MoonshotChatModel({
            credential: new MoonshotCredential({ apiKey: 'key' }),
            model: modelName,
            parameters,
            stream: false,
            client,
        }),
        bodies,
    };
}
