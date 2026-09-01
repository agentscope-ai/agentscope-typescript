/* eslint-disable jsdoc/require-jsdoc */

import { FormatterBase } from './base';
import type { FormatterOptions } from './base';
import type { Msg } from '../message';
import { getContentBlocks, getTextContent } from '../message';

/** Format messages for DeepSeek's OpenAI-compatible API. */
export class DeepSeekChatFormatter extends FormatterBase {
    constructor(options: FormatterOptions = {}) {
        super({ inputTypes: options.inputTypes ?? ['text/plain'] });
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const messages: Record<string, unknown>[] = [];
        for (const msg of msgs) {
            let content: string[] = [];
            let reasoning: string[] = [];
            let toolCalls: Record<string, unknown>[] = [];
            const flush = (): void => {
                if (content.length === 0 && reasoning.length === 0 && toolCalls.length === 0)
                    return;
                const item: Record<string, unknown> = {
                    role: msg.role,
                    content: content.join('\n') || (toolCalls.length > 0 ? null : ''),
                };
                if (msg.role === 'assistant') item.reasoning_content = reasoning.join('\n');
                if (toolCalls.length > 0) item.tool_calls = toolCalls;
                messages.push(item);
                content = [];
                reasoning = [];
                toolCalls = [];
            };
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') content.push(block.text);
                else if (block.type === 'thinking') reasoning.push(block.thinking);
                else if (block.type === 'hint') {
                    flush();
                    if (typeof block.hint === 'string') {
                        messages.push({ role: 'user', content: block.hint });
                    } else {
                        const parts = block.hint.map(item => {
                            return item.type === 'text'
                                ? item.text
                                : `[${item.source.media_type} attached, not supported by this provider]`;
                        });
                        if (parts.length > 0) {
                            messages.push({ role: 'user', content: parts.join('\n') });
                        }
                    }
                } else if (block.type === 'tool_call') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: { name: block.name, arguments: block.input },
                    });
                } else if (block.type === 'tool_result') {
                    flush();
                    const [text] = this.convertToolResultToString(block.output);
                    messages.push({
                        role: 'tool',
                        tool_call_id: block.id,
                        content: text,
                        name: block.name,
                    });
                }
            }
            flush();
        }
        return messages;
    }
}

export interface DeepSeekMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format attributed multi-agent histories for DeepSeek. */
export class DeepSeekMultiAgentFormatter extends FormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: DeepSeekMultiAgentFormatterOptions = {}) {
        super({ inputTypes: options.inputTypes ?? ['text/plain'] });
        this.conversationHistoryPrompt =
            options.conversationHistoryPrompt ??
            '# Conversation History\n' +
                'The content between <history></history> tags contains your conversation history\n';
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const formatted: Record<string, unknown>[] = [];
        let startIndex = 0;
        if (msgs[0]?.role === 'system') {
            formatted.push({ role: 'system', content: getTextContent(msgs[0]) });
            startIndex = 1;
        }
        let isFirst = true;
        for await (const [type, group] of this.groupMessages(msgs.slice(startIndex))) {
            if (type === 'tool_sequence') {
                formatted.push(
                    ...(await new DeepSeekChatFormatter({ inputTypes: this.inputTypes }).format({
                        msgs: group,
                    }))
                );
            } else {
                const text: string[] = [];
                for (const msg of group) {
                    for (const block of getContentBlocks(msg)) {
                        if (block.type === 'text') text.push(`${msg.name}: ${block.text}`);
                    }
                }
                if (text.length > 0) {
                    const prefix = isFirst ? this.conversationHistoryPrompt : '';
                    formatted.push({
                        role: 'user',
                        content: `${prefix}<history>\n${text.join('\n')}\n</history>`,
                    });
                }
                isFirst = false;
            }
        }
        return formatted;
    }
}
