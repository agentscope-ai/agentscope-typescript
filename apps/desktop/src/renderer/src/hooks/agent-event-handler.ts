import { EventType, type AgentEvent } from '@agentscope-ai/agentscope/event';
import { createMsg, appendEvent, Msg } from '@agentscope-ai/agentscope/message';
import type { Dispatch, SetStateAction } from 'react';

export interface StreamingMsg extends Msg {
    streaming?: boolean;
}

/**
 * Applies an agent event to update message and sending state.
 * @param event
 * @param setMessages
 * @param setSending
 */
export function applyAgentEvent(
    event: AgentEvent,
    setMessages: Dispatch<SetStateAction<StreamingMsg[]>>,
    setSending: Dispatch<SetStateAction<boolean>>
) {
    switch (event.type) {
        case EventType.REPLY_START: {
            setSending(true);
            setMessages(prev => {
                const existingMsg = prev.find(m => m.id === event.reply_id);
                if (existingMsg) {
                    return prev.map(m => (m.id === event.reply_id ? { ...m, streaming: true } : m));
                }
                const newMsg: StreamingMsg = {
                    ...createMsg({
                        id: event.reply_id,
                        role: event.role,
                        name: event.name,
                        content: [],
                    }),
                    streaming: true,
                };
                return [...prev, newMsg];
            });
            break;
        }

        case EventType.REPLY_END: {
            setSending(false);
            setMessages(prev => {
                return prev.map(m => {
                    if (m.id !== event.reply_id) return m;
                    const cloned: StreamingMsg = { ...m, content: m.content.map(b => ({ ...b })) };
                    appendEvent(cloned, event);
                    return { ...cloned, streaming: false };
                });
            });
            break;
        }

        case EventType.MODEL_CALL_START:
            break;

        case EventType.MODEL_CALL_END: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id) return m;
                    const currentUsage = m.usage || {
                        inputTokens: 0,
                        outputTokens: 0,
                    };
                    return {
                        ...m,
                        usage: {
                            inputTokens: currentUsage.inputTokens + event.input_tokens,
                            outputTokens: currentUsage.outputTokens + event.output_tokens,
                        },
                    };
                })
            );
            break;
        }

        default: {
            if (!('reply_id' in event)) break;
            setMessages(prev => {
                return prev.map(m => {
                    if (m.id !== event.reply_id) return m;
                    // Deep clone content blocks to avoid mutation side effects
                    // (React Strict Mode calls updaters twice to detect impure functions)
                    // tool_result blocks need their output array deep-cloned too
                    const cloned: StreamingMsg = {
                        ...m,
                        content: m.content.map(b => {
                            if (b.type === 'tool_result') {
                                return {
                                    ...b,
                                    output:
                                        typeof b.output === 'string'
                                            ? b.output
                                            : b.output.map(o => ({ ...o })),
                                };
                            }
                            return { ...b };
                        }),
                    };
                    appendEvent(cloned, event);
                    return cloned;
                });
            });
        }
    }
}
