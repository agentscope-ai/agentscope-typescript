/* eslint-disable jsdoc/require-jsdoc */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

import { FormatterBase } from './base';
import type { FormatterOptions } from './base';
import type { DataBlock, Msg, TextBlock, ToolCallBlock } from '../message';
import { getContentBlocks, getTextContent } from '../message';

export interface XAIImage {
    type: 'image';
    url: string;
}

export interface XAIToolCall {
    id: string;
    type: 'client_side_tool';
    function: { name: string; arguments: string };
}

export type XAIMessage =
    | {
          role: 'system' | 'user' | 'assistant';
          args: Array<string | XAIImage>;
      }
    | {
          role: 'assistant';
          content: Array<{ text: string }>;
          tool_calls: XAIToolCall[];
      }
    | {
          role: 'tool';
          args: [string];
          tool_call_id: string;
      };

/** TypeScript representation of xAI's protobuf chat messages. */
export class XAIChatFormatter extends FormatterBase {
    constructor(options: FormatterOptions = {}) {
        super({
            inputTypes: options.inputTypes ?? ['text/plain', 'image/jpeg', 'image/png'],
        });
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<XAIMessage[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const messages: XAIMessage[] = [];
        for (const msg of msgs) {
            const blocks = getContentBlocks(msg);
            if (msg.role === 'system') {
                messages.push({
                    role: 'system',
                    args: [
                        blocks
                            .filter(block => block.type === 'text')
                            .map(block => block.text)
                            .join('\n'),
                    ],
                });
            } else if (msg.role === 'user') {
                let args: Array<string | XAIImage> = [];
                const flush = (): void => {
                    if (args.length > 0) messages.push({ role: 'user', args });
                    args = [];
                };
                for (const block of blocks) {
                    if (block.type === 'hint') {
                        flush();
                        if (typeof block.hint === 'string') {
                            messages.push({ role: 'user', args: [block.hint] });
                        } else {
                            const hint = await this.userArgsFromBlocks(block.hint);
                            if (hint.length > 0) messages.push({ role: 'user', args: hint });
                        }
                    } else if (block.type === 'text') args.push(block.text);
                    else if (block.type === 'data') {
                        const image = await this.formatImage(block);
                        if (image) args.push(image);
                    }
                }
                flush();
            } else {
                let text: TextBlock[] = [];
                let calls: ToolCallBlock[] = [];
                const flush = (): void => {
                    if (calls.length > 0) messages.push(this.toolCallMessage(text, calls));
                    else if (text.length > 0) {
                        const value = text.map(block => block.text).join('\n');
                        if (value) messages.push({ role: 'assistant', args: [value] });
                    }
                    text = [];
                    calls = [];
                };
                for (const block of blocks) {
                    if (block.type === 'tool_result') {
                        flush();
                        messages.push({
                            role: 'tool',
                            args: [this.extractResultText(block.output)],
                            tool_call_id: block.id,
                        });
                    } else if (block.type === 'tool_call') calls.push(block);
                    else if (block.type === 'text') text.push(block);
                    else if (block.type === 'hint') {
                        flush();
                        if (typeof block.hint === 'string') {
                            messages.push({ role: 'user', args: [block.hint] });
                        } else {
                            const hint = await this.userArgsFromBlocks(block.hint);
                            if (hint.length > 0) messages.push({ role: 'user', args: hint });
                        }
                    }
                }
                flush();
            }
        }
        return messages;
    }

    private toolCallMessage(text: TextBlock[], calls: ToolCallBlock[]): XAIMessage {
        const value = text.map(block => block.text).join('\n');
        return {
            role: 'assistant',
            content: value ? [{ text: value }] : [],
            tool_calls: calls.map(call => ({
                id: call.id,
                type: 'client_side_tool',
                function: { name: call.name, arguments: call.input },
            })),
        };
    }

    private async userArgsFromBlocks(
        blocks: Array<TextBlock | DataBlock>
    ): Promise<Array<string | XAIImage>> {
        const args: Array<string | XAIImage> = [];
        for (const block of blocks) {
            if (block.type === 'text') args.push(block.text);
            else {
                const image = await this.formatImage(block);
                if (image) args.push(image);
            }
        }
        return args;
    }

    private async formatImage(block: DataBlock): Promise<XAIImage | null> {
        if (!block.source.media_type.startsWith('image/')) {
            console.warn(
                `Unsupported media type ${block.source.media_type} for xAI API. ` +
                    'Only image/jpeg and image/png are supported. This block will be skipped.'
            );
            return null;
        }
        let url: string;
        if (block.source.type === 'base64') {
            url = `data:${block.source.media_type};base64,${block.source.data}`;
        } else if (block.source.url.startsWith('file://')) {
            const data = await readFile(fileURLToPath(block.source.url));
            url = `data:${block.source.media_type};base64,${data.toString('base64')}`;
        } else url = block.source.url;
        return { type: 'image', url };
    }

    private extractResultText(output: string | Array<TextBlock | DataBlock>): string {
        if (typeof output === 'string') return output;
        return output
            .map(item => (item.type === 'text' ? item.text : JSON.stringify(item)))
            .join('\n');
    }
}

export interface XAIMultiAgentFormatterOptions extends FormatterOptions {
    conversationHistoryPrompt?: string;
}

/** Format attributed multi-agent histories for xAI. */
export class XAIMultiAgentFormatter extends FormatterBase {
    readonly conversationHistoryPrompt: string;

    constructor(options: XAIMultiAgentFormatterOptions = {}) {
        super({
            inputTypes: options.inputTypes ?? ['text/plain', 'image/jpeg', 'image/png'],
        });
        this.conversationHistoryPrompt =
            options.conversationHistoryPrompt ??
            '# Conversation History\n' +
                'The content between <history></history> tags contains your conversation history\n';
    }

    async format({ msgs }: { msgs: Msg[] }): Promise<XAIMessage[]> {
        FormatterBase.assertListOfMsgs(msgs);
        const messages: XAIMessage[] = [];
        let startIndex = 0;
        if (msgs[0]?.role === 'system') {
            messages.push({ role: 'system', args: [getTextContent(msgs[0]) ?? ''] });
            startIndex = 1;
        }
        let isFirst = true;
        for await (const [type, group] of this.groupMessages(msgs.slice(startIndex))) {
            if (type === 'tool_sequence') {
                messages.push(
                    ...(await new XAIChatFormatter({ inputTypes: this.inputTypes }).format({
                        msgs: group,
                    }))
                );
            } else {
                const history = this.buildHistoryText(group, isFirst);
                if (history) messages.push({ role: 'user', args: [history] });
                isFirst = false;
            }
        }
        return messages;
    }

    private buildHistoryText(msgs: Msg[], isFirst: boolean): string {
        const lines: string[] = [];
        for (const msg of msgs) {
            const parts: string[] = [];
            if (msg.name) parts.push(`${msg.name}:`);
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'text') parts.push(block.text);
            }
            if (parts.length > 0) lines.push(parts.join(' '));
        }
        if (lines.length === 0) return '';
        const prefix = isFirst ? this.conversationHistoryPrompt : '';
        return `${prefix}<history>\n${lines.join('\n')}\n</history>`;
    }
}
