import type Anthropic from '@anthropic-ai/sdk';

import { DataBlock, Msg, TextBlock, ToolResultBlock, getContentBlocks } from '../message';
import { FormatterBase } from './base';

/**
 * Format AgentScope messages for the Anthropic Messages API.
 */
export class AnthropicChatFormatter extends FormatterBase {
    /**
     * Format AgentScope messages into Anthropic message objects.
     *
     * System messages are kept in the returned array and moved to the top-level
     * `system` request parameter by {@link AnthropicChatModel}.
     *
     * @param root0
     * @param root0.msgs
     * @returns Messages compatible with the Anthropic Messages API.
     */
    async format({ msgs }: { msgs: Array<Msg> }): Promise<Record<string, unknown>[]> {
        const formattedMsgs: Anthropic.MessageParam[] = [];

        for (const msg of msgs) {
            const content: Anthropic.ContentBlockParam[] = [];
            const toolResults: Anthropic.ToolResultBlockParam[] = [];

            for (const block of getContentBlocks(msg)) {
                switch (block.type) {
                    case 'text':
                        content.push(this._formatTextBlock(block));
                        break;
                    case 'thinking':
                        // Thinking blocks cannot be sent back without their signature.
                        break;
                    case 'tool_call':
                        content.push({
                            type: 'tool_use',
                            id: block.id,
                            name: block.name,
                            input: this._parseToolInput(block.input),
                        });
                        break;
                    case 'tool_result':
                        toolResults.push(this._formatToolResultBlock(block));
                        break;
                    case 'data': {
                        const dataBlock = this._formatDataBlock(block);
                        if (dataBlock) {
                            content.push(dataBlock);
                        }
                        break;
                    }
                    case 'hint':
                        break;
                }
            }

            if (content.length > 0) {
                formattedMsgs.push({
                    role: msg.role,
                    content,
                });
            }

            // Anthropic requires tool results to be sent in a user message.
            if (toolResults.length > 0) {
                formattedMsgs.push({
                    role: 'user',
                    content: toolResults,
                });
            }
        }

        return formattedMsgs as unknown as Record<string, unknown>[];
    }

    /**
     * Format a text block.
     *
     * @param block
     * @returns An Anthropic text block.
     */
    _formatTextBlock(block: TextBlock): Anthropic.TextBlockParam {
        return {
            type: 'text',
            text: block.text,
        };
    }

    /**
     * Parse a serialized AgentScope tool input.
     *
     * @param input
     * @returns The parsed tool input.
     */
    protected _parseToolInput(input: string): unknown {
        try {
            return JSON.parse(input || '{}');
        } catch {
            throw new TypeError(`Invalid JSON input for Anthropic tool call: ${input}`);
        }
    }

    /**
     * Format a tool result block.
     *
     * @param block
     * @returns An Anthropic tool result block.
     */
    protected _formatToolResultBlock(block: ToolResultBlock): Anthropic.ToolResultBlockParam {
        const { text } = this.convertToolOutputToString(block.output, false);
        return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: text,
            is_error: ['error', 'interrupted', 'denied'].includes(block.state),
        };
    }

    /**
     * Format supported image data.
     *
     * @param block
     * @returns An Anthropic image block, or null for unsupported media.
     */
    protected _formatDataBlock(block: DataBlock): Anthropic.ImageBlockParam | null {
        if (!block.source.media_type.startsWith('image/')) {
            console.log(
                `Skip unsupported media type ${block.source.media_type} in AnthropicChatFormatter. Only images are supported.`
            );
            return null;
        }

        if (block.source.type === 'url') {
            return {
                type: 'image',
                source: {
                    type: 'url',
                    url: block.source.url,
                },
            };
        }

        const supportedMediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
        if (
            !supportedMediaTypes.includes(
                block.source.media_type as (typeof supportedMediaTypes)[number]
            )
        ) {
            throw new TypeError(
                `Unsupported Anthropic image media type: ${block.source.media_type}`
            );
        }

        return {
            type: 'image',
            source: {
                type: 'base64',
                media_type: block.source.media_type as (typeof supportedMediaTypes)[number],
                data: block.source.data,
            },
        };
    }
}
