/* eslint-disable jsdoc/require-jsdoc */

import type { MessageBus } from '../src/message-bus';

export interface MessageBusContractFactory {
    create(): Promise<MessageBus>;
    destroy(bus: MessageBus): Promise<void>;
}

export function runMessageBusContract(name: string, factory: MessageBusContractFactory): void {
    describe(`${name} message bus contract`, () => {
        let bus: MessageBus;

        beforeEach(async () => {
            bus = await factory.create();
        });

        afterEach(async () => {
            await factory.destroy(bus);
        });

        test('drains queues in FIFO batches exactly once', async () => {
            const ids = await Promise.all([
                bus.queuePush('queue', { index: 1 }),
                bus.queuePush('queue', { index: 2 }),
                bus.queuePush('queue', { index: 3 }),
            ]);
            expect(new Set(ids).size).toBe(3);
            expect(await bus.queueDrain('queue', 2)).toEqual([
                [ids[0], { index: 1 }],
                [ids[1], { index: 2 }],
            ]);
            expect(await bus.queueDrain('queue', 10)).toEqual([[ids[2], { index: 3 }]]);
            expect(await bus.queueDrain('queue')).toEqual([]);
        });

        test('atomically partitions a queue between competing drains', async () => {
            for (let index = 0; index < 10; index += 1) {
                await bus.queuePush('queue', { index });
            }
            const batches = await Promise.all([
                bus.queueDrain('queue', 10),
                bus.queueDrain('queue', 10),
            ]);
            const ids = batches.flat().map(([id]) => id);
            expect(ids).toHaveLength(10);
            expect(new Set(ids).size).toBe(10);
        });

        test('deletes queues idempotently and isolates keys', async () => {
            await bus.queuePush('first', { value: 1 });
            await bus.queuePush('second', { value: 2 });
            await bus.queueDelete('first');
            await bus.queueDelete('missing');
            expect(await bus.queueDrain('first')).toEqual([]);
            expect((await bus.queueDrain('second'))[0][1]).toEqual({ value: 2 });
        });

        test('reads replay logs non-destructively with exclusive cursors', async () => {
            const ids = [];
            for (let index = 0; index < 4; index += 1) {
                ids.push(await bus.logAppend('log', { index }));
            }
            expect((await bus.logRead('log', undefined, 2)).map(([, item]) => item.index)).toEqual([
                0, 1,
            ]);
            expect((await bus.logRead('log', ids[1])).map(([, item]) => item.index)).toEqual([
                2, 3,
            ]);
            expect((await bus.logRead('log')).map(([, item]) => item.index)).toEqual([0, 1, 2, 3]);
        });

        test('caps and trims replay logs', async () => {
            let keepFrom = '';
            for (let index = 0; index < 6; index += 1) {
                const id = await bus.logAppend('log', { index }, { maxLength: 4 });
                if (index === 4) keepFrom = id;
            }
            const capped = (await bus.logRead('log')).map(([, item]) => item.index);
            expect(capped.slice(-2)).toEqual([4, 5]);
            expect(capped.length).toBeLessThanOrEqual(6);
            await bus.logTrim('log', keepFrom);
            expect((await bus.logRead('log')).map(([, item]) => item.index)).toEqual([4, 5]);
            await bus.logTrim('log');
            await bus.logTrim('missing');
            expect(await bus.logRead('log')).toEqual([]);
        });

        test('broadcasts only to active subscribers and signals readiness once', async () => {
            let readyCount = 0;
            let readyResolve = (): void => {};
            const ready = new Promise<void>(resolve => {
                readyResolve = resolve;
            });
            const iterator = bus
                .subscribe('channel', {
                    onReady: () => {
                        readyCount += 1;
                        readyResolve();
                    },
                })
                [Symbol.asyncIterator]();
            const first = iterator.next();
            await ready;
            await bus.publish('channel', { value: 42 });
            expect(await first).toEqual({ done: false, value: { value: 42 } });
            expect(readyCount).toBe(1);
            await iterator.return?.();
            await bus.publish('channel', { ignored: true });
        });

        test('fans one broadcast out to multiple subscribers', async () => {
            let ready = 0;
            let resolveReady = (): void => {};
            const allReady = new Promise<void>(resolve => {
                resolveReady = resolve;
            });
            const options = {
                onReady: () => {
                    ready += 1;
                    if (ready === 2) resolveReady();
                },
            };
            const first = bus.subscribe('channel', options)[Symbol.asyncIterator]();
            const second = bus.subscribe('channel', options)[Symbol.asyncIterator]();
            const firstValue = first.next();
            const secondValue = second.next();
            await allReady;
            await bus.publish('channel', { value: 'shared' });
            expect((await firstValue).value).toEqual({ value: 'shared' });
            expect((await secondValue).value).toEqual({ value: 'shared' });
            await first.return?.();
            await second.return?.();
        });

        test('serializes lock holders and reflects lock state', async () => {
            const first = await bus.acquireLock('lock', { ttlSeconds: 10 });
            expect(await bus.isLocked('lock')).toBe(true);
            let secondAcquired = false;
            const secondPromise = bus.acquireLock('lock').then(lock => {
                secondAcquired = true;
                return lock;
            });
            await new Promise(resolve => setTimeout(resolve, 5));
            expect(secondAcquired).toBe(false);
            await first.release();
            const second = await secondPromise;
            expect(secondAcquired).toBe(true);
            await second.release();
            expect(await bus.isLocked('lock')).toBe(false);
        });

        test('supports non-blocking lock claims', async () => {
            expect(await bus.tryLock('lock', { ttlSeconds: 10 })).toBe(true);
            expect(await bus.tryLock('lock')).toBe(false);
            await bus.unlock('lock');
            expect(await bus.tryLock('lock')).toBe(true);
            await bus.unlock('lock');
        });

        test('round-trips isolated registry fields and copies results', async () => {
            await bus.registrySet('registry', 'first', '1');
            await bus.registrySet('registry', 'second', '2');
            await bus.registrySet('other', 'first', 'other');
            expect(await bus.registryExists('registry', 'first')).toBe(true);
            expect(await bus.registryGet('registry', 'first')).toBe('1');
            const values = await bus.registryGetAll('registry');
            expect(values).toEqual({ first: '1', second: '2' });
            values.injected = 'bad';
            expect(await bus.registryGetAll('registry')).toEqual({ first: '1', second: '2' });
            await bus.registryDelete('registry', 'first');
            await bus.registryDelete('registry', 'missing');
            expect(await bus.registryGetAll('registry')).toEqual({ second: '2' });
            await bus.registryDrop('registry');
            await bus.registryDrop('missing');
            expect(await bus.registryGetAll('registry')).toEqual({});
        });

        test('runs session helpers through lock, replay log, and purge', async () => {
            await expect(
                bus.sessionRun('session-1', async () => {
                    expect(await bus.sessionIsRunning('session-1')).toBe(true);
                    await bus.sessionPublishEvent('session-1', { value: 1 });
                    throw new Error('failed run');
                })
            ).rejects.toThrow('failed run');
            expect(await bus.sessionIsRunning('session-1')).toBe(false);
            expect(await bus.sessionReadEvents('session-1')).toEqual([]);

            await bus.inboxPush('session-1', { value: 2 });
            await bus.backgroundTaskRegister('session-1', 'task-1', '{}');
            await bus.sessionPurge('session-1');
            expect(await bus.inboxDrain('session-1')).toEqual([]);
            expect(await bus.backgroundTaskList('session-1')).toEqual({});
        });

        test('queues wakeups and publishes their signal', async () => {
            let readyResolve = (): void => {};
            const ready = new Promise<void>(resolve => {
                readyResolve = resolve;
            });
            const signal = bus
                .subscribeWakeupSignal({ onReady: readyResolve })
                [Symbol.asyncIterator]();
            const received = signal.next();
            await ready;
            await bus.enqueueWakeup('user-1', 'session-1', 'agent-1');
            expect((await received).value).toEqual({});
            expect(await bus.dequeueWakeups()).toEqual([
                {
                    user_id: 'user-1',
                    session_id: 'session-1',
                    agent_id: 'agent-1',
                    kind: 'wake',
                    input: null,
                },
            ]);
            await signal.return?.();
        });

        test('round-trips background task cancellation broadcasts', async () => {
            let readyResolve = (): void => {};
            const ready = new Promise<void>(resolve => {
                readyResolve = resolve;
            });
            const iterator = bus
                .taskSubscribeCancel({ onReady: readyResolve })
                [Symbol.asyncIterator]();
            const result = iterator.next();
            await ready;
            await bus.taskPublishCancel('task-1');
            expect(await result).toEqual({ done: false, value: 'task-1' });
            await iterator.return?.();
        });
    });
}
