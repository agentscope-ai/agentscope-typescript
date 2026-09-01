/* eslint-disable jsdoc/require-jsdoc */

import { spawn } from 'node:child_process';

export interface ProcessRunOptions {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
    input?: Uint8Array;
}

export interface ProcessRunResult {
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
}

export interface ProcessRunner {
    run(command: string[], options?: ProcessRunOptions): Promise<ProcessRunResult>;
}

/** Cross-platform argv runner shared by CLI-backed workspace adapters. */
export class LocalProcessRunner implements ProcessRunner {
    async run(command: string[], options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
        if (!command.length) {
            return { exitCode: 127, stdout: Buffer.alloc(0), stderr: Buffer.from('empty command') };
        }
        return new Promise((resolve, reject) => {
            const child = spawn(command[0], command.slice(1), {
                cwd: options.cwd,
                stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let settled = false;
            let timedOut = false;
            let aborted = false;
            const finish = (result: ProcessRunResult): void => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                options.signal?.removeEventListener('abort', abort);
                resolve(result);
            };
            const abort = (): void => {
                aborted = true;
                child.kill('SIGKILL');
            };
            child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
            child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
            child.once('error', error => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                options.signal?.removeEventListener('abort', abort);
                reject(error);
            });
            child.once('close', code => {
                if (timedOut || aborted) {
                    finish({
                        exitCode: -1,
                        stdout: Buffer.alloc(0),
                        stderr: Buffer.from(timedOut ? 'timed out' : 'aborted'),
                    });
                } else {
                    finish({
                        exitCode: code ?? 0,
                        stdout: Buffer.concat(stdout),
                        stderr: Buffer.concat(stderr),
                    });
                }
            });
            if (options.input) child.stdin?.end(Buffer.from(options.input));
            const timer =
                options.timeout === undefined
                    ? undefined
                    : setTimeout(() => {
                          timedOut = true;
                          child.kill('SIGKILL');
                      }, options.timeout * 1000);
            options.signal?.addEventListener('abort', abort, { once: true });
            if (options.signal?.aborted) abort();
        });
    }
}
