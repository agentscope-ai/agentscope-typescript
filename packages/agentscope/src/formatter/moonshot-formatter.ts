/* eslint-disable jsdoc/require-jsdoc */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

import type { FormatterOptions } from './base';
import { FormatterBase } from './base';
import { OpenAIFormatterBase } from './openai-chat-formatter';
import type { DataBlock, Msg } from '../message';
import { getContentBlocks, getTextContent } from '../message';

type MoonshotContent = Record<string, unknown>;

abstract class MoonshotFormatterBase extends OpenAIFormatterBase {
    protected constructor(options: FormatterOptions = {}) {
        super({ inputTypes: options.inputTypes ?? ['text/plain', 'image/*', 'audio/*'] });
    }

    protected async formatImageSource(source: DataBlock['source']): Promise<MoonshotContent> {
        let data: string;
        if (source.type === 'base64') data = source.data;
        else if (source.url.startsWith('file://')) {
            data = (await readFile(fileURLToPath(source.url))).toString('base64');
        } else {
            const response = await fetch(source.url);
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch image from URL: ${source.url} (${response.status})`
                );
            }
            data = Buffer.from(await response.arrayBuffer()).toString('base64');
        }
        return {
            type: 'image_url',
            image_url: { url: `data:${source.media_type};base64,${data}` },
        };
    }
}

/** Format messages for Moonshot's OpenAI-compatible API. */
export class MoonshotChatFormatter extends MoonshotFormatterBase {
    constructor(options: FormatterOptions = {}) {
        super(options);
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const messages: Record<string, unknown>[] = [];
        for (const msg of msgs) {
            let content: MoonshotContent[] = [];
            let reasoning: string[] = [];
            let toolCalls: Record<string, unknown>[] = [];
            const flush = (): void => {
                if (content.length === 0 && toolCalls.length === 0 && reasoning.length === 0)
                    return;
                const item: Record<string, unknown> = {
                    role: msg.role,
                    name: msg.name,
                    content: content.length > 0 ? content : null,
                };
                if (msg.role === 'assistant') item.reasoning_content = reasoning.join('\n');
                if (toolCalls.length > 0) item.tool_calls = toolCalls;
                messages.push(item);
                content = [];
                reasoning = [];
                toolCalls = [];
            };

            for (const block of getContentBlocks(msg)) {
                if (block.type === 'thinking') reasoning.push(block.thinking);
                else if (block.type === 'text') content.push({ type: 'text', text: block.text });
                else if (block.type === 'data') {
                    const formatted = await this.formatOpenAIDataBlock(block);
                    if (formatted) content.push(formatted);
                } else if (block.type === 'hint') {
                    flush();
                    const hint: MoonshotContent[] = [];
                    if (typeof block.hint === 'string') {
                        hint.push({ type: 'text', text: block.hint });
                    } else {
                        for (const item of block.hint) {
                            if (item.type === 'text') hint.push({ type: 'text', text: item.text });
                            else {
                                const formatted = await this.formatOpenAIDataBlock(item);
                                if (formatted) hint.push(formatted);
                            }
                        }
                    }
                    if (hint.length > 0) messages.push({ role: 'user', content: hint });
                } else if (block.type === 'tool_call') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: { name: block.name, arguments: block.input },
                    });
                } else if (block.type === 'tool_result') {
                    flush();
                    const [text, media] = this.convertToolResultToString(block.output);
                    messages.push({
                        role: 'tool',
                        tool_call_id: block.id,
                        content: text,
                        name: block.name,
                    });
                    const promoted: MoonshotContent[] = [];
                    for (const item of media) {
                        if (item.type === 'text') promoted.push({ type: 'text', text: item.text });
                        else {
                            const formatted = await this.formatOpenAIDataBlock(item);
                            if (formatted) promoted.push(formatted);
                        }
                    }
                    if (promoted.length > 0) {
                        messages.push({
                            role: 'user',
                            name: 'system-reminder',
                            content: promoted,
                        });
                    }
                }
            }
            flush();
        }
        return messages;
    }
}

export interface MoonshotMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format attributed multi-agent histories for Moonshot. */
export class MoonshotMultiAgentFormatter extends MoonshotFormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: MoonshotMultiAgentFormatterOptions = {}) {
        super(options);
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
                    ...(await new MoonshotChatFormatter({ inputTypes: this.inputTypes }).format({
                        msgs: group,
                    }))
                );
            } else {
                formatted.push(...(await this.formatAgentMessage(group, isFirst)));
                isFirst = false;
            }
        }
        return formatted;
    }

    private async formatAgentMessage(
        msgs: Msg[],
        isFirst: boolean
    ): Promise<Record<string, unknown>[]> {
        const text: string[] = [];
        const media: MoonshotContent[] = [];
        for (const msg of msgs) {
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') text.push(`${msg.name}: ${block.text}`);
                else if (block.type === 'data') {
                    const formatted = await this.formatOpenAIDataBlock(block);
                    if (formatted) media.push(formatted);
                }
            }
        }
        if (text.length === 0 && media.length === 0) return [];
        const content: MoonshotContent[] = [];
        if (text.length > 0) {
            const prefix = isFirst ? this.conversationHistoryPrompt : '';
            content.push({
                type: 'text',
                text: `${prefix}<history>\n${text.join('\n')}\n</history>`,
            });
        }
        content.push(...media);
        return [{ role: 'user', content }];
    }
}
