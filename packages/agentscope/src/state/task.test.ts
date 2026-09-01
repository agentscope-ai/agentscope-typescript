import { createTask, parseTask } from './task';
import { setIdFactory, setTimestampFactory } from '../_utils/common';

describe('Task state contract', () => {
    beforeEach(() => {
        setIdFactory(() => 'task-id');
        setTimestampFactory(() => '2026-09-01T12:34:56.123456');
    });

    afterEach(() => {
        setIdFactory(() => crypto.randomUUID().replaceAll('-', ''));
        setTimestampFactory(() => new Date().toISOString());
    });

    test('fills Python Task defaults', () => {
        expect(
            createTask({ subject: 'Implement state', description: 'Align Python', metadata: {} })
        ).toEqual({
            subject: 'Implement state',
            description: 'Align Python',
            metadata: {},
            created_at: '2026-09-01T12:34:56.123456',
            state: 'pending',
            id: 'task-id',
            owner: null,
            blocks: [],
            blocked_by: [],
        });
    });

    test('parses snake_case task wire payloads', () => {
        const task = createTask({
            subject: 'Implement state',
            description: 'Align Python',
            metadata: { priority: 1 },
            blockedBy: ['task-0'],
        });
        expect(parseTask(task)).toEqual(task);
        expect(() => parseTask({ subject: 'missing required fields' })).toThrow();
    });
});
