import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { fileURLToPath } from 'url';

import { FormatterBase } from './base';
import type { DataBlock, TextBlock } from '../message/block';
import { getContentBlocks } from '../message/message';
import type { Msg } from '../message/message';

interface OpenAIFormatterOptions {
    /**
     * Most LLM APIs don't support multimodal tool outputs, this option controls whether to
     * promote multimodal tool results to follow-up user messages.
     */
    promoteMultimodalToolResult?:
        | {
              image?: boolean;
              audio?: boolean;
              video?: boolean;
          }
        | boolean;
}

/**
 * Format AgentScope message objects into OpenAI Chat Completions message format.
 */
export class OpenAIChatFormatter extends FormatterBase {
    private promoteMultimodalToolResult:
        | { image?: boolean; audio?: boolean; video?: boolean }
        | boolean;

    /**
     * Initializes a new instance of the OpenAIChatFormatter class.
     * @param root0
     * @param root0.promoteMultimodalToolResult
     */
    constructor({ promoteMultimodalToolResult = false }: OpenAIFormatterOptions = {}) {
        super();
        this.promoteMultimodalToolResult = promoteMultimodalToolResult;
    }

    /**
     * Format the input messages into OpenAI Chat Completions message format.
     * @param root0
     * @param root0.msgs
     * @returns An array of formatted messages compatible with OpenAI Chat Completions API.
     */
    async format({ msgs }: { msgs: Array<Msg> }): Promise<Record<string, unknown>[]> {
        const formattedMsgs: Array<Record<string, unknown>> = [];
        let index = 0;

        while (index < msgs.length) {
            const msg = msgs[index];
            const formattedMsg: {
                role: string;
                name: string;
                content: Record<string, unknown>[] | null;
                tool_calls?: {
                    id: string;
                    type: 'function';
                    function: {
                        name: string;
                        arguments: string;
                    };
                }[];
            } = {
                role: msg.role,
                name: msg.name,
                content: null,
            };
            const content: Record<string, unknown>[] = [];

            // Cache tool-result messages to keep the sequence right after current message.
            const cachedMsgs: Record<string, unknown>[] = [];
            for (const block of getContentBlocks(msg)) {
                switch (block.type) {
                    case 'text':
                        content.push(this._formatTextBlock(block));
                        break;
                    case 'thinking':
                        break;
                    case 'tool_call':
                        if (!formattedMsg.tool_calls) {
                            formattedMsg.tool_calls = [];
                        }
                        formattedMsg.tool_calls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: block.input,
                            },
                        });
                        break;
                    case 'tool_result':
                        const formattedToolResult = this.convertToolOutputToString(
                            block.output,
                            this.promoteMultimodalToolResult
                        );
                        cachedMsgs.push({
                            role: 'tool',
                            tool_call_id: block.id,
                            name: block.name,
                            content: formattedToolResult.text,
                        });
                        if (formattedToolResult.promotedMsg?.content.length) {
                            msgs.splice(index + 1, 0, formattedToolResult.promotedMsg);
                        }
                        break;
                    case 'data':
                        content.push(
                            ...(await this._formatMultimodalBlock({ block, role: msg.role }))
                        );
                        break;
                }
            }

            if (content.length > 0) {
                formattedMsg.content = content;
            }
            if (formattedMsg.content || formattedMsg.tool_calls) {
                formattedMsgs.push(formattedMsg);
            }
            if (cachedMsgs.length > 0) {
                formattedMsgs.push(...cachedMsgs);
            }

            index++;
        }

        return formattedMsgs;
    }

    /**
     * Format a text block into OpenAI Chat Completions message content format.
     * @param block
     * @returns An object representing the formatted text block.
     */
    _formatTextBlock(block: TextBlock) {
        return {
            type: 'text',
            text: block.text,
        };
    }

    /**
     * Format a multimodal data block into OpenAI Chat Completions message content format.
     * @param root0
     * @param root0.block
     * @param root0.role
     * @returns The formatted content blocks
     */
    async _formatMultimodalBlock({
        block,
        role,
    }: {
        block: DataBlock;
        role: Msg['role'];
    }): Promise<Record<string, unknown>[]> {
        const type = block.source.media_type.split('/')[0];
        if (type === 'image') {
            return [
                {
                    type: 'image_url',
                    image_url: {
                        url: await this._toOpenAIImageURL(block),
                    },
                },
            ];
        }

        if (type === 'audio') {
            // Skip assistant output audio to avoid carrying generated audio back into next request.
            if (role === 'assistant') {
                return [];
            }
            return [
                {
                    type: 'input_audio',
                    input_audio: await this._toOpenAIAudioData(block),
                },
            ];
        }

        console.log(
            `Skip unsupported media type ${block.source.media_type} in OpenAIChatFormatter. Only image and audio are supported.`
        );
        return [];
    }

    /**
     * Convert the data block to an OpenAI compatible image URL.
     * @param block
     * @returns A promise that resolves to a string representing the image URL in a format compatible with OpenAI Chat Completions API.
     */
    protected async _toOpenAIImageURL(block: DataBlock): Promise<string> {
        if (block.source.type === 'base64') {
            return `data:${block.source.media_type};base64,${block.source.data}`;
        }

        const sourceUrl = block.source.url;
        if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
            return sourceUrl;
        }
        if (sourceUrl.startsWith('data:')) {
            return sourceUrl;
        }

        const localPath = this._toLocalPath(sourceUrl);
        if (!localPath || !existsSync(localPath)) {
            throw new Error(`Image path not found: ${sourceUrl}`);
        }

        const ext = extname(localPath).toLowerCase();
        const supportedImageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
        if (!supportedImageExtensions.includes(ext)) {
            throw new TypeError(
                `Unsupported image extension: ${ext}. Supported: ${supportedImageExtensions.join(', ')}`
            );
        }

        const file = await readFile(localPath);
        const mime = block.source.media_type || `image/${ext.slice(1)}`;
        return `data:${mime};base64,${file.toString('base64')}`;
    }

    /**
     * Converts a data block to OpenAI compatible audio data format.
     *
     * @param block - The data block containing audio information.
     * @returns A promise that resolves to an object with audio data and format.
     */
    protected async _toOpenAIAudioData(
        block: DataBlock
    ): Promise<{ data: string; format: 'wav' | 'mp3' }> {
        const supportedMediaTypes = new Map<string, 'wav' | 'mp3'>([
            ['audio/wav', 'wav'],
            ['audio/mp3', 'mp3'],
            ['audio/mpeg', 'mp3'],
        ]);

        if (block.source.type === 'base64') {
            const format = supportedMediaTypes.get(block.source.media_type);
            if (!format) {
                throw new TypeError(
                    `Unsupported audio media type: ${block.source.media_type}, only audio/wav and audio/mp3 are supported.`
                );
            }
            return { data: block.source.data, format };
        }

        const sourceUrl = block.source.url;
        const localPath = this._toLocalPath(sourceUrl);
        let data: string;

        if (localPath && existsSync(localPath)) {
            const file = await readFile(localPath);
            data = file.toString('base64');
        } else if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
            const response = await fetch(sourceUrl);
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch audio from URL: ${sourceUrl} (${response.status})`
                );
            }
            const arr = await response.arrayBuffer();
            data = Buffer.from(arr).toString('base64');
        } else {
            throw new Error(
                `Unsupported audio source: ${sourceUrl}, it should be a local file path, file URL, or an HTTP URL.`
            );
        }

        const ext = extname(localPath || sourceUrl).toLowerCase();
        const extToFormat = new Map<string, 'wav' | 'mp3'>([
            ['.wav', 'wav'],
            ['.mp3', 'mp3'],
        ]);
        const format = extToFormat.get(ext);
        if (!format) {
            throw new TypeError(`Unsupported audio extension: ${ext}, wav and mp3 are supported.`);
        }

        return { data, format };
    }

    /**
     * Converts a URL or path to a local file path.
     *
     * @param urlOrPath - The URL or path to convert.
     * @returns The local file path, or null if not a local path.
     */
    protected _toLocalPath(urlOrPath: string) {
        if (urlOrPath.startsWith('file://')) {
            return fileURLToPath(urlOrPath);
        }
        if (!urlOrPath.includes('://')) {
            return urlOrPath;
        }
        return null;
    }
}
