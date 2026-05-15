import { FormatterBase } from './base';
import { Msg, TextBlock, getContentBlocks } from '../message';
import { DataBlock } from '../message';

interface DashScopeFormatterOptions {
    /**
     * Since DashScope API doesn't support multimodal tool outputs, this option indicates whether to
     * promote the multimodal tool results to the prompt messages, so that LLMs can see them.
     * Note you should ensure your model supports the corresponding modalities.
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
 *
 */
export class DashScopeChatFormatter extends FormatterBase {
    private promoteMultimodalToolResult:
        | { image?: boolean; audio?: boolean; video?: boolean }
        | boolean;

    /**
     * Initialize a DashScopeChatFormatter instance.
     *
     * @param promoteMultimodalToolResult - Since DashScope API doesn't support multimodal tool outputs, this option
     *  indicates whether to promote the multimodal tool results to the prompt messages, so that LLMs can see them.
     *  Note you should ensure your model supports the corresponding modalities.
     * @param promoteMultimodalToolResult.promoteMultimodalToolResult
     */
    constructor({ promoteMultimodalToolResult = false }: DashScopeFormatterOptions = {}) {
        super();
        this.promoteMultimodalToolResult = promoteMultimodalToolResult;
    }

    /**
     * Format the input message objects into the required format by DashScope API.
     *
     * @param msgs - An array of Msg instances to be formatted.
     * @param msgs.msgs
     * @returns A promise that resolves to an array of formatted message objects.
     */
    async format({ msgs }: { msgs: Array<Msg> }): Promise<Record<string, unknown>[]> {
        const formattedMsgs: Array<Record<string, unknown>> = [];
        let index = 0;
        while (index < msgs.length) {
            const msg = msgs[index];
            const formattedMsg: {
                role: string;
                content: Record<string, unknown>[];
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
                content: [],
            };

            // The cached messages that should be pushed after the current message, to keep the order of messages correct.
            const cachedMsgs = [];
            for (const block of getContentBlocks(msg)) {
                switch (block.type) {
                    case 'text':
                        formattedMsg.content.push(this._formatTextBlock(block));
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
                        if (formattedToolResult.promotedMsg) {
                            // Insert the promoted message into the array as the next message to be processed
                            msgs.splice(index + 1, 0, formattedToolResult.promotedMsg);
                        }
                        break;
                    case 'data':
                        formattedMsg.content.push(...this._formatMultimodalBlock(block));
                        break;
                }
            }
            if (formattedMsg.content.length > 0 || formattedMsg.tool_calls) {
                formattedMsgs.push(formattedMsg);
            }
            if (cachedMsgs.length > 0) {
                formattedMsgs.push(...cachedMsgs);
            }

            // Process next message
            index++;
        }
        return formattedMsgs;
    }

    /**
     * Format a text content block into the required format.
     *
     * @param block - The text content block to format.
     * @returns An object representing the formatted text content.
     */
    _formatTextBlock(block: TextBlock) {
        return { text: block.text };
    }

    /**
     * Format a multimodal data block into the required format.
     * In DashScope API, the local file paths should be prefixed with "file://". URLs are kept unchanged.
     *
     * @param block - The multimodal content block to format.
     * @returns An object representing the formatted multimodal content.
     */
    _formatMultimodalBlock(block: DataBlock) {
        const type = block.source.media_type.split('/')[0];

        if (!['image', 'audio', 'video'].includes(type)) {
            console.log(
                `Skip unsupported media type ${block.source.media_type} in DashScopeChatFormatter. Only image, audio and video are supported.`
            );
            return [];
        }

        if (block.source.type === 'url') {
            return [{ [type]: block.source.url }];
        }

        return [
            {
                [type]: `data:${block.source.media_type};base64,${block.source.data}`,
            },
        ];
    }
}
