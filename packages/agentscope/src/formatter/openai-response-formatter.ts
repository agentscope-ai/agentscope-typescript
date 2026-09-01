/* eslint-disable jsdoc/require-jsdoc */

import { minimatch } from 'minimatch';

import { FormatterBase } from './base';
import type { FormatterOptions } from './base';
import { OpenAIFormatterBase } from './openai-chat-formatter';
import type { DataBlock, Msg, TextBlock } from '../message';
import { getContentBlocks, getTextContent } from '../message';

type ResponseItem = Record<string, unknown>;

abstract class OpenAIResponseFormatterBase extends OpenAIFormatterBase {
    protected constructor(options: FormatterOptions = {}) {
        super({
            inputTypes: options.inputTypes ?? ['text/plain', 'image/*', 'application/pdf'],
        });
    }

    protected async formatResponseDataBlock(block: DataBlock): Promise<ResponseItem | null> {
        if (block.source.media_type.split('/')[0] === 'audio') {
            console.warn(
                'Audio input is not supported by the OpenAI Responses API. ' +
                    'Use OpenAIChatModel with an audio-capable model instead. ' +
                    'This audio block will be skipped.'
            );
            return null;
        }
        const base = await this.formatOpenAIDataBlock(block);
        if (!base) return null;
        if (base.type === 'image_url') {
            return {
                type: 'input_image',
                image_url: (base.image_url as { url: string }).url,
            };
        }
        if (base.type === 'file') return { type: 'input_file', ...(base.file as object) };
        return base;
    }

    protected async formatToolResultOutput(
        output: string | (TextBlock | DataBlock)[]
    ): Promise<string | ResponseItem[]> {
        if (typeof output === 'string') return output;
        const parts: ResponseItem[] = [];
        let hasNativeMedia = false;
        for (const block of output) {
            if (block.type === 'text') {
                parts.push({ type: 'input_text', text: block.text });
                continue;
            }
            const mediaType = block.source.media_type;
            const supported =
                (mediaType.startsWith('image/') || mediaType === 'application/pdf') &&
                this.supportedInputMediaTypes.some(pattern => minimatch(mediaType, pattern));
            if (supported) {
                const formatted = await this.formatResponseDataBlock(block);
                if (!formatted) {
                    throw new Error(
                        `Supported OpenAI Responses tool-result media could not be formatted: ${mediaType}.`
                    );
                }
                parts.push(formatted);
                hasNativeMedia = true;
            } else {
                parts.push({
                    type: 'input_text',
                    text: this.convertUnsupportedDataBlockToString(block),
                });
            }
        }
        if (hasNativeMedia) return parts;
        return parts.map(part => String(part.text)).join('\n');
    }
}

/** Format messages for OpenAI's Responses API. */
export class OpenAIResponseFormatter extends OpenAIResponseFormatterBase {
    constructor(options: FormatterOptions = {}) {
        super(options);
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<ResponseItem[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const items: ResponseItem[] = [];
        for (const msg of msgs) {
            let content: ResponseItem[] = [];
            let calls: ResponseItem[] = [];
            const flush = (): void => {
                if (calls.length > 0) {
                    if (content.length > 0) items.push({ role: msg.role, content });
                    items.push(...calls);
                } else if (content.length > 0) items.push({ role: msg.role, content });
                content = [];
                calls = [];
            };

            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') {
                    content.push({
                        type: msg.role === 'assistant' ? 'output_text' : 'input_text',
                        text: block.text,
                    });
                } else if (block.type === 'data') {
                    const formatted = await this.formatResponseDataBlock(block);
                    if (formatted) content.push(formatted);
                } else if (block.type === 'hint') {
                    flush();
                    const hint: ResponseItem[] = [];
                    if (typeof block.hint === 'string') {
                        hint.push({ type: 'input_text', text: block.hint });
                    } else {
                        for (const item of block.hint) {
                            if (item.type === 'text') {
                                hint.push({ type: 'input_text', text: item.text });
                            } else {
                                const formatted = await this.formatResponseDataBlock(item);
                                if (formatted) hint.push(formatted);
                            }
                        }
                    }
                    if (hint.length > 0) items.push({ role: 'user', content: hint });
                } else if (block.type === 'thinking') {
                    const reasoningId = block.reasoning_item_id;
                    if (typeof reasoningId === 'string' && reasoningId) {
                        if (content.length > 0 && block.thinking) {
                            items.push({ role: msg.role, content });
                            content = [];
                        }
                        const raw = block.reasoning_item_raw;
                        if (
                            typeof raw === 'object' &&
                            raw !== null &&
                            Reflect.get(raw, 'type') === 'reasoning' &&
                            Reflect.get(raw, 'id') === reasoningId
                        ) {
                            items.push(structuredClone(raw) as ResponseItem);
                        } else {
                            items.push({
                                type: 'reasoning',
                                id: reasoningId,
                                summary: block.thinking
                                    ? [{ type: 'summary_text', text: block.thinking }]
                                    : [],
                                content: [],
                            });
                        }
                    }
                } else if (block.type === 'tool_call') {
                    calls.push({
                        type: 'function_call',
                        call_id: block.id,
                        name: block.name,
                        arguments: block.input,
                    });
                } else if (block.type === 'tool_result') {
                    flush();
                    items.push({
                        type: 'function_call_output',
                        call_id: block.id,
                        output: await this.formatToolResultOutput(block.output),
                    });
                }
            }
            flush();
        }
        return items;
    }
}

export interface OpenAIResponseMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format attributed multi-agent histories for OpenAI Responses. */
export class OpenAIResponseMultiAgentFormatter extends OpenAIResponseFormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: OpenAIResponseMultiAgentFormatterOptions = {}) {
        super(options);
        this.conversationHistoryPrompt =
            options.conversationHistoryPrompt ??
            '# Conversation History\n' +
                'The content between <history></history> tags contains your conversation history\n';
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<ResponseItem[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const formatted: ResponseItem[] = [];
        let startIndex = 0;
        if (msgs[0]?.role === 'system') {
            formatted.push({ role: 'system', content: getTextContent(msgs[0]) });
            startIndex = 1;
        }
        let isFirst = true;
        for await (const [type, group] of this.groupMessages(msgs.slice(startIndex))) {
            if (type === 'tool_sequence') {
                formatted.push(
                    ...(await new OpenAIResponseFormatter({ inputTypes: this.inputTypes }).format({
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

    private async formatAgentMessage(msgs: Msg[], isFirst: boolean): Promise<ResponseItem[]> {
        const text: string[] = [];
        const media: ResponseItem[] = [];
        for (const msg of msgs) {
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') text.push(`${msg.name}: ${block.text}`);
                else if (block.type === 'data') {
                    const formatted = await this.formatResponseDataBlock(block);
                    if (formatted) media.push(formatted);
                }
            }
        }
        if (text.length === 0 && media.length === 0) return [];
        const prefix = isFirst ? this.conversationHistoryPrompt : '';
        const content: ResponseItem[] = [
            {
                type: 'input_text',
                text: `${prefix}<history>\n${text.join('\n')}\n</history>`,
            },
            ...media,
        ];
        return [{ role: 'user', content }];
    }
}
