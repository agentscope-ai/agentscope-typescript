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
});
