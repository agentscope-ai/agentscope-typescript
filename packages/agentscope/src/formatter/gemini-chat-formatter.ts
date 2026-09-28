import { FormatterBase } from './base';
import type { ContentBlock, DataBlock } from '../message/block';
import { getContentBlocks } from '../message/message';
import type { Msg } from '../message/message';

/** Gemini REST content part, including the signature needed for history replay. */
export interface GeminiPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
    functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
    inlineData?: { mimeType: string; data: string };
    fileData?: { mimeType: string; fileUri: string };
}

/** Converts AgentScope messages to Gemini's native contents format. */
export class GeminiChatFormatter extends FormatterBase {
    /**
     * Format messages without mutating the caller's conversation.
     * @param root0
     * @param root0.msgs
     * @returns The formatted or accumulated result.
     */
    async format({ msgs }: { msgs: Msg[] }): Promise<Record<string, unknown>[]> {
        const result: { role: string; parts: GeminiPart[] }[] = [];
        const append = (role: string, parts: GeminiPart[]) => {
            if (!parts.length) return;
            const last = result.at(-1);
            // Parallel function responses must stay in one user turn.
            if (last?.role === role) last.parts.push(...parts);
            else result.push({ role, parts });
        };
        for (const msg of msgs) {
            const role = msg.role === 'assistant' ? 'model' : msg.role;
            for (const block of getContentBlocks(msg)) {
                if (block.type === 'tool_result') {
                    const { text } = this.convertToolOutputToString(block.output, false);
                    append('user', [
                        {
                            functionResponse: {
                                name: block.name,
                                id: block.id,
                                response:
                                    block.state === 'error' ? { error: text } : { output: text },
                            },
                        },
                    ]);
                } else if (block.type === 'hint') {
                    append(
                        'user',
                        typeof block.hint === 'string'
                            ? [{ text: block.hint }]
                            : block.hint.map(b => this.formatPart(b)).filter(p => p !== null)
                    );
                } else {
                    const part = this.formatPart(block);
                    if (part) append(role, [part]);
                }
            }
        }
        return result;
    }

    /**
     * Format one content block and preserve its opaque provider signature.
     * @param block
     * @returns The formatted or accumulated result.
     */
    private formatPart(block: ContentBlock): GeminiPart | null {
        let part: GeminiPart;
        switch (block.type) {
            case 'text':
                part = { text: block.text };
                break;
            case 'thinking':
                // Unsigned thought summaries are not user-facing conversation text.
                if (!block.thought_signature) return null;
                part = { text: block.thinking, thought: true };
                break;
            case 'tool_call': {
                const args: unknown = JSON.parse(block.input || '{}');
                if (!args || typeof args !== 'object' || Array.isArray(args)) {
                    throw new Error(
                        `Gemini tool arguments for ${block.name} must be a JSON object`
                    );
                }
                part = {
                    functionCall: {
                        name: block.name,
                        args: args as Record<string, unknown>,
                        id: block.id,
                    },
                };
                break;
            }
            case 'data':
                part = this.formatData(block);
                break;
            default:
                return null;
        }
        if ('thought_signature' in block && typeof block.thought_signature === 'string') {
            part.thoughtSignature = block.thought_signature;
        }
        return part;
    }

    /**
     * Convert inline data or a Gemini Files API URI to a native data part.
     * @param block
     * @returns The formatted or accumulated result.
     */
    private formatData(block: DataBlock): GeminiPart {
        return block.source.type === 'base64'
            ? { inlineData: { mimeType: block.source.media_type, data: block.source.data } }
            : { fileData: { mimeType: block.source.media_type, fileUri: block.source.url } };
    }
}
