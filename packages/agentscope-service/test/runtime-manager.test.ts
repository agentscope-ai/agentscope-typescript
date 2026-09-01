/* eslint-disable jsdoc/require-jsdoc */

import { BackgroundTaskManager, CancelDispatcher, ChatRunRegistry, ToolStop } from '../src/manager';
import { InMemoryMessageBus } from '../src/message-bus';

function waitForAbort(signal: AbortSignal, marker?: { aborted: boolean }): Promise<void> {
    return new Promise(resolve => {
        const finish = (): void => {
            if (marker) marker.aborted = true;
            resolve();
        };
        if (signal.aborted) finish();
        else signal.addEventListener('abort', finish, { once: true });
    });
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Timed out waiting for manager state.');
}

describe('ChatRunRegistry', () => {
    test('registers, rejects duplicate active runs, and removes settled runs', async () => {
        const registry = new ChatRunRegistry();
        let finish = (): void => {};
        const first = registry.spawn(
            () =>
                new Promise<void>(resolve => {
                    finish = resolve;
                }),
            { sessionId: 'session' }
        );

        expect(registry.get('session')).toBe(first);
        expect(() => registry.spawn(async () => {}, { sessionId: 'session' })).toThrow(
            'already has an active chat run'
        );
        await Promise.resolve();
        finish();
        await first.promise;
        await Promise.resolve();
        expect(registry.get('session')).toBeNull();
    });

    test('shutdown aborts and awaits every active run', async () => {
        const registry = new ChatRunRegistry();
        const markers = [{ aborted: false }, { aborted: false }];
        registry.spawn(signal => waitForAbort(signal, markers[0]), { sessionId: 'one' });
        registry.spawn(signal => waitForAbort(signal, markers[1]), { sessionId: 'two' });

        await registry.close();

        expect(markers).toEqual([{ aborted: true }, { aborted: true }]);
    });
});

describe('BackgroundTaskManager and ToolStop', () => {
    test('registers metadata globally and unregisters on completion', async () => {
        const bus = new InMemoryMessageBus();
        const manager = new BackgroundTaskManager(bus);
        let finish = (): void => {};
        const taskId = await manager.registerTask(
            () =>
                new Promise<void>(resolve => {
                    finish = resolve;
                }),
            { sessionId: 'session', agentId: 'agent', userId: 'user', toolName: 'Bash' }
        );

        const metadata = JSON.parse((await bus.backgroundTaskList('session'))[taskId]);
        expect(metadata).toMatchObject({ tool_name: 'Bash', agent_id: 'agent' });
        expect(typeof metadata.started_at).toBe('number');
        finish();
        await waitFor(() => !manager.tasks.has(taskId));
        await waitFor(asyncCheck(() => bus.backgroundTaskExists('session', taskId), false));
    });

    test('cancels only tasks belonging to the selected session', async () => {
        const bus = new InMemoryMessageBus();
        const manager = new BackgroundTaskManager(bus);
        const first = { aborted: false };
        const second = { aborted: false };
        await manager.registerTask(signal => waitForAbort(signal, first), {
            sessionId: 'match',
            agentId: 'agent',
            userId: 'user',
        });
        await manager.registerTask(signal => waitForAbort(signal, second), {
            sessionId: 'other',
            agentId: 'agent',
            userId: 'user',
        });

        expect(manager.cancelSessionTasks('match')).toBe(1);
        await waitFor(() => first.aborted);
        expect(second.aborted).toBe(false);
        await manager.close();
    });

    test('ToolStop cancels local tasks only within its bound session', async () => {
        const bus = new InMemoryMessageBus();
        const manager = new BackgroundTaskManager(bus);
        const marker = { aborted: false };
        const taskId = await manager.registerTask(signal => waitForAbort(signal, marker), {
            sessionId: 'owner',
            agentId: 'agent',
            userId: 'user',
        });

        const denied = await new ToolStop(manager, bus, 'other').call({ task_id: taskId });
        expect(denied.state).toBe('error');
        expect(marker.aborted).toBe(false);
        const stopped = await new ToolStop(manager, bus, 'owner').call({ task_id: taskId });
        expect(stopped.state).toBe('success');
        expect(stopped.content[0]).toMatchObject({ text: `Task ${taskId} stopped successfully.` });
        await waitFor(() => marker.aborted);
    });

    test('ToolStop broadcasts to the worker that owns a remote task', async () => {
        const bus = new InMemoryMessageBus();
        const owner = new BackgroundTaskManager(bus);
        const caller = new BackgroundTaskManager(bus);
        const registry = new ChatRunRegistry();
        const dispatcher = new CancelDispatcher(bus, registry, owner);
        const marker = { aborted: false };
        await dispatcher.open();
        const taskId = await owner.registerTask(signal => waitForAbort(signal, marker), {
            sessionId: 'session',
            agentId: 'agent',
            userId: 'user',
        });

        const result = await new ToolStop(caller, bus, 'session').call({ task_id: taskId });

        expect(result.state).toBe('success');
        await waitFor(() => marker.aborted);
        await dispatcher.close();
    });
});

describe('CancelDispatcher', () => {
    test('session cancel aborts chat and background work', async () => {
        const bus = new InMemoryMessageBus();
        const registry = new ChatRunRegistry();
        const background = new BackgroundTaskManager(bus);
        const dispatcher = new CancelDispatcher(bus, registry, background);
        const chat = { aborted: false };
        const task = { aborted: false };
        registry.spawn(signal => waitForAbort(signal, chat), { sessionId: 'session' });
        await background.registerTask(signal => waitForAbort(signal, task), {
            sessionId: 'session',
            agentId: 'agent',
            userId: 'user',
        });
        await dispatcher.open();

        await bus.sessionPublishCancel('session');

        await waitFor(() => chat.aborted && task.aborted);
        await dispatcher.close();
    });

    test('interrupt aborts chat without cancelling background work', async () => {
        const bus = new InMemoryMessageBus();
        const registry = new ChatRunRegistry();
        const background = new BackgroundTaskManager(bus);
        const dispatcher = new CancelDispatcher(bus, registry, background);
        const chat = { aborted: false };
        const task = { aborted: false };
        registry.spawn(signal => waitForAbort(signal, chat), { sessionId: 'session' });
        await background.registerTask(signal => waitForAbort(signal, task), {
            sessionId: 'session',
            agentId: 'agent',
            userId: 'user',
        });
        await dispatcher.open();

        await bus.sessionPublishInterrupt('session');

        await waitFor(() => chat.aborted);
        expect(task.aborted).toBe(false);
        await dispatcher.close();
        await background.close();
    });
});

function asyncCheck(check: () => Promise<boolean>, expected: boolean): () => boolean {
    let current = !expected;
    void check().then(value => {
        current = value;
    });
    return () => current === expected;
}
