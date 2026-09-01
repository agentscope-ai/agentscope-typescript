import { FormatterBase } from './base';
import { getContentBlocks, getTextContent } from '../message/message';
import type { Msg } from '../message/message';

/**
 * Format AgentScope message objects into Ollama Chat message format.
 * Ollama expects simple string content, not the multimodal array format.
 */
export class OllamaChatFormatter extends FormatterBase {
    // eslint-disable-next-line jsdoc/require-returns
    /**
     * Format messages for Ollama API
     * @param root0
     * @param root0.msgs
     */
    async format({ msgs }: { msgs: Array<Msg> }): Promise<Record<string, unknown>[]> {
        const formattedMsgs: Array<Record<string, unknown>> = [];

        for (const msg of msgs) {
            const formattedMsg: {
                role: string;
                content: string;
                tool_calls?: {
                    function: {
                        name: string;
                        arguments: Record<string, unknown>;
                    };
                }[];
            } = {
                role: msg.role,
                content: '',
            };

            // Extract text content
            const textContent = getTextContent(msg);
            if (textContent) {
                formattedMsg.content = textContent;
            }

            // Handle tool calls
            const toolCalls = getContentBlocks(msg, 'tool_call');
            if (toolCalls.length > 0) {
                formattedMsg.tool_calls = toolCalls.map(toolCall => ({
                    function: {
                        name: toolCall.name,
                        arguments: JSON.parse(toolCall.input),
                    },
                }));
            }

            // Handle tool results
            const toolResults = getContentBlocks(msg, 'tool_result');
            for (const toolResult of toolResults) {
                const resultText = this.convertToolOutputToString(toolResult.output, false);
                formattedMsgs.push({
                    role: 'tool',
                    content: resultText.text,
                });
            }

            if (formattedMsg.content || formattedMsg.tool_calls) {
                formattedMsgs.push(formattedMsg);
            }
        }

        return formattedMsgs;
    }
}
