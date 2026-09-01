import {
    AgentOrientedException,
    DeveloperOrientedException,
    StructuredOutputError,
    ToolGroupInactiveError,
    ToolInterruptedError,
    ToolJSONDecodeError,
    ToolNotFoundError,
} from './index';

describe('AgentScope exceptions', () => {
    test.each([
        ToolNotFoundError,
        ToolInterruptedError,
        ToolJSONDecodeError,
        ToolGroupInactiveError,
    ])('%p is agent-oriented and exposes its class name', ExceptionClass => {
        const error = new ExceptionClass('boom');

        expect(error).toBeInstanceOf(AgentOrientedException);
        expect(error.name).toBe(ExceptionClass.name);
        expect(error.message).toBe('boom');
        expect(String(error)).toBe(`${ExceptionClass.name}: boom`);
    });

    test('structured output errors are developer-oriented', () => {
        const error = new StructuredOutputError('invalid schema output');

        expect(error).toBeInstanceOf(DeveloperOrientedException);
        expect(error.name).toBe('StructuredOutputError');
        expect(error.message).toBe('invalid schema output');
    });
});
