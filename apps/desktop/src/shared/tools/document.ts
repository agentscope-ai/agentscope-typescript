import { z } from 'zod';

/**
 * The external-execution tools for reading co-edited document content.
 * @returns An array of ToolDefinitions that can be registered with the agent.
 */
export function DocumentRead() {
    return {
        name: 'DocumentRead',
        description: `Read the current Markdown content of the co-edited document. This tool is not for reading files from the filesystem — use it to know the current state of the document you are editing together with the user.

Usage:
- By default, it reads up to 2000 lines starting from the beginning of the document
- You can optionally specify a line offset and limit (especially handy for long content), but it's recommended to read the whole document by not providing these parameters
- Any lines longer than 2000 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- This tool can only read the co-edited document, not other files.
- You can call multiple tools in a single response. It is always better to speculatively read potentially useful content in parallel.
- If the document has empty contents you will receive a system reminder warning in place of file contents.
`,
        inputSchema: z.object({
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
        requireUserConfirm: false,
    };
}

/**
 * An external-execution tool for writing content to the co-edited document.
 * @returns A ToolDefinition that can be registered with the agent.
 */
export function DocumentWrite() {
    return {
        name: 'DocumentWrite',
        description: `Overwrite the entire content of the co-edited Markdown document. Use this tool when you need to set or fully replace the document content in one operation.

Usage:
- This tool overwrites the entire document with the provided content. All existing content will be replaced.
- You MUST use the DocumentRead tool at least once before calling this tool so you are aware of the existing document state.
- Only use this for full rewrites. For targeted changes to a portion of the document, prefer DocumentPatch instead.
- Do not add emojis unless explicitly requested by the user.
- This tool only operates on the co-edited document, not the filesystem.
`,
        inputSchema: z.object({
            content: z.string().describe('The full Markdown content to write to the document'),
        }),
        requireUserConfirm: false,
    };
}

/**
 * An external-execution tool for making targeted string replacements in the co-edited document.
 * @returns A ToolDefinition that can be registered with the agent.
 */
export function DocumentEdit() {
    return {
        name: 'DocumentEdit',
        description: `Perform an exact string replacement in the co-edited Markdown document. Use this tool to make targeted edits without rewriting the entire document.

Usage:
- You MUST use the DocumentRead tool at least once before calling this tool so you know the exact current content.
- The old_string must match the current document content exactly (including whitespace and line breaks).
- The edit will FAIL if old_string is not unique in the document. Provide more surrounding context to make it unique, or use replace_all to change every instance.
- Use replace_all to rename or replace a recurring phrase across the entire document.
- Do not add emojis unless explicitly requested by the user.
- This tool only operates on the co-edited document, not the filesystem.
`,
        inputSchema: z.object({
            old_string: z.string().describe('The exact text in the document to replace'),
            new_string: z
                .string()
                .describe('The text to replace it with (must be different from old_string)'),
            replace_all: z
                .boolean()
                .optional()
                .default(false)
                .describe('Replace all occurrences of old_string (default false)'),
        }),
        requireUserConfirm: false,
    };
}
