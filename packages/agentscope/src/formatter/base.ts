/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { extension } from 'mime-types';
import { minimatch } from 'minimatch';

import { _generateId, _generateTimestamp } from '../_utils/common';
import { TextBlock as createTextBlock } from '../message/block';
import type { DataBlock, TextBlock } from '../message/block';
import { createMsg } from '../message/message';
import { getContentBlocks } from '../message/message';
import type { Msg } from '../message/message';

export interface FormatterOptions {
    inputTypes?: string[];
}

export type MessageGroup = ['tool_sequence' | 'agent_message', Msg[]];

/**
 * Base class for message formatters.
 */
export abstract class FormatterBase {
    /** MIME patterns accepted by this formatter. */
    readonly inputTypes: string[];

    /**
     *
     * @param options
     */
    constructor(options: FormatterOptions = {}) {
        this.inputTypes = options.inputTypes ?? ['text/plain'];
    }

    /** Media patterns accepted in addition to text and thinking blocks. */
    get supportedInputMediaTypes(): string[] {
        return this.inputTypes.filter(type => {
            return type !== 'text/plain' && type !== 'application/x-thinking';
        });
    }

    /**
     * Format the input message objects into the required format by the API.
     *
     * @param root0
     * @param root0.msgs - An array of message objects to be formatted.
     * @returns A promise that resolves to an array of formatted message objects.
     */
    abstract format({ msgs }: { msgs: Array<Msg> }): Promise<Record<string, unknown>[]>;

    /**
     * Validate the formatter input before provider-specific conversion.
     * @param msgs
     */
    static assertListOfMsgs(msgs: Msg[]): void {
        if (!Array.isArray(msgs)) throw new TypeError('Input must be a list of Msg objects.');
        for (const msg of msgs) {
            if (!isMsg(msg)) {
                throw new TypeError(`Expected Msg object, got ${typeof msg} instead.`);
            }
        }
    }

    /**
     * Convert a Python-compatible tool result and promote supported media.
     * @param output
     */
    convertToolResultToString(
        output: string | (TextBlock | DataBlock)[]
    ): [string, (TextBlock | DataBlock)[]] {
        if (typeof output === 'string') return [output, []];

        const textualOutput: string[] = [];
        let multimodalData: (TextBlock | DataBlock)[] = [];
        for (const block of output) {
            if (block.type === 'text') {
                textualOutput.push(block.text);
                continue;
            }

            const mainType = block.source.media_type.split('/')[0];
            const supported = this.supportedInputMediaTypes.some(pattern => {
                return minimatch(block.source.media_type, pattern);
            });
            if (supported) {
                textualOutput.push(
                    `<system-reminder>A(n) ${mainType} file is returned and will be ` +
                        `presented to you with the identifier [${block.id}].</system-reminder>`
                );
                multimodalData.push(
                    createTextBlock({ text: `- ${block.id} (${mainType} file): ` }),
                    block
                );
            } else {
                textualOutput.push(this.convertUnsupportedDataBlockToString(block));
            }
        }

        if (multimodalData.length > 0) {
            multimodalData = [
                createTextBlock({
                    text: '<system-reminder>The multimodal data and their identifiers are listed as follows:',
                }),
                ...multimodalData,
                createTextBlock({ text: '</system-reminder>' }),
            ];
        }
        return [textualOutput.join('\n'), multimodalData];
    }

    /**
     * Group consecutive tool traffic separately from ordinary agent messages.
     * @param msgs
     */
    protected async *groupMessages(msgs: Msg[]): AsyncGenerator<MessageGroup> {
        let groupType: MessageGroup[0] | null = null;
        let group: Msg[] = [];
        for (const msg of msgs) {
            const isToolSequence = getContentBlocks(msg).some(block => {
                return block.type === 'tool_call' || block.type === 'tool_result';
            });
            const nextType = isToolSequence ? 'tool_sequence' : 'agent_message';
            if (groupType === null || groupType === nextType) {
                groupType = nextType;
                group.push(msg);
            } else {
                yield [groupType, group];
                groupType = nextType;
                group = [msg];
            }
        }
        if (groupType !== null) yield [groupType, group];
    }

    /**
     *
     * @param block
     */
    protected convertUnsupportedDataBlockToString(block: DataBlock): string {
        const mainType = block.source.media_type.split('/')[0];
        if (block.source.type === 'url') {
            return (
                `<system-reminder>A(n) ${mainType} file is returned and can be accessed ` +
                `at the URL: ${block.source.url}.</system-reminder>`
            );
        }
        const suffix = extension(block.source.media_type);
        const directory = mkdtempSync(join(tmpdir(), 'agentscope-'));
        const path = join(directory, `tool-result${suffix ? `.${suffix}` : ''}`);
        writeFileSync(path, Buffer.from(block.source.data, 'base64'));
        return (
            `<system-reminder>A(n) ${mainType} file is returned and saved locally at: ` +
            `${path}.</system-reminder>`
        );
    }

    /**
     * Convert the tool output to string format for the LLM APIs that only accept text input. If
     * `promoteMultimodalToolResult` is true, the multimodal content will be promoted to be a user message with
     * "<system-info></system-info>" tags. Otherwise, the multimodal content will be saved to a storage and a URL link
     * will be provided in the text output.
     *
     * @param output - The tool output, which can be a string or an array of content blocks.
     * @param promoteMultimodalToolResult - Whether to promote the multimodal content to the prompt messages.
     * @returns An object containing the text output and an optional promoted message.
     */
    convertToolOutputToString(
        output: string | (TextBlock | DataBlock)[],
        promoteMultimodalToolResult: boolean | { image?: boolean; audio?: boolean; video?: boolean }
    ) {
        if (typeof output === 'string') return { text: output, promotedMsg: null };

        let textualOutput = [];

        const promotedData: { id: string; block: DataBlock }[] = [];

        for (const block of output) {
            switch (block.type) {
                case 'text':
                    textualOutput.push(block.text);
                    break;
                default:
                    const type = block.source.media_type.split('/')[0];
                    if (type !== 'image' && type !== 'audio' && type !== 'video') {
                        console.log(
                            `Unsupported media type '${block.source.media_type}' in tool output. Only image, audio and video are supported.`
                        );
                        break;
                    }
                    if (block.source.type === 'url') {
                        textualOutput.push(
                            `<system-info>One returned ${type} can be found at: ${block.source.url}</system-info>`
                        );
                    } else {
                        // If we should promote the multimodal content to the prompt messages
                        const shouldPromote =
                            promoteMultimodalToolResult === true ||
                            (typeof promoteMultimodalToolResult === 'object' &&
                                promoteMultimodalToolResult[type]);

                        if (shouldPromote) {
                            // Create an ID for the multimodal content first, which should less than 10 characters
                            const dataID = Math.random().toString(36).substring(2, 10);
                            textualOutput.push(
                                `<system-info>One returned ${type} is embedded with ID '${dataID}' and will be attached within '<system-info></system-info>' tags later.</system-info>`
                            );

                            // Record the promoted data
                            promotedData.push({ id: dataID, block });
                        } else {
                            // TODO: save locally

                            // Save to storage and provide URL link
                            textualOutput.push(`The returned ${block.type} is stored locally.`);
                        }
                    }
            }
        }

        // Attach prefix and suffix system-info tags if there are promoted blocks
        const promotedBlocks: (TextBlock | DataBlock)[] = [];
        promotedData.forEach(({ id, block }) => {
            const type = block.source.media_type.split('/')[0];
            promotedBlocks.push({
                id: _generateId(),
                type: 'text',
                text: `<${type}_data id='${id}'>`,
                created_at: _generateTimestamp(),
            });
            promotedBlocks.push(block);
            promotedBlocks.push({
                id: _generateId(),
                type: 'text',
                text: `</${type}_data>\n`,
                created_at: _generateTimestamp(),
            });
        });

        if (promotedBlocks.length > 0) {
            // The prefix
            const prefix =
                '<system-info>The multimodal contents returned from the tool call are as follows:\n';

            if (promotedBlocks[0].type === 'text') {
                promotedBlocks[0].text = `${prefix}${promotedBlocks[0].text}`;
            } else {
                promotedBlocks.unshift({
                    id: _generateId(),
                    type: 'text',
                    text: `${prefix}`,
                    created_at: _generateTimestamp(),
                });
            }

            // The suffix
            const lastBlock = promotedBlocks[promotedBlocks.length - 1];
            if (lastBlock.type === 'text') {
                promotedBlocks[promotedBlocks.length - 1] = {
                    id: _generateId(),
                    type: 'text',
                    text: `${lastBlock.text}</system-info>`,
                    created_at: _generateTimestamp(),
                };
            } else {
                promotedBlocks.push({
                    id: _generateId(),
                    type: 'text',
                    text: `</system-info>`,
                    created_at: _generateTimestamp(),
                });
            }
        }

        return {
            text: textualOutput.join('\n'),
            promotedMsg: createMsg({ name: 'user', content: promotedBlocks, role: 'user' }),
        };
    }
}

/**
 *
 * @param value
 */
function isMsg(value: unknown): value is Msg {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<Msg>;
    return (
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.role === 'string' &&
        Array.isArray(candidate.content)
    );
}
