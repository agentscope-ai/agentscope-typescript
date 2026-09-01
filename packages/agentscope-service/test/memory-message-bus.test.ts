import { runMessageBusContract } from './message-bus-contract';
import { InMemoryMessageBus } from '../src/message-bus';

runMessageBusContract('InMemoryMessageBus', {
    async create() {
        return new InMemoryMessageBus().open();
    },
    async destroy(bus) {
        await bus.close();
    },
});

describe('InMemoryMessageBus TTL', () => {
    test('expires queue, log, registry, and non-blocking lock state', async () => {
        const bus = await new InMemoryMessageBus().open();
        await bus.queuePush('queue', { value: 1 }, { ttlSeconds: 0.001 });
        await bus.logAppend('log', { value: 1 }, { ttlSeconds: 0.001 });
        await bus.registrySet('registry', 'field', 'value', { ttlSeconds: 0.001 });
        await bus.tryLock('lock', { ttlSeconds: 0.001 });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(await bus.queueDrain('queue')).toEqual([]);
        expect(await bus.logRead('log')).toEqual([]);
        expect(await bus.registryGetAll('registry')).toEqual({});
        expect(await bus.isLocked('lock')).toBe(false);
        await bus.close();
    });

    test('refreshes registry expiry only after a successful compare-and-set', async () => {
        const bus = await new InMemoryMessageBus().open();
        await bus.registrySet('loser', 'field', 'v1', { ttlSeconds: 0.01 });
        await expect(
            bus.registrySetIf('loser', 'field', 'v2', {
                expected: 'stale',
                ttlSeconds: 10,
            })
        ).resolves.toBe(false);
        await new Promise(resolve => setTimeout(resolve, 20));
        await expect(bus.registryGet('loser', 'field')).resolves.toBeNull();

        await bus.registrySet('winner', 'field', 'v1', { ttlSeconds: 0.01 });
        await expect(
            bus.registrySetIf('winner', 'field', 'v2', {
                expected: 'v1',
                ttlSeconds: 10,
            })
        ).resolves.toBe(true);
        await new Promise(resolve => setTimeout(resolve, 20));
        await expect(bus.registryGet('winner', 'field')).resolves.toBe('v2');
        await bus.close();
    });
});
