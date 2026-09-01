/* eslint-disable jsdoc/require-jsdoc */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

import { minimatch } from 'minimatch';

import { FormatterBase } from './base';
import type { FormatterOptions } from './base';
import type { DataBlock, Msg } from '../message';
import { getContentBlocks, getTextContent } from '../message';

export interface OpenAIFormatterOptions extends FormatterOptions {
    /** @deprecated Supported media are controlled by inputTypes. */
    promoteMultimodalToolResult?: { image?: boolean; audio?: boolean; video?: boolean } | boolean;
}

type OpenAIContentPart = Record<string, unknown>;

export abstract class OpenAIFormatterBase extends FormatterBase {
    protected constructor(options: FormatterOptions = {}) {
        super({
            inputTypes: options.inputTypes ?? [
                'text/plain',
                'image/*',
                'audio/*',
                'application/pdf',
            ],
        });
    }

    protected async formatOpenAIDataBlock(block: DataBlock): Promise<OpenAIContentPart | null> {
        if (
            !this.supportedInputMediaTypes.some(pattern => {
                return minimatch(block.source.media_type, pattern);
            })
        ) {
            console.warn(
                `Unsupported media type ${block.source.media_type} for OpenAI API. ` +
                    `Supported types: ${this.supportedInputMediaTypes.join(', ')}. ` +
                    'This block will be skipped.'
            );
            return null;
        }

        const mainType = block.source.media_type.split('/')[0];
        if (mainType === 'image') return this.formatImageSource(block.source);
        if (mainType === 'audio') return this.formatAudioSource(block.source);
        if (block.source.media_type === 'application/pdf') {
            return this.formatFileSource(block.source, block.name);
        }
        console.warn(
            `Unsupported main media type ${mainType} for OpenAI API. This block will be skipped.`
        );
        return null;
    }

    protected async formatImageSource(source: DataBlock['source']): Promise<OpenAIContentPart> {
        let url: string;
        if (source.type === 'base64') {
            url = `data:${source.media_type};base64,${source.data}`;
        } else if (source.url.startsWith('file://')) {
            const data = await readFile(fileURLToPath(source.url));
            url = `data:${source.media_type};base64,${data.toString('base64')}`;
        } else {
            url = source.url;
        }
        return { type: 'image_url', image_url: { url } };
    }

    private async formatAudioSource(source: DataBlock['source']): Promise<OpenAIContentPart> {
        const formats: Record<string, 'wav' | 'mp3'> = {
            'audio/wav': 'wav',
            'audio/mp3': 'mp3',
            'audio/mpeg': 'mp3',
        };
        const format = formats[source.media_type];
        if (!format) {
            throw new TypeError(
                `Unsupported audio media type: ${source.media_type}, ` +
                    'only WAV and MP3 audio are supported.'
            );
        }
        const data = await this.readSourceAsBase64(source);
        return { type: 'input_audio', input_audio: { data, format } };
    }

    private async formatFileSource(
        source: DataBlock['source'],
        name?: string | null
    ): Promise<OpenAIContentPart> {
        const data = await this.readSourceAsBase64(source);
        return {
            type: 'file',
            file: {
                filename: name ?? 'document.pdf',
                file_data: `data:${source.media_type};base64,${data}`,
            },
        };
    }

    private async readSourceAsBase64(source: DataBlock['source']): Promise<string> {
        if (source.type === 'base64') return source.data;
        if (source.url.startsWith('file://')) {
            return (await readFile(fileURLToPath(source.url))).toString('base64');
        }
        const response = await fetch(source.url);
        if (!response.ok) {
            throw new Error(`Failed to fetch media from URL: ${source.url} (${response.status})`);
        }
        return Buffer.from(await response.arrayBuffer()).toString('base64');
    }
}

/** Format AgentScope messages for the OpenAI Chat Completions API. */
export class OpenAIChatFormatter extends OpenAIFormatterBase {
    constructor(options: OpenAIFormatterOptions = {}) {
        super(options);
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const messages: Record<string, unknown>[] = [];

        for (const msg of msgs) {
            let contentBlocks: OpenAIContentPart[] = [];
            let toolCalls: Record<string, unknown>[] = [];

            const flush = (): void => {
                if (contentBlocks.length === 0 && toolCalls.length === 0) return;
                const message: Record<string, unknown> = {
                    role: msg.role,
                    name: msg.name,
                    content: contentBlocks.length > 0 ? contentBlocks : null,
                };
                if (toolCalls.length > 0) message.tool_calls = toolCalls;
                messages.push(message);
                contentBlocks = [];
                toolCalls = [];
            };

            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') {
                    contentBlocks.push({ type: 'text', text: block.text });
                } else if (block.type === 'data') {
                    const formatted = await this.formatOpenAIDataBlock(block);
                    if (formatted) contentBlocks.push(formatted);
                } else if (block.type === 'hint') {
                    flush();
                    const hintParts: OpenAIContentPart[] = [];
                    if (typeof block.hint === 'string') {
                        hintParts.push({ type: 'text', text: block.hint });
                    } else {
                        for (const item of block.hint) {
                            if (item.type === 'text') {
                                hintParts.push({ type: 'text', text: item.text });
                            } else {
                                const formatted = await this.formatOpenAIDataBlock(item);
                                if (formatted) hintParts.push(formatted);
                            }
                        }
                    }
                    if (hintParts.length > 0) messages.push({ role: 'user', content: hintParts });
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
                    const promoted: OpenAIContentPart[] = [];
                    for (const item of media) {
                        if (item.type === 'text') {
                            promoted.push({ type: 'text', text: item.text });
                        } else {
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

export interface OpenAIMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format multi-agent histories as attributed OpenAI user messages. */
export class OpenAIMultiAgentFormatter extends OpenAIFormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: OpenAIMultiAgentFormatterOptions = {}) {
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
        let isFirstAgentMessage = true;
        for await (const [type, group] of this.groupMessages(msgs.slice(startIndex))) {
            if (type === 'tool_sequence') {
                formatted.push(
                    ...(await new OpenAIChatFormatter({ inputTypes: this.inputTypes }).format({
                        msgs: group,
                    }))
                );
            } else {
                formatted.push(...(await this.formatAgentMessage(group, isFirstAgentMessage)));
                isFirstAgentMessage = false;
            }
        }
        return formatted;
    }

    private async formatAgentMessage(
        msgs: Msg[],
        isFirst: boolean
    ): Promise<Record<string, unknown>[]> {
        const text: string[] = [];
        const media: OpenAIContentPart[] = [];
        for (const msg of msgs) {
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') text.push(`${msg.name}: ${block.text}`);
                else if (block.type === 'data') {
                    const formatted = await this.formatOpenAIDataBlock(block);
                    if (formatted) media.push(formatted);
                }
            }
        }
        const content: OpenAIContentPart[] = [];
        if (text.length > 0) {
            const prefix = isFirst ? this.conversationHistoryPrompt : '';
            content.push({
                type: 'text',
                text: `${prefix}<history>\n${text.join('\n')}\n</history>`,
            });
        }
        content.push(...media);
        return content.length > 0 ? [{ role: 'user', content }] : [];
    }
}
