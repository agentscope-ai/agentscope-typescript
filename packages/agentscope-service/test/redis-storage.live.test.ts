import { runStorageContract } from './storage-contract';
import { RedisStorage } from '../src/storage';

const redisUrl = process.env.AGENTSCOPE_REDIS_URL;

if (redisUrl) {
    let sequence = 0;
    runStorageContract('RedisStorage live', {
        async create() {
            sequence += 1;
            return new RedisStorage({
                url: redisUrl,
                prefix: `agentscope:test:${process.pid}:${sequence}`,
            }).open();
        },
        async destroy(storage) {
            await storage.close();
        },
    });
} else {
    describe.skip('RedisStorage live', () => {
        test('requires AGENTSCOPE_REDIS_URL', () => {});
    });
}
