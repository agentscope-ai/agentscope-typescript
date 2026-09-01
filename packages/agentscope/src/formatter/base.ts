import type { DataBlock, TextBlock } from '../message/block';
import { createMsg } from '../message/message';
import type { Msg } from '../message/message';

/**
 * Base class for message formatters.
 */
export abstract class FormatterBase {
    /**
     * Format the input message objects into the required format by the API.
     *
     * @param root0
     * @param root0.msgs - An array of message objects to be formatted.
     * @returns A promise that resolves to an array of formatted message objects.
     */
    abstract format({ msgs }: { msgs: Array<Msg> }): Promise<Record<string, unknown>[]>;

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
                id: crypto.randomUUID(),
                type: 'text',
                text: `<${type}_data id='${id}'>`,
                created_at: new Date().toISOString(),
            });
            promotedBlocks.push(block);
            promotedBlocks.push({
                id: crypto.randomUUID(),
                type: 'text',
                text: `</${type}_data>\n`,
                created_at: new Date().toISOString(),
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
                    id: crypto.randomUUID(),
                    type: 'text',
                    text: `${prefix}`,
                    created_at: new Date().toISOString(),
                });
            }

            // The suffix
            const lastBlock = promotedBlocks[promotedBlocks.length - 1];
            if (lastBlock.type === 'text') {
                promotedBlocks[promotedBlocks.length - 1] = {
                    id: crypto.randomUUID(),
                    type: 'text',
                    text: `${lastBlock.text}</system-info>`,
                    created_at: new Date().toISOString(),
                };
            } else {
                promotedBlocks.push({
                    id: crypto.randomUUID(),
                    type: 'text',
                    text: `</system-info>`,
                    created_at: new Date().toISOString(),
                });
            }
        }

        return {
            text: textualOutput.join('\n'),
            promotedMsg: createMsg({ name: 'user', content: promotedBlocks, role: 'user' }),
        };
    }
}
