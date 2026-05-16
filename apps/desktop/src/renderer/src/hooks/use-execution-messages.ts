import { Msg } from '@agentscope-ai/agentscope/message';
import type { ScheduleExecution } from '@shared/types/schedule';
import { useState, useEffect, startTransition } from 'react';

import { applyAgentEvent } from './agent-event-handler';
import { useSchedule } from '@/contexts/ScheduleContext';

/**
 * A custom hook for managing execution messages.
 *
 * @param scheduleId - The schedule ID
 * @param execution - The execution data
 * @returns An object containing messages and sending state
 */
export function useExecutionMessages(
    scheduleId: string | null,
    execution: ScheduleExecution | null
) {
    const { getExecutionMessages, subscribeExecutionAgentEvents } = useSchedule();
    const [messages, setMessages] = useState<Msg[]>([]);
    const [sending, setSending] = useState(false);

    useEffect(() => {
        if (!scheduleId || !execution) {
            startTransition(() => {
                setMessages([]);
                setSending(false);
            });
            return;
        }

        // Load historical messages
        getExecutionMessages(scheduleId, execution.executionId).then(msgs => {
            startTransition(() => {
                setMessages(msgs);
                setSending(execution.status === 'running');
            });
        });

        // Subscribe to real-time events if execution is running
        if (execution.status === 'running') {
            return subscribeExecutionAgentEvents(scheduleId, event => {
                applyAgentEvent(event, setMessages, setSending);
            });
        }
        return;
    }, [
        scheduleId,
        execution?.executionId,
        execution?.status,
        getExecutionMessages,
        subscribeExecutionAgentEvents,
        execution,
    ]);

    return { messages, sending };
}
