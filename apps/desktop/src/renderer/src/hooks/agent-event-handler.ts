import { EventType, type AgentEvent } from '@agentscope-ai/agentscope/event';
import { createMsg, Msg, ToolResultBlock } from '@agentscope-ai/agentscope/message';
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
            setMessages(prev =>
                prev.map(m => (m.id === event.reply_id ? { ...m, streaming: false } : m))
            );
            break;
        }

        case EventType.MODEL_CALL_START:
            break;

        case EventType.MODEL_CALL_END: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id) return m;
                    const currentUsage = m.usage || { inputTokens: 0, outputTokens: 0 };
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

        case EventType.TEXT_BLOCK_START: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    if (m.content.find(b => b.type === 'text' && b.id === event.block_id)) return m;
                    return {
                        ...m,
                        content: [...m.content, { type: 'text', id: event.block_id, text: '' }],
                    };
                })
            );
            break;
        }

        case EventType.TEXT_BLOCK_DELTA: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    return {
                        ...m,
                        content: m.content.map(b =>
                            b.type === 'text' && b.id === event.block_id
                                ? { ...b, text: b.text + event.delta }
                                : b
                        ),
                    };
                })
            );
            break;
        }

        case EventType.TEXT_BLOCK_END:
            break;

        case EventType.THINKING_BLOCK_START: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    if (m.content.find(b => b.type === 'thinking' && b.id === event.block_id))
                        return m;
                    return {
                        ...m,
                        content: [
                            ...m.content,
                            { type: 'thinking', id: event.block_id, thinking: '' },
                        ],
                    };
                })
            );
            break;
        }

        case EventType.THINKING_BLOCK_DELTA: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    return {
                        ...m,
                        content: m.content.map(b =>
                            b.type === 'thinking' && b.id === event.block_id
                                ? { ...b, thinking: b.thinking + event.delta }
                                : b
                        ),
                    };
                })
            );
            break;
        }

        case EventType.THINKING_BLOCK_END:
            break;

        case EventType.DATA_BLOCK_START: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    if (m.content.find(b => b.type === 'data' && b.id === event.block_id)) return m;
                    return {
                        ...m,
                        content: [
                            ...m.content,
                            {
                                type: 'data',
                                id: event.block_id,
                                source: { type: 'base64', data: '', media_type: event.media_type },
                            },
                        ],
                    };
                })
            );
            break;
        }

        case EventType.DATA_BLOCK_DELTA: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    return {
                        ...m,
                        content: m.content.map(b => {
                            if (
                                b.type === 'data' &&
                                b.id === event.block_id &&
                                b.source.type === 'base64'
                            ) {
                                return {
                                    ...b,
                                    source: { ...b.source, data: b.source.data + event.data },
                                };
                            }
                            return b;
                        }),
                    };
                })
            );
            break;
        }

        case EventType.DATA_BLOCK_END:
            break;

        case EventType.TOOL_CALL_START: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    if (m.content.find(b => b.type === 'tool_call' && b.id === event.tool_call_id))
                        return m;
                    return {
                        ...m,
                        content: [
                            ...m.content,
                            {
                                type: 'tool_call',
                                id: event.tool_call_id,
                                name: event.tool_call_name,
                                input: '',
                                state: 'pending',
                            },
                        ],
                    };
                })
            );
            break;
        }

        case EventType.TOOL_CALL_DELTA: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    return {
                        ...m,
                        content: m.content.map(b => {
                            if (
                                b.type === 'tool_call' &&
                                b.id === event.tool_call_id &&
                                typeof b.input === 'string'
                            ) {
                                return { ...b, input: b.input + event.delta };
                            }
                            return b;
                        }),
                    };
                })
            );
            break;
        }

        case EventType.TOOL_CALL_END:
            break;

        case EventType.TOOL_RESULT_START: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    if (
                        m.content.find(b => b.type === 'tool_result' && b.id === event.tool_call_id)
                    )
                        return m;
                    return {
                        ...m,
                        content: [
                            ...m.content,
                            {
                                type: 'tool_result',
                                id: event.tool_call_id,
                                name: event.tool_call_name,
                                output: [],
                                state: 'running',
                            },
                        ],
                    };
                })
            );
            break;
        }

        case EventType.TOOL_RESULT_TEXT_DELTA: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    return {
                        ...m,
                        content: m.content.map(b => {
                            if (b.type === 'tool_result' && b.id === event.tool_call_id) {
                                const output = Array.isArray(b.output) ? b.output : [];
                                const last = output[output.length - 1];
                                if (last && last.type === 'text') {
                                    return {
                                        ...b,
                                        output: [
                                            ...output.slice(0, -1),
                                            { ...last, text: last.text + event.delta },
                                        ],
                                    };
                                }
                                return {
                                    ...b,
                                    output: [
                                        ...output,
                                        {
                                            type: 'text',
                                            id: crypto.randomUUID(),
                                            text: event.delta,
                                        },
                                    ],
                                };
                            }
                            return b;
                        }),
                    };
                })
            );
            break;
        }

        case EventType.TOOL_RESULT_DATA_DELTA: {
            setMessages(prev =>
                prev.map(m => {
                    if (m.id !== event.reply_id || !Array.isArray(m.content)) return m;
                    return {
                        ...m,
                        content: m.content.map(b => {
                            if (b.type === 'tool_result' && b.id === event.tool_call_id) {
                                const output = Array.isArray(b.output) ? b.output : [];
                                return {
                                    ...b,
                                    output: [
                                        ...output,
                                        {
                                            type: 'data',
                                            id: crypto.randomUUID(),
                                            source: event.url
                                                ? {
                                                      type: 'url',
                                                      url: event.url,
                                                      media_type: event.media_type,
                                                  }
                                                : {
                                                      type: 'base64',
                                                      data: event.data || '',
                                                      media_type: event.media_type,
                                                  },
                                        },
                                    ],
                                };
                            }
                            return b;
                        }),
                    };
                })
            );
            break;
        }

        case EventType.TOOL_RESULT_END: {
            setMessages(prev => {
                const msg = prev.find(m => m.id === event.reply_id);
                if (!msg || !Array.isArray(msg.content)) return prev;
                const newContent = msg.content.map(b => {
                    if (
                        b.type === 'tool_result' &&
                        b.id === event.tool_call_id &&
                        b.state === 'running'
                    ) {
                        return { ...b, state: event.state } as ToolResultBlock;
                    }
                    return b;
                });
                return prev.map(m => (m.id === event.reply_id ? { ...m, content: newContent } : m));
            });
            break;
        }

        case EventType.REQUIRE_USER_CONFIRM: {
            setMessages(prev => {
                const msg = prev.find(m => m.id === event.reply_id);
                if (!msg || !Array.isArray(msg.content)) return prev;
                const toolCallIds = event.tool_calls.map(tc => tc.id);
                const newContent = msg.content.map(b => {
                    if (b.type === 'tool_call' && toolCallIds.includes(b.id)) {
                        return { ...b, awaitUserConfirmation: true };
                    }
                    return b;
                });
                return prev.map(m => (m.id === event.reply_id ? { ...m, content: newContent } : m));
            });
            break;
        }
    }
}
