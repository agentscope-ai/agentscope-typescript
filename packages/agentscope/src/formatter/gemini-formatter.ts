/* eslint-disable jsdoc/require-jsdoc */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

import { minimatch } from 'minimatch';

import { FormatterBase } from './base';
import type { FormatterOptions } from './base';
import { _jsonLoadsWithRepair } from '../_utils/common';
import type { DataBlock, Msg } from '../message';
import { getContentBlocks, getTextContent } from '../message';

type GeminiPart = Record<string, unknown>;

abstract class GeminiFormatterBase extends FormatterBase {
    protected constructor(options: FormatterOptions = {}) {
        super({
            inputTypes: options.inputTypes ?? [
                'text/plain',
                'image/*',
                'audio/*',
                'video/*',
                'application/pdf',
            ],
        });
    }

    protected async formatGeminiDataBlock(block: DataBlock): Promise<GeminiPart | null> {
        if (
            !this.supportedInputMediaTypes.some(pattern => {
                return minimatch(block.source.media_type, pattern);
            })
        ) {
            console.warn(`Media type ${block.source.media_type} is not supported, skipped.`);
            return null;
        }
        let data: string;
        if (block.source.type === 'base64') data = block.source.data;
        else if (block.source.url.startsWith('file://')) {
            data = (await readFile(fileURLToPath(block.source.url))).toString('base64');
        } else {
            const response = await fetch(block.source.url);
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch media from URL: ${block.source.url} (${response.status})`
                );
            }
            data = Buffer.from(await response.arrayBuffer()).toString('base64');
        }
        return { inline_data: { data, mime_type: block.source.media_type } };
    }
}

/** Format messages for Google Gemini. */
export class GeminiChatFormatter extends GeminiFormatterBase {
    constructor(options: FormatterOptions = {}) {
        super(options);
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const messages: Record<string, unknown>[] = [];
        for (const msg of msgs) {
            let parts: GeminiPart[] = [];
            const flush = (): void => {
                if (parts.length === 0) return;
                messages.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
                parts = [];
            };
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') {
                    parts.push({ text: block.text });
                } else if (block.type === 'thinking') {
                    if (block.thinking) parts.push({ thought: true, text: block.thinking });
                } else if (block.type === 'hint') {
                    flush();
                    const hintParts: GeminiPart[] = [];
                    if (typeof block.hint === 'string') hintParts.push({ text: block.hint });
                    else {
                        for (const item of block.hint) {
                            if (item.type === 'text') hintParts.push({ text: item.text });
                            else {
                                const formatted = await this.formatGeminiDataBlock(item);
                                if (formatted) hintParts.push(formatted);
                            }
                        }
                    }
                    if (hintParts.length > 0) messages.push({ role: 'user', parts: hintParts });
                } else if (block.type === 'data') {
                    const formatted = await this.formatGeminiDataBlock(block);
                    if (formatted) parts.push(formatted);
                } else if (block.type === 'tool_call') {
                    parts.push({
                        function_call: {
                            id: block.id,
                            name: block.name,
                            args: _jsonLoadsWithRepair(block.input || '{}'),
                        },
                    });
                } else if (block.type === 'tool_result') {
                    flush();
                    const [text, media] = this.convertToolResultToString(block.output);
                    messages.push({
                        role: 'user',
                        parts: [
                            {
                                function_response: {
                                    id: block.id,
                                    name: block.name,
                                    response: { output: text },
                                },
                            },
                        ],
                    });
                    const promoted: GeminiPart[] = [];
                    for (const item of media) {
                        if (item.type === 'text') promoted.push({ text: item.text });
                        else {
                            const formatted = await this.formatGeminiDataBlock(item);
                            if (formatted) promoted.push(formatted);
                        }
                    }
                    if (promoted.length > 0) messages.push({ role: 'user', parts: promoted });
                }
            }
            flush();
        }
        return messages;
    }
}

export interface GeminiMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format attributed multi-agent histories for Gemini. */
export class GeminiMultiAgentFormatter extends GeminiFormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: GeminiMultiAgentFormatterOptions = {}) {
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
            formatted.push({ role: 'user', parts: [{ text: getTextContent(msgs[0]) }] });
            startIndex = 1;
        }
        let isFirst = true;
        for await (const [type, group] of this.groupMessages(msgs.slice(startIndex))) {
            if (type === 'tool_sequence') {
                formatted.push(
                    ...(await new GeminiChatFormatter({ inputTypes: this.inputTypes }).format({
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
        const conversationParts: GeminiPart[] = [];
        let accumulatedText: string[] = [];
        for (const msg of msgs) {
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') accumulatedText.push(`${msg.name}: ${block.text}`);
                else if (block.type === 'data') {
                    if (accumulatedText.length > 0) {
                        conversationParts.push({ text: accumulatedText.join('\n') });
                        accumulatedText = [];
                    }
                    const formatted = await this.formatGeminiDataBlock(block);
                    if (formatted) conversationParts.push(formatted);
                }
            }
        }
        if (accumulatedText.length > 0) {
            conversationParts.push({ text: accumulatedText.join('\n') });
        }
        if (conversationParts.length > 0) {
            const first = conversationParts[0];
            const prefix = isFirst ? this.conversationHistoryPrompt : '';
            if (typeof first.text === 'string') first.text = `${prefix}<history>\n${first.text}`;
            else conversationParts.unshift({ text: `${prefix}<history>\n` });
            const last = conversationParts.at(-1)!;
            if (typeof last.text === 'string') last.text += '\n</history>';
            else conversationParts.push({ text: '</history>' });
            return [{ role: 'user', parts: conversationParts }];
        }
        return [];
    }
}
