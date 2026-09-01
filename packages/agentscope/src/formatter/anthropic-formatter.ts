/* eslint-disable jsdoc/require-jsdoc */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

import { minimatch } from 'minimatch';

import { FormatterBase } from './base';
import type { FormatterOptions } from './base';
import { _jsonLoadsWithRepair } from '../_utils/common';
import type { DataBlock, Msg } from '../message';
import { getContentBlocks } from '../message';

type AnthropicBlock = Record<string, unknown>;

abstract class AnthropicFormatterBase extends FormatterBase {
    protected constructor(options: FormatterOptions = {}) {
        super({
            inputTypes: options.inputTypes ?? ['text/plain', 'image/*', 'application/pdf'],
        });
    }

    protected async formatMessages(msgs: Msg[]): Promise<Record<string, unknown>[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const messages: Record<string, unknown>[] = [];

        for (const msg of msgs) {
            let contentBlocks: AnthropicBlock[] = [];
            let hasToolResult = false;
            for (const block of getContentBlocks(msg)) {
                if (hasToolResult && contentBlocks.length > 0 && block.type !== 'tool_result') {
                    messages.push({ role: 'user', content: contentBlocks });
                    contentBlocks = [];
                    hasToolResult = false;
                }

                if (block.type === 'text') {
                    if (block.text) contentBlocks.push({ type: 'text', text: block.text });
                } else if (block.type === 'thinking') {
                    const redacted = block.redacted_thinking_data;
                    if (redacted !== undefined && redacted !== null) {
                        contentBlocks.push({ type: 'redacted_thinking', data: redacted });
                    } else if (block.signature) {
                        contentBlocks.push({
                            type: 'thinking',
                            thinking: block.thinking,
                            signature: block.signature,
                        });
                    }
                } else if (block.type === 'hint') {
                    if (contentBlocks.length > 0) {
                        messages.push({
                            role: hasToolResult ? 'user' : msg.role,
                            content: contentBlocks,
                        });
                        contentBlocks = [];
                        hasToolResult = false;
                    }
                    const hintParts: AnthropicBlock[] = [];
                    if (typeof block.hint === 'string') {
                        hintParts.push({ type: 'text', text: block.hint });
                    } else {
                        for (const item of block.hint) {
                            if (item.type === 'text') {
                                hintParts.push({ type: 'text', text: item.text });
                            } else {
                                const formatted = await this.formatAnthropicDataBlock(item);
                                if (formatted) hintParts.push(formatted);
                            }
                        }
                    }
                    if (hintParts.length > 0) messages.push({ role: 'user', content: hintParts });
                } else if (block.type === 'data') {
                    const formatted = await this.formatAnthropicDataBlock(block);
                    if (formatted) contentBlocks.push(formatted);
                } else if (block.type === 'tool_call') {
                    contentBlocks.push({
                        type: 'tool_use',
                        id: block.id,
                        name: block.name,
                        input: _jsonLoadsWithRepair(block.input || '{}'),
                    });
                } else if (block.type === 'tool_result') {
                    if (contentBlocks.length > 0 && !hasToolResult) {
                        messages.push({ role: msg.role, content: contentBlocks });
                        contentBlocks = [];
                    }
                    const toolResultContent: AnthropicBlock[] = [];
                    if (typeof block.output === 'string') {
                        if (block.output) {
                            toolResultContent.push({ type: 'text', text: block.output });
                        }
                    } else {
                        for (const output of block.output) {
                            if (output.type === 'text') {
                                if (output.text) {
                                    toolResultContent.push({ type: 'text', text: output.text });
                                }
                            } else {
                                const formatted = await this.formatAnthropicDataBlock(output);
                                if (formatted) toolResultContent.push(formatted);
                                else {
                                    const mainType = output.source.media_type.split('/')[0];
                                    const text =
                                        output.source.type === 'url'
                                            ? `[${mainType} file returned, URL: ${output.source.url}]`
                                            : `[${mainType} file returned, type: ${output.source.media_type}]`;
                                    toolResultContent.push({ type: 'text', text });
                                }
                            }
                        }
                    }
                    if (toolResultContent.length === 0) {
                        toolResultContent.push({ type: 'text', text: '(empty tool output)' });
                    }
                    contentBlocks.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: toolResultContent,
                    });
                    hasToolResult = true;
                }
            }
            if (contentBlocks.length > 0) {
                messages.push({
                    role: hasToolResult ? 'user' : msg.role,
                    content: contentBlocks,
                });
            }
        }
        return messages;
    }

    protected async formatAnthropicDataBlock(block: DataBlock): Promise<AnthropicBlock | null> {
        const mediaType = block.source.media_type;
        if (!this.supportedInputMediaTypes.some(pattern => minimatch(mediaType, pattern))) {
            console.warn(`Media type ${mediaType} is not supported, skipped.`);
            return null;
        }
        if (mediaType.startsWith('image/')) return this.formatSource(block.source, 'image');
        if (mediaType === 'application/pdf') return this.formatSource(block.source, 'document');
        console.warn(`Anthropic only supports image and PDF data, got ${mediaType}, skipped.`);
        return null;
    }

    private async formatSource(
        source: DataBlock['source'],
        blockType: 'image' | 'document'
    ): Promise<AnthropicBlock> {
        let data: string;
        if (source.type === 'base64') data = source.data;
        else if (source.url.startsWith('file://')) {
            data = (await readFile(fileURLToPath(source.url))).toString('base64');
        } else {
            const response = await fetch(source.url);
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch media from URL: ${source.url} (${response.status})`
                );
            }
            data = Buffer.from(await response.arrayBuffer()).toString('base64');
        }
        return {
            type: blockType,
            source: { type: 'base64', media_type: source.media_type, data },
        };
    }
}

/** Format messages for Anthropic's Messages API. */
export class AnthropicChatFormatter extends AnthropicFormatterBase {
    constructor(options: FormatterOptions = {}) {
        super(options);
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        return this.formatMessages(msgs);
    }
}

export interface AnthropicMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format attributed multi-agent histories for Anthropic. */
export class AnthropicMultiAgentFormatter extends AnthropicFormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: AnthropicMultiAgentFormatterOptions = {}) {
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
            const text = getContentBlocks(msgs[0])
                .filter(block => block.type === 'text')
                .map(block => block.text)
                .join('\n');
            formatted.push({ role: 'system', content: [{ type: 'text', text }] });
            startIndex = 1;
        }
        let isFirst = true;
        for await (const [type, group] of this.groupMessages(msgs.slice(startIndex))) {
            if (type === 'tool_sequence') formatted.push(...(await this.formatMessages(group)));
            else {
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
        const conversationBlocks: AnthropicBlock[] = [];
        let accumulatedText: string[] = [];
        for (const msg of msgs) {
            const textParts: string[] = [];
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') textParts.push(block.text);
                else if (block.type === 'data') {
                    const formatted = await this.formatAnthropicDataBlock(block);
                    if (formatted) {
                        if (accumulatedText.length > 0) {
                            conversationBlocks.push({
                                type: 'text',
                                text: accumulatedText.join('\n'),
                            });
                            accumulatedText = [];
                        }
                        conversationBlocks.push(formatted);
                    }
                }
            }
            if (textParts.length > 0) {
                accumulatedText.push(`${msg.name || 'Agent'}: ${textParts.join(' ')}`);
            }
        }
        if (accumulatedText.length > 0) {
            conversationBlocks.push({ type: 'text', text: accumulatedText.join('\n') });
        }
        if (conversationBlocks.length > 0 && isFirst) {
            const first = conversationBlocks[0];
            if (typeof first.text === 'string') {
                first.text = `${this.conversationHistoryPrompt}<history>\n${first.text}`;
            } else {
                conversationBlocks.unshift({
                    type: 'text',
                    text: `${this.conversationHistoryPrompt}<history>\n`,
                });
            }
            const last = conversationBlocks.at(-1)!;
            if (typeof last.text === 'string') last.text += '\n</history>';
            else conversationBlocks.push({ type: 'text', text: '</history>' });
        }
        return conversationBlocks.length > 0 ? [{ role: 'user', content: conversationBlocks }] : [];
    }
}
