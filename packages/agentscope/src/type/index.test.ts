import { ErrorInfo, ErrorType, ReplyFinishedReason } from './index';

describe('shared reply types', () => {
    test('matches Python reply-finished values', () => {
        expect(ReplyFinishedReason).toEqual({
            COMPLETED: 'completed',
            INTERRUPTED: 'interrupted',
            EXCEED_MAX_ITERS: 'exceed_max_iters',
            ERROR: 'error',
        });
    });

    test('matches every Python error classification', () => {
        expect(ErrorType).toEqual({
            AUTHENTICATION: 'authentication',
            PERMISSION: 'permission',
            RATE_LIMIT: 'rate_limit',
            INVALID_REQUEST: 'invalid_request',
            UPSTREAM: 'upstream',
            CONNECTION: 'connection',
            INTERNAL: 'internal',
            SETUP: 'setup',
            UNKNOWN: 'unknown',
        });
    });

    test('defaults error information to the unknown classification', () => {
        expect(new ErrorInfo({ message: 'sanitized failure' })).toEqual({
            type: ErrorType.UNKNOWN,
            message: 'sanitized failure',
        });
    });
});
