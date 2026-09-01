import { runStorageContract } from './storage-contract';
import { InMemoryStorage } from '../src/storage';

runStorageContract('InMemoryStorage', {
    async create() {
        return new InMemoryStorage().open();
    },
    async destroy(storage) {
        await storage.close();
    },
});
