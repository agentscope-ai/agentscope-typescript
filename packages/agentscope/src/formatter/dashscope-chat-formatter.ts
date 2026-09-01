/* eslint-disable jsdoc/require-jsdoc */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

import { minimatch } from 'minimatch';

import { FormatterBase } from './base';
import type { FormatterOptions } from './base';
import type { DataBlock, Msg } from '../message';
import { getContentBlocks, getTextContent } from '../message';

export interface DashScopeFormatterOptions extends FormatterOptions {
    /** @deprecated Supported media are controlled by inputTypes. */
    promoteMultimodalToolResult?: { image?: boolean; audio?: boolean; video?: boolean } | boolean;
}

type DashScopeContent = Record<string, unknown>;

abstract class DashScopeFormatterBase extends FormatterBase {
    protected constructor(options: FormatterOptions = {}) {
        super({
            inputTypes: options.inputTypes ?? ['text/plain', 'image/*', 'audio/*', 'video/*'],
        });
    }

    get supportsThinkingInput(): boolean {
        return this.inputTypes.includes('application/x-thinking');
    }

    protected async formatDashScopeDataBlock(block: DataBlock): Promise<DashScopeContent | null> {
        const mediaType = block.source.media_type;
        if (!this.supportedInputMediaTypes.some(pattern => minimatch(mediaType, pattern))) {
            console.warn(
                `Unsupported media type ${mediaType} for DashScope API. Supported types: ` +
                    `${this.supportedInputMediaTypes.join(', ')}. This block will be skipped.`
            );
            return null;
        }
        const mainType = mediaType.split('/')[0];
        if (mainType === 'image') return this.formatURLSource(block, 'image_url');
        if (mainType === 'video') return this.formatURLSource(block, 'video_url');
        if (mainType === 'audio') return this.formatAudioSource(block);
        console.warn(
            `Unsupported main media type ${mainType} for DashScope API. This block will be skipped.`
        );
        return null;
    }

    private async formatURLSource(
        block: DataBlock,
        type: 'image_url' | 'video_url'
    ): Promise<DashScopeContent> {
        let url: string;
        if (block.source.type === 'base64') {
            url = `data:${block.source.media_type};base64,${block.source.data}`;
        } else if (block.source.url.startsWith('file://')) {
            const data = await readFile(fileURLToPath(block.source.url));
            url = `data:${block.source.media_type};base64,${data.toString('base64')}`;
        } else url = block.source.url;
        return { type, [type]: { url } };
    }

    private async formatAudioSource(block: DataBlock): Promise<DashScopeContent> {
        let format = block.source.media_type.split('/').at(-1)!;
        if (format === 'mpeg') format = 'mp3';
        let data: string;
        if (block.source.type === 'base64') data = `data:;base64,${block.source.data}`;
        else if (block.source.url.startsWith('file://')) {
            data = `data:;base64,${(await readFile(fileURLToPath(block.source.url))).toString(
                'base64'
            )}`;
        } else data = block.source.url;
        return { type: 'input_audio', input_audio: { data, format } };
    }
}

/** Format messages for DashScope's OpenAI-compatible API. */
export class DashScopeChatFormatter extends DashScopeFormatterBase {
    constructor(options: DashScopeFormatterOptions = {}) {
        super(options);
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const formatted: Record<string, unknown>[] = [];
        for (const msg of msgs) {
            let content: DashScopeContent[] = [];
            let toolCalls: Record<string, unknown>[] = [];
            let thinking: string[] = [];
            const flush = (): void => {
                if (content.length === 0 && toolCalls.length === 0 && thinking.length === 0) return;
                const item: Record<string, unknown> = {
                    role: msg.role,
                    content: content.length > 0 ? content : null,
                };
                if (toolCalls.length > 0) item.tool_calls = toolCalls;
                if (thinking.length > 0) item.reasoning_content = thinking.join('\n');
                formatted.push(item);
                content = [];
                toolCalls = [];
                thinking = [];
            };

            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') content.push({ type: 'text', text: block.text });
                else if (block.type === 'data') {
                    const item = await this.formatDashScopeDataBlock(block);
                    if (item) content.push(item);
                } else if (block.type === 'hint') {
                    flush();
                    const hint: DashScopeContent[] = [];
                    if (typeof block.hint === 'string') {
                        hint.push({ type: 'text', text: block.hint });
                    } else {
                        for (const item of block.hint) {
                            if (item.type === 'text') hint.push({ type: 'text', text: item.text });
                            else {
                                const media = await this.formatDashScopeDataBlock(item);
                                if (media) hint.push(media);
                            }
                        }
                    }
                    if (hint.length > 0) formatted.push({ role: 'user', content: hint });
                } else if (block.type === 'tool_call') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: { name: block.name, arguments: block.input },
                    });
                } else if (block.type === 'thinking') {
                    if (this.supportsThinkingInput) thinking.push(block.thinking);
                } else if (block.type === 'tool_result') {
                    flush();
                    const [text, media] = this.convertToolResultToString(block.output);
                    formatted.push({
                        role: 'tool',
                        tool_call_id: block.id,
                        content: text,
                        name: block.name,
                    });
                    const promoted: DashScopeContent[] = [];
                    for (const item of media) {
                        if (item.type === 'text') promoted.push({ type: 'text', text: item.text });
                        else {
                            const data = await this.formatDashScopeDataBlock(item);
                            if (data) promoted.push(data);
                        }
                    }
                    if (promoted.length > 0) formatted.push({ role: 'user', content: promoted });
                }
            }
            flush();
        }
        return formatted;
    }
}

export interface DashScopeMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format attributed multi-agent histories for DashScope. */
export class DashScopeMultiAgentFormatter extends DashScopeFormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: DashScopeMultiAgentFormatterOptions = {}) {
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
                    ...(await new DashScopeChatFormatter({ inputTypes: this.inputTypes }).format({
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
        const media: DashScopeContent[] = [];
        for (const msg of msgs) {
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') text.push(`${msg.name}: ${block.text}`);
                else if (block.type === 'data') {
                    const item = await this.formatDashScopeDataBlock(block);
                    if (item) media.push(item);
                }
            }
        }
        const content: DashScopeContent[] = [];
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
