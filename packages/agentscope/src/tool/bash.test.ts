import { Bash } from './bash';

describe('Bash', () => {
    test('Normal command execution', async () => {
        const bash = Bash();
        // Use cross-platform compatible command
        const command = process.platform === 'win32' ? 'echo Hello World' : 'echo "Hello World"';
        const result = await bash.call({ command });

        expect(result.state).toBe('success');
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Hello World');
    });

    test('Command with description parameter', async () => {
        const bash = Bash();
        const command = process.platform === 'win32' ? 'echo Test' : 'echo "Test"';
        const result = await bash.call({
            command,
            description: 'Test command with description',
        });

        expect(result.state).toBe('success');
        expect(result.content).toHaveLength(1);
        expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Test');
    });

    test('Error command - non-existent command', async () => {
        const bash = Bash();
        const result = await bash.call({
            command: 'nonexistentcommand123',
        });

        expect(result.state).toBe('error');
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('Command failed');
        expect(text).toContain('nonexistentcommand123');
    });

    test('Error command - division by zero in bash', async () => {
        const bash = Bash();
        // In bash, division by zero causes an error
        // On Windows cmd, this syntax doesn't work, so use a different failing command
        const command = process.platform === 'win32' ? 'set /a 10/0' : 'echo $((10/0))';
        const result = await bash.call({ command });

        expect(result.state).toBe('error');
        expect(result.content).toHaveLength(1);
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('Command failed');
    });

    test('Timeout command', async () => {
        const bash = Bash();
        // Use cross-platform sleep command
        // On Windows, use ping as a delay mechanism (more reliable than timeout in non-interactive mode)
        const command = process.platform === 'win32' ? 'ping 127.0.0.1 -n 6 > nul' : 'sleep 5';
        const result = await bash.call({
            command,
            timeout: 1000, // 1 second timeout
        });

        expect(result.state).toBe('error');
        expect(result.content).toHaveLength(1);
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('Command failed');
    }, 10000); // Increase Jest timeout for this test

    test('Command with custom timeout that succeeds', async () => {
        const bash = Bash();
        // On Windows, use ping as a delay (ping waits ~1 second per count)
        const command = process.platform === 'win32' ? 'ping 127.0.0.1 -n 2 > nul' : 'sleep 1';
        const result = await bash.call({
            command,
            timeout: 3000, // 3 second timeout
        });

        expect(result.state).toBe('success');
    }, 10000);

    test('Output truncation - exceeds 30000 characters', async () => {
        const bash = Bash();
        // Generate output longer than 30000 characters
        const command =
            process.platform === 'win32'
                ? 'for /L %i in (1,1,10000) do @echo This is line %i with some extra text'
                : 'for i in {1..10000}; do echo "This is line $i with some extra text"; done';
        const result = await bash.call({ command });

        expect(result.state).toBe('success');
        expect(result.content).toHaveLength(1);
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('[Output truncated - exceeded 30000 characters]');
        expect(text.length).toBeLessThanOrEqual(30100); // Allow some buffer for truncation message
    }, 10000);

    test('Command with stderr output', async () => {
        const bash = Bash();
        // Use a command that writes to stderr - cross-platform
        const command =
            process.platform === 'win32'
                ? 'dir C:\\nonexistent_directory_12345'
                : 'ls /nonexistent_directory_12345';
        const result = await bash.call({ command });

        expect(result.state).toBe('error');
        expect(result.content).toHaveLength(1);
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('Command failed');
    });

    test('Command with both stdout and stderr', async () => {
        const bash = Bash();
        // Command that produces both stdout and stderr
        const command =
            process.platform === 'win32'
                ? 'echo stdout message && dir C:\\nonexistent_directory_12345'
                : 'echo "stdout message" && ls /nonexistent_directory_12345';
        const result = await bash.call({ command });

        expect(result.state).toBe('error');
        expect(result.content).toHaveLength(1);
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('Command failed');
        expect(text).toContain('stdout message');
    });

    test('Maximum timeout enforcement', async () => {
        const bash = Bash();
        // Try to set timeout beyond maximum (600000ms)
        const command = process.platform === 'win32' ? 'echo test' : 'echo "test"';
        const result = await bash.call({
            command,
            timeout: 700000, // 700 seconds, should be capped at 600000
        });

        // Should still succeed because the command is fast
        expect(result.state).toBe('success');
    });

    test('Command with special characters', async () => {
        const bash = Bash();
        // Windows cmd has different special character handling
        const command =
            process.platform === 'win32'
                ? 'echo Special chars: %USERPROFILE%'
                : 'echo "Special chars: $HOME | & ; < > ( ) { }"';
        const result = await bash.call({ command });

        expect(result.state).toBe('success');
        expect(result.content).toHaveLength(1);
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('Special chars');
    });

    test('Multi-line output', async () => {
        const bash = Bash();
        const command =
            process.platform === 'win32'
                ? 'echo Line 1 && echo Line 2 && echo Line 3'
                : 'echo "Line 1" && echo "Line 2" && echo "Line 3"';
        const result = await bash.call({ command });

        expect(result.state).toBe('success');
        expect(result.content).toHaveLength(1);
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('Line 1');
        expect(text).toContain('Line 2');
        expect(text).toContain('Line 3');
    });
});
