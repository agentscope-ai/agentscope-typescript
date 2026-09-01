import * as fs from 'fs';
import * as path from 'path';

import { z } from 'zod';

import { createToolResponse, ToolResponse } from './response';
import { _generateId, _generateTimestamp } from '../_utils/common';

/**
 * Tool for reading files from the local filesystem.
 * Returns file contents with line numbers in cat -n format.
 *
 * @returns A Tool object for reading files, with a call method that performs the read operation and returns the formatted contents or a warning if the file is empty.
 */
export function Read() {
    return {
        name: 'Read',
        description: `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than 2000 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`,
        inputSchema: z.object({
            file_path: z.string().describe('The absolute path to the file to read'),
            offset: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                    'The line number to start reading from. Only provide if the file is too large to read at once'
                ),
            limit: z
                .number()
                .int()
                .positive()
                .optional()
                .describe(
                    'The number of lines to read. Only provide if the file is too large to read at once'
                ),
        }),
        requireUserConfirm: true,

        /**
         * Reads a file and returns its contents with line numbers.
         *
         * @param root0 - The parameters object
         * @param root0.file_path - Absolute path to the file to read
         * @param root0.offset - Line number to start reading from (1-based)
         * @param root0.limit - Maximum number of lines to read (capped at 2000)
         * @returns The file contents formatted with line numbers, or a warning if the file is empty
         * @throws If the path is not absolute, the file does not exist, or the path is a directory
         */
        call({
            file_path,
            offset,
            limit,
        }: {
            file_path: string;
            offset?: number;
            limit?: number;
        }): ToolResponse {
            if (!path.isAbsolute(file_path)) {
                throw new Error(`file_path must be an absolute path, got: ${file_path}`);
            }

            if (!fs.existsSync(file_path)) {
                throw new Error(`File not found: ${file_path}`);
            }

            const stat = fs.statSync(file_path);
            if (stat.isDirectory()) {
                throw new Error(
                    `${file_path} is a directory, not a file. Use Bash with ls to read directories.`
                );
            }

            const rawContent = fs.readFileSync(file_path, 'utf-8');

            if (rawContent.length === 0) {
                return createToolResponse({
                    content: [
                        {
                            id: _generateId(),
                            created_at: _generateTimestamp(),
                            type: 'text',
                            text: rawContent,
                        },
                    ],
                    state: 'success',
                });
            }

            const allLines = rawContent.split('\n');
            const startLine = offset !== undefined ? offset - 1 : 0;
            const maxLines = 2000;
            const effectiveLimit = limit !== undefined ? Math.min(limit, maxLines) : maxLines;
            const selectedLines = allLines.slice(startLine, startLine + effectiveLimit);

            const maxLineLength = 2000;
            const formatted = selectedLines
                .map((line, i) => {
                    const lineNum = startLine + i + 1;
                    const truncated =
                        line.length > maxLineLength
                            ? line.substring(0, maxLineLength) + '[truncated]'
                            : line;
                    return `${String(lineNum).padStart(6)}\t${truncated}`;
                })
                .join('\n');

            return createToolResponse({
                content: [
                    {
                        id: _generateId(),
                        created_at: _generateTimestamp(),
                        type: 'text',
                        text: formatted,
                    },
                ],
                state: 'success',
            });
        },
    };
}
