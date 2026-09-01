/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    AnthropicChatFormatter,
    AnthropicMultiAgentFormatter,
    DashScopeChatFormatter,
    DashScopeMultiAgentFormatter,
    DeepSeekChatFormatter,
    DeepSeekMultiAgentFormatter,
    FormatterBase,
    GeminiChatFormatter,
    GeminiMultiAgentFormatter,
    MoonshotChatFormatter,
    MoonshotMultiAgentFormatter,
    OllamaChatFormatter,
    OllamaMultiAgentFormatter,
    OpenAIChatFormatter,
    OpenAIMultiAgentFormatter,
    OpenAIResponseFormatter,
    OpenAIResponseMultiAgentFormatter,
} from '../../src/formatter';
import { Msg, parseMsg } from '../../src/message';

interface GoldenFixture {
    python_commit: string;
    chat_messages: unknown[];
    multi_messages: unknown[];
    outputs: Record<string, unknown>;
}

const fixturePath = path.join(__dirname, 'fixtures/formatter.python.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFixture;

describe('Python formatter golden fixture', () => {
    test('is tied to the pinned Python source commit', () => {
        expect(fixture.python_commit).toBe('de163b34b909edaba3c174190ad7e1a355e7849f');
    });

    test.each(formatterCases())(
        '%s matches Python output exactly',
        async (name, formatter, msgs) => {
            const output = await formatter.format({ msgs });
            expect(normalizeTempPaths(output)).toEqual(fixture.outputs[name]);
        }
    );
});

/**
 *
 */
function formatterCases(): Array<[string, FormatterBase, Msg[]]> {
    const chat = fixture.chat_messages.map(parseMsg);
    const multi = fixture.multi_messages.map(parseMsg);
    return [
        ['openai_chat', new OpenAIChatFormatter(), chat],
        ['openai_multi', new OpenAIMultiAgentFormatter(), multi],
        ['anthropic_chat', new AnthropicChatFormatter(), chat],
        ['anthropic_multi', new AnthropicMultiAgentFormatter(), multi],
        ['gemini_chat', new GeminiChatFormatter(), chat],
        ['gemini_multi', new GeminiMultiAgentFormatter(), multi],
        ['moonshot_chat', new MoonshotChatFormatter(), chat],
        ['moonshot_multi', new MoonshotMultiAgentFormatter(), multi],
        ['ollama_chat', new OllamaChatFormatter(), chat],
        ['ollama_multi', new OllamaMultiAgentFormatter(), multi],
        [
            'dashscope_chat',
            new DashScopeChatFormatter({
                inputTypes: [
                    'text/plain',
                    'image/*',
                    'audio/*',
                    'video/*',
                    'application/x-thinking',
                ],
            }),
            chat,
        ],
        ['dashscope_multi', new DashScopeMultiAgentFormatter(), multi],
        ['deepseek_chat', new DeepSeekChatFormatter(), chat],
        ['deepseek_multi', new DeepSeekMultiAgentFormatter(), multi],
        ['openai_response', new OpenAIResponseFormatter(), chat],
        ['openai_response_multi', new OpenAIResponseMultiAgentFormatter(), multi],
    ];
}

/**
 *
 * @param value
 */
function normalizeTempPaths<T>(value: T): T {
    return JSON.parse(
        JSON.stringify(value).replace(
            /saved locally at: [^<]+(?=\.<\/system-reminder>)/g,
            'saved locally at: <TEMP_FILE>'
        )
    ) as T;
}
