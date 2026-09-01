import { runMessageBusContract } from './message-bus-contract';
import { RedisMessageBus } from '../src/message-bus';

const redisUrl = process.env.AGENTSCOPE_REDIS_URL;

if (redisUrl) {
    let database = 0;
    runMessageBusContract('RedisMessageBus live', {
        async create() {
            const url = new URL(redisUrl);
            url.pathname = `/${database}`;
            database += 1;
            return new RedisMessageBus({ url: url.toString(), lockRetryDelayMs: 5 }).open();
        },
        async destroy(bus) {
            await bus.close();
        },
    });

    describe('RedisMessageBus live lock ownership', () => {
        test('does not let an expired owner release a newer lock', async () => {
            const url = new URL(redisUrl);
            url.pathname = '/15';
            const first = await new RedisMessageBus({ url: url.toString() }).open();
            const second = await new RedisMessageBus({ url: url.toString() }).open();
            try {
                expect(await first.tryLock('owned-lock', { ttlSeconds: 1 })).toBe(true);
                await new Promise(resolve => setTimeout(resolve, 1_100));
                expect(await second.tryLock('owned-lock', { ttlSeconds: 10 })).toBe(true);
                await first.unlock('owned-lock');
                expect(await second.isLocked('owned-lock')).toBe(true);
                await second.unlock('owned-lock');
            } finally {
                await first.close();
                await second.close();
            }
        });
    });
} else {
    describe.skip('RedisMessageBus live', () => {
        test('requires AGENTSCOPE_REDIS_URL', () => {});
    });
}
