/* eslint-disable jsdoc/require-jsdoc */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

import { minimatch } from 'minimatch';

import { FormatterBase } from './base';
import type { FormatterOptions } from './base';
import { _jsonLoadsWithRepair } from '../_utils/common';
import type { DataBlock, Msg, ToolCallBlock } from '../message';
import { getContentBlocks } from '../message';

abstract class OllamaFormatterBase extends FormatterBase {
    protected constructor(options: FormatterOptions = {}) {
        super({ inputTypes: options.inputTypes ?? ['text/plain', 'image/*'] });
    }

    protected async formatOllamaDataBlock(block: DataBlock): Promise<string | null> {
        const mediaType = block.source.media_type;
        if (!this.supportedInputMediaTypes.some(pattern => minimatch(mediaType, pattern))) {
            console.warn(`Media type ${mediaType} is not supported, skipped.`);
            return null;
        }
        if (!mediaType.startsWith('image/')) {
            console.warn(`Ollama only supports image data, got ${mediaType}, skipped.`);
            return null;
        }
        if (block.source.type === 'base64') return block.source.data;
        if (block.source.url.startsWith('file://')) {
            return (await readFile(fileURLToPath(block.source.url))).toString('base64');
        }
        const response = await fetch(block.source.url);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch image from URL: ${block.source.url} (${response.status})`
            );
        }
        return Buffer.from(await response.arrayBuffer()).toString('base64');
    }
}

/** Format messages for Ollama's chat API. */
export class OllamaChatFormatter extends OllamaFormatterBase {
    constructor(options: FormatterOptions = {}) {
        super(options);
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const messages: Record<string, unknown>[] = [];
        for (const msg of msgs) {
            let content: string[] = [];
            let images: string[] = [];
            const flush = (): void => {
                if (content.length === 0 && images.length === 0) return;
                const item: Record<string, unknown> = {
                    role: msg.role,
                    content: content.join('\n'),
                };
                if (images.length > 0) item.images = images;
                messages.push(item);
                content = [];
                images = [];
            };

            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') content.push(block.text);
                else if (block.type === 'hint') {
                    flush();
                    if (typeof block.hint === 'string') {
                        messages.push({ role: 'user', content: block.hint });
                    } else {
                        const hintText: string[] = [];
                        const hintImages: string[] = [];
                        for (const item of block.hint) {
                            if (item.type === 'text') hintText.push(item.text);
                            else {
                                const image = await this.formatOllamaDataBlock(item);
                                if (image) hintImages.push(image);
                            }
                        }
                        if (hintText.length > 0 || hintImages.length > 0) {
                            const hint: Record<string, unknown> = {
                                role: 'user',
                                content: hintText.join('\n'),
                            };
                            if (hintImages.length > 0) hint.images = hintImages;
                            messages.push(hint);
                        }
                    }
                } else if (block.type === 'data') {
                    const image = await this.formatOllamaDataBlock(block);
                    if (image) images.push(image);
                } else if (block.type === 'tool_call') {
                    messages.push(this.formatToolCallMessage(msg.role, content, images, block));
                    content = [];
                    images = [];
                } else if (block.type === 'tool_result') {
                    flush();
                    const [text, media] = this.convertToolResultToString(block.output);
                    messages.push({ role: 'tool', tool_name: block.name, content: text });
                    if (media.length > 0) {
                        const userContent: string[] = [];
                        const userImages: string[] = [];
                        for (const item of media) {
                            if (item.type === 'text') userContent.push(item.text);
                            else {
                                const image = await this.formatOllamaDataBlock(item);
                                if (image) userImages.push(image);
                            }
                        }
                        const user: Record<string, unknown> = {
                            role: 'user',
                            content: userContent.length > 0 ? userContent.join('\n') : text,
                        };
                        if (userImages.length > 0) user.images = userImages;
                        messages.push(user);
                    }
                }
            }
            flush();
        }
        return messages;
    }

    private formatToolCallMessage(
        role: Msg['role'],
        content: string[],
        images: string[],
        block: ToolCallBlock
    ): Record<string, unknown> {
        const message: Record<string, unknown> = {
            role,
            content: content.join('\n'),
            tool_calls: [
                {
                    function: {
                        name: block.name,
                        arguments: _jsonLoadsWithRepair(block.input || '{}'),
                    },
                },
            ],
        };
        if (images.length > 0) message.images = images;
        return message;
    }
}

export interface OllamaMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format attributed multi-agent histories for Ollama. */
export class OllamaMultiAgentFormatter extends OllamaFormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: OllamaMultiAgentFormatterOptions = {}) {
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
            formatted.push({
                role: 'system',
                content: getContentBlocks(msgs[0])
                    .filter(block => block.type === 'text')
                    .map(block => block.text)
                    .join('\n'),
            });
            startIndex = 1;
        }
        let isFirst = true;
        for await (const [type, group] of this.groupMessages(msgs.slice(startIndex))) {
            if (type === 'tool_sequence') {
                formatted.push(
                    ...(await new OllamaChatFormatter({ inputTypes: this.inputTypes }).format({
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
        const accumulated: string[] = [];
        const images: string[] = [];
        for (const msg of msgs) {
            const text: string[] = [];
            if (msg.name) text.push(`${msg.name}:`);
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') text.push(block.text);
                else if (block.type === 'data') {
                    const image = await this.formatOllamaDataBlock(block);
                    if (image) images.push(image);
                }
            }
            if (text.length > 0) accumulated.push(text.join('\n'));
        }
        if (accumulated.length === 0) return [];
        let content = accumulated.join('\n');
        if (isFirst) content = `${this.conversationHistoryPrompt}<history>\n${content}\n</history>`;
        const user: Record<string, unknown> = { role: 'user', content };
        if (images.length > 0) user.images = images;
        return [user];
    }
}
