import { FormatterBase } from './base';
import { getContentBlocks } from '../message/message';
import type { Msg } from '../message/message';

interface DeepSeekFormatterOptions {
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
 * Format AgentScope message objects into DeepSeek Chat Completions message format.
 */
export class DeepSeekChatFormatter extends FormatterBase {
    private promoteMultimodalToolResult:
        | { image?: boolean; audio?: boolean; video?: boolean }
        | boolean;

    /**
     * Initializes a new instance of the DeepSeekChatFormatter class.
     * @param root0
     * @param root0.promoteMultimodalToolResult
     */
    constructor({ promoteMultimodalToolResult = false }: DeepSeekFormatterOptions = {}) {
        super();
        this.promoteMultimodalToolResult = promoteMultimodalToolResult;
    }

    /**
     * Format the input messages into the structure expected by DeepSeek Chat Completions API.
     * @param root0
     * @param root0.msgs
     * @returns An array of formatted message objects ready to be sent to the DeepSeek API.
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
                        content.push({
                            type: 'text',
                            text: block.text,
                        });
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
                        console.warn(
                            `DeepSeek models don't support multimodal data for now (2026-03), skip the data block in message content.`
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
}
