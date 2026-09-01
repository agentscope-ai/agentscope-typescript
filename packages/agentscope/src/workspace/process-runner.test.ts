import { LocalProcessRunner } from './process-runner';

describe('LocalProcessRunner', () => {
    test('runs argv without shell interpolation and captures both streams', async () => {
        const runner = new LocalProcessRunner();
        const value = 'a b $(echo unsafe) | ;';

        await expect(
            runner.run([
                process.execPath,
                '-e',
                'process.stdout.write(process.argv[1]); process.stderr.write("err")',
                value,
            ])
        ).resolves.toEqual({
            exitCode: 0,
            stdout: Buffer.from(value),
            stderr: Buffer.from('err'),
        });
    });

    test('kills timed-out and aborted processes with standard sentinels', async () => {
        const runner = new LocalProcessRunner();
        const command = [process.execPath, '-e', 'setTimeout(() => {}, 10000)'];
        const controller = new AbortController();
        controller.abort();

        await expect(runner.run(command, { timeout: 0.01 })).resolves.toEqual({
            exitCode: -1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('timed out'),
        });
        await expect(runner.run(command, { signal: controller.signal })).resolves.toEqual({
            exitCode: -1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('aborted'),
        });
    });

    test('preserves spawn failures for adapter-specific diagnostics', async () => {
        const runner = new LocalProcessRunner();

        await expect(runner.run(['agentscope-command-that-does-not-exist'])).rejects.toEqual(
            expect.objectContaining({ code: 'ENOENT' })
        );
    });
});
