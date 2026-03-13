import { exec } from 'child_process';
import { promisify } from 'util';

import { z } from 'zod';

import { createToolResponse, ToolResponse } from './response';

const execAsync = promisify(exec);

/**
 * Tool for executing bash commands in a shell environment.
 * Intended for terminal operations such as git, npm, and docker.
 * File operations should use the dedicated Read, Write, Edit, Glob, and Grep tools instead.
 *
 * @returns A Tool object for executing bash commands, with a call method that performs the execution and returns the output or error message.
 */
export function Bash() {
    return {
        name: 'Bash',
        description: `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)

While the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
 - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.
 - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).
 - Write a clear, concise description of what your command does. For simple commands, keep it brief (5-10 words). For complex commands (piped commands, obscure flags, or anything hard to understand at a glance), include enough context so that the user can understand what your command will do.
 - When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel.
  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).
 - For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
 - Avoid unnecessary \`sleep\` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - Do not retry failing commands in a sleep loop — diagnose the root cause or consider an alternative approach.
  - If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.`,
        inputSchema: z.object({
            command: z.string().describe('The bash command to execute'),
            description: z
                .string()
                .optional()
                .describe(
                    'Clear, concise description of what this command does. For simple commands, keep it brief (5-10 words). For complex commands, include enough context.'
                ),
            timeout: z
                .number()
                .int()
                .min(0)
                .max(600000)
                .optional()
                .describe('Optional timeout in milliseconds (default: 120000, max: 600000)'),
        }),
        requireUserConfirm: true,

        /**
         * Executes a bash command and returns its output.
         *
         * @param root0 - The parameters object
         * @param root0.command - The bash command to execute
         * @param root0.description - Optional description of what the command does
         * @param root0.timeout - Optional timeout in milliseconds (default: 120000, max: 600000)
         * @returns The stdout of the command, or an error message if the command fails
         */
        async call({
            command,
            description: _description,
            timeout = 120000,
        }: {
            command: string;
            description?: string;
            timeout?: number;
        }): Promise<ToolResponse> {
            try {
                const maxTimeout = 600000;
                const effectiveTimeout = Math.min(timeout, maxTimeout);

                // Determine the appropriate shell based on platform
                let shell: string;
                if (process.platform === 'win32') {
                    // On Windows, use cmd.exe or PowerShell
                    shell = process.env.COMSPEC || 'cmd.exe';
                } else {
                    // On Unix-like systems, use the user's shell or default to bash
                    shell = process.env.SHELL || '/bin/bash';
                }

                const { stdout } = await execAsync(command, {
                    encoding: 'utf-8',
                    timeout: effectiveTimeout,
                    maxBuffer: 30000 * 1024,
                    shell,
                });

                // Normalize line endings to LF for cross-platform consistency
                const normalizedOutput = stdout.replace(/\r\n/g, '\n');

                const maxOutputLength = 30000;
                if (normalizedOutput.length > maxOutputLength) {
                    return createToolResponse({
                        content: [
                            {
                                id: crypto.randomUUID(),
                                type: 'text',
                                text:
                                    normalizedOutput.substring(0, maxOutputLength) +
                                    '\n\n[Output truncated - exceeded 30000 characters]',
                            },
                        ],
                        state: 'success',
                    });
                }

                return createToolResponse({
                    content: [{ id: crypto.randomUUID(), type: 'text', text: normalizedOutput }],
                    state: 'success',
                });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (error: any) {
                const errorMessage = error.message || 'Unknown error';
                const stderr = error.stderr?.toString().replace(/\r\n/g, '\n') || '';
                const stdout = error.stdout?.toString().replace(/\r\n/g, '\n') || '';

                let result = `Command failed: ${command}\n`;
                if (stdout) result += `\nStdout:\n${stdout}`;
                if (stderr) result += `\nStderr:\n${stderr}`;
                if (errorMessage && !stderr) result += `\nError: ${errorMessage}`;

                return createToolResponse({
                    content: [{ id: crypto.randomUUID(), type: 'text', text: result }],
                    state: 'error',
                });
            }
        },
    };
}
