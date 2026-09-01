import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { logger, setupLogger } from './index';

describe('AgentScope logger', () => {
    afterEach(() => setupLogger('INFO'));

    test('rejects logging levels outside the Python vocabulary', () => {
        expect(() => setupLogger('TRACE' as 'INFO')).toThrow(
            "Invalid logging level: TRACE. Must be one of 'INFO', 'DEBUG', " +
                "'WARNING', 'ERROR', 'CRITICAL'."
        );
    });

    test('honors level filtering and appends to the configured file', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'agentscope-logger-'));
        const filePath = path.join(directory, 'agentscope.log');

        try {
            setupLogger('WARNING', filePath);
            logger.info('hidden %s', 'message');
            logger.warning('visible %s', 'message');

            const content = await readFile(filePath, 'utf8');
            expect(content).not.toContain('hidden message');
            expect(content).toMatch(
                /^\d{4}-\d{2}-\d{2}T.* \| WARNING \| agentscope - visible message\n$/
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
