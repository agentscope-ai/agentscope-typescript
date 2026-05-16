import {
    EventType,
    type AgentEvent,
    UserConfirmResultEvent,
} from '@agentscope-ai/agentscope/event';
import { ContentBlock, createMsg, Msg, ToolCallBlock } from '@agentscope-ai/agentscope/message';
import { useState, useEffect, useRef, startTransition } from 'react';

import { applyAgentEvent } from './agent-event-handler';

/**
 * A custom hook for managing chat messages within a session.
 *
 * @param sessionId - The ID of the current chat session.
 * @returns An object containing messages, sending state, and message sending function.
 */
export function useMessages(sessionId: string | null) {
    const [messages, setMessages] = useState<Msg[]>([]);
    const [sending, setSending] = useState(false);
    const prevSessionIdRef = useRef<string | null>(null);

    // Load historical messages and check running state when switching sessions
    useEffect(() => {
        if (!sessionId) {
            startTransition(() => {
                setMessages([]);
                setSending(false);
            });
            prevSessionIdRef.current = null;
            return;
        }

        // Clear messages only when switching from one session to another.
        // If switching from null to a value (creating a new session), do not clear messages to preserve optimistic updates.
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== sessionId) {
            startTransition(() => {
                setMessages([]);
            });
        }
        prevSessionIdRef.current = sessionId;

        Promise.all([
            window.api.chat.getMessages(sessionId),
            window.api.chat.isRunning(sessionId),
        ]).then(([msgs, running]) => {
            startTransition(() => {
                setMessages(prev => {
                    // Positive update
                    const msgIds = new Set(msgs.map(m => m.id));
                    const localMsgs = prev.filter(m => !msgIds.has(m.id));
                    return [...msgs, ...localMsgs];
                });
                setSending(running);
            });
        });
    }, [sessionId]);

    // Subscribe to agent streaming events by sessionId, and automatically unsubscribe when switching sessions
    useEffect(() => {
        if (!sessionId) return;
        return window.api.agent.subscribe(sessionId, (event: AgentEvent) => {
            applyAgentEvent(event, setMessages, setSending);
        });
    }, [sessionId]);

    const sendMessage = async (content: ContentBlock[], sessionId: string, agentKey: string) => {
        if (content.length === 0) return;
        setSending(true);
        const message = createMsg({
            id: crypto.randomUUID(),
            role: 'user',
            name: 'user',
            content,
        });
        // Positive update for user message
        setMessages(prev => [...prev, message]);
        await window.api.chat.sendMessage(sessionId, agentKey, message);
    };

    const sendUserConfirm = async (
        toolCall: ToolCallBlock,
        confirm: boolean,
        replyId: string,
        sessionId: string,
        agentKey: string
    ) => {
        await window.api.chat.sendMessage(sessionId, agentKey, undefined, {
            type: EventType.USER_CONFIRM_RESULT,
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            reply_id: replyId,
            confirm_results: [
                {
                    confirmed: confirm,
                    tool_call: toolCall,
                },
            ],
        } as UserConfirmResultEvent);
    };

    return { messages, sending, sendMessage, sendUserConfirm };
}
