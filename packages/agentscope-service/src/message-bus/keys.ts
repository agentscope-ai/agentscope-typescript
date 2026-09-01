/** Application key conventions layered over the generic message bus. */
export const MessageBusKeys = {
    WAKEUP_KIND_WAKE: 'wake',
    WAKEUP_KIND_RESUME: 'resume',
    WAKEUP_KIND_MESSAGE: 'message',
    SESSION_REPLAY_MAX_LEN: 1_000,
    SESSION_RUN_TTL_SECS: 600,
    INBOX_LOCK_TTL_SECS: 30,
    INBOX_CONSUMER_FIELD: 'running',
    BG_TASKS_TTL_SECS: 86_400,

    projectionNamespace: (targetSessionId: string) =>
        `agentscope:session:projection:${targetSessionId}`,
    projectionField: (kind: string, entryId: string) => `${kind}:${entryId}`,
    projectionFieldPrefix: (kind: string) => `${kind}:`,
    sessionEvents: (sessionId: string) => `agentscope:session:events:${sessionId}`,
    sessionLock: (sessionId: string) => `agentscope:session:lock:${sessionId}`,
    inbox: (sessionId: string) => `agentscope:inbox:${sessionId}`,
    inboxLock: (sessionId: string) => `agentscope:inbox:lock:${sessionId}`,
    inboxConsumer: (sessionId: string) => `agentscope:inbox:consumer:${sessionId}`,
    wakeupQueue: () => 'agentscope:wakeups',
    wakeupSignal: () => 'agentscope:wakeup_signal',
    sessionCancelChannel: () => 'agentscope:session:cancel',
    taskCancelChannel: () => 'agentscope:task:cancel',
    sessionInterruptChannel: () => 'agentscope:session:interrupt',
    bgTasks: (sessionId: string) => `agentscope:bg_tasks:${sessionId}`,
    indexTasksQueue: () => 'agentscope:index:tasks',
    indexTasksSignal: () => 'agentscope:index:tasks:wake',
    scheduleLifecycle: () => 'agentscope:schedule:lifecycle',
    channelLifecycle: () => 'agentscope:channel:lifecycle',
    channelLiveness: (channelId: string) => `agentscope:channel:liveness:${channelId}`,
    channelMediaBuffer: (channelId: string, chatId: string, userId: string) =>
        `agentscope:channel:media:${channelId}:${chatId}:${userId}`,
    channelSeenChats: (channelId: string) => `agentscope:channel:seen_chats:${channelId}`,
} as const;

export type RunTriggerKind =
    | typeof MessageBusKeys.WAKEUP_KIND_WAKE
    | typeof MessageBusKeys.WAKEUP_KIND_RESUME
    | typeof MessageBusKeys.WAKEUP_KIND_MESSAGE;
