import type { ToolResultBlock } from '@agentscope-ai/agentscope/message';
import { Dispatch, SetStateAction } from 'react';

const MAX_LINE_LENGTH = 2000;
const MAX_LINES = 2000;

/**
 * Format the document content with line numbers, similar to `cat -n` in Unix.
 * @param content
 * @param offset
 * @param limit
 * @returns A string with line numbers and truncated lines if they exceed MAX_LINE_LENGTH, limited to MAX_LINES total.
 */
function formatWithLineNumbers(content: string, offset?: number, limit?: number): string {
    const allLines = content.split('\n');
    const startLine = offset !== undefined ? offset - 1 : 0;
    const effectiveLimit = limit !== undefined ? Math.min(limit, MAX_LINES) : MAX_LINES;
    const selectedLines = allLines.slice(startLine, startLine + effectiveLimit);

    return selectedLines
        .map((line, i) => {
            const lineNum = startLine + i + 1;
            const truncated =
                line.length > MAX_LINE_LENGTH
                    ? line.substring(0, MAX_LINE_LENGTH) + '[truncated]'
                    : line;
            return `${String(lineNum).padStart(6)}\t${truncated}`;
        })
        .join('\n');
}

/**
 * Execute the DocumentRead tool in the renderer.
 * Returns the current document content formatted with line numbers (cat -n style).
 *
 * @param toolCallId - The ID of the tool call from the agent event
 * @param content - The current Markdown content of the co-edited document
 * @param params - The tool input parameters (offset, limit)
 * @param params.offset
 * @param params.limit
 * @returns A ToolResultBlock to send back as EXTERNAL_EXECUTION_RESULT
 */
export function executeDocumentRead(
    toolCallId: string,
    content: string,
    params: { offset?: number; limit?: number }
): ToolResultBlock {
    if (content.length === 0) {
        return {
            type: 'tool_result',
            id: toolCallId,
            name: 'DocumentRead',
            output: [
                {
                    id: crypto.randomUUID(),
                    type: 'text',
                    text: '<system-info>The document is currently empty.</system-info>',
                },
            ],
            state: 'success',
        };
    }

    const formatted = formatWithLineNumbers(content, params.offset, params.limit);

    return {
        type: 'tool_result',
        id: toolCallId,
        name: 'DocumentRead',
        output: [
            {
                id: crypto.randomUUID(),
                type: 'text',
                text: formatted,
            },
        ],
        state: 'success',
    };
}

/**
 * Execute the DocumentWrite tool in the renderer.
 * Replaces the entire document content with the provided string.
 *
 * @param toolCallId - The ID of the tool call from the agent event
 * @param setContent - The React state setter (or any callback) to update the document
 * @param params - The tool input parameters ({ content })
 * @param params.content
 * @returns A ToolResultBlock to send back as EXTERNAL_EXECUTION_RESULT
 */
export function executeDocumentWrite(
    toolCallId: string,
    setContent: (newContent: string) => void,
    params: { content: string }
): ToolResultBlock {
    try {
        setContent(params.content);
        const lineCount = params.content.split('\n').length;
        return {
            type: 'tool_result',
            id: toolCallId,
            name: 'DocumentWrite',
            output: [
                {
                    id: crypto.randomUUID(),
                    type: 'text',
                    text: `The document has been written successfully (${lineCount} lines).`,
                },
            ],
            state: 'success',
        };
    } catch (error) {
        return {
            type: 'tool_result',
            id: toolCallId,
            name: 'DocumentWrite',
            output: [
                {
                    id: crypto.randomUUID(),
                    type: 'text',
                    text: `Failed to write document: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            state: 'error',
        };
    }
}

/**
 * Execute the DocumentEdit tool in the renderer.
 * Replaces an exact string occurrence in the current document content.
 *
 * @param toolCallId
 * @param setContent
 * @param params
 * @param params.old_string
 * @param params.new_string
 * @param params.replace_all
 * @returns A ToolResultBlock to send back as EXTERNAL_EXECUTION_RESULT
 */
export function executeDocumentEdit(
    toolCallId: string,
    setContent: Dispatch<SetStateAction<string>>,
    params: { old_string: string; new_string: string; replace_all?: boolean }
): ToolResultBlock {
    const makeError = (text: string): ToolResultBlock => ({
        type: 'tool_result',
        id: toolCallId,
        name: 'DocumentEdit',
        output: [{ id: crypto.randomUUID(), type: 'text', text }],
        state: 'error',
    });

    if (params.old_string === params.new_string) {
        return makeError('old_string and new_string must be different.');
    }

    // Capture error from inside the setState updater.
    // React calls the functional updater synchronously during setState,
    // so `error` will be populated by the time setContent returns.
    let error: string | null = null;

    setContent(prevContent => {
        const occurrences = prevContent.split(params.old_string).length - 1;

        if (occurrences === 0) {
            error =
                'old_string not found in document. Make sure it matches the current content exactly (including whitespace and line breaks).';
            return prevContent;
        }

        if (!params.replace_all && occurrences > 1) {
            error =
                `old_string is not unique in the document (found ${occurrences} occurrences). ` +
                `Provide more surrounding context to make it unique, or set replace_all to true.`;
            return prevContent;
        }

        return params.replace_all
            ? prevContent.split(params.old_string).join(params.new_string)
            : prevContent.replace(params.old_string, params.new_string);
    });

    if (error) {
        return makeError(error);
    }

    return {
        type: 'tool_result',
        id: toolCallId,
        name: 'DocumentEdit',
        output: [
            {
                id: crypto.randomUUID(),
                type: 'text',
                text: 'The document has been edited successfully.',
            },
        ],
        state: 'success',
    };
}
