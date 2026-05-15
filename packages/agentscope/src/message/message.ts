import { JSONSerializableObject } from '../type';
import {
    ContentBlock,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolCallBlock,
    DataBlock,
} from './block';

/** A chat message exchanged between agents or between an agent and a model. */
export interface Msg {
    /** Unique identifier for the message. */
    id: string;
    /** Display name of the message sender. */
    name: string;
    /** Conversation role of the sender. */
    role: 'user' | 'assistant' | 'system';
    /** Message body. */
    content: ContentBlock[];
    /** Arbitrary key-value metadata attached to the message. */
    metadata: Record<string, JSONSerializableObject>;
    /** ISO-8601 creation timestamp. */
    created_at: string;
    /** ISO-8601 finished timestamp. */
    finished_at?: string | null;
    /** Usage information for the message, such as token counts. */
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
}

/**
 * Create a new {@link Msg} object, filling in `id` and `created_at` when omitted.
 * A plain string `content` is automatically wrapped in a single {@link TextBlock}.
 * @param root0
 * @param root0.name
 * @param root0.content
 * @param root0.role
 * @param root0.metadata
 * @param root0.id
 * @param root0.created_at
 * @param root0.finished_at
 * @param root0.usage
 * @returns A Msg object.
 */
export function createMsg({
    name,
    content,
    role,
    metadata = {},
    id = crypto.randomUUID(),
    created_at = new Date().toISOString(),
    finished_at,
    usage,
}: Omit<Msg, 'id' | 'created_at' | 'metadata' | 'content'> &
    Partial<Pick<Msg, 'id' | 'created_at' | 'metadata'>> & {
        content: string | ContentBlock[];
    }): Msg {
    const contentBlocks: ContentBlock[] =
        typeof content === 'string'
            ? [{ id: crypto.randomUUID(), type: 'text', text: content } as TextBlock]
            : content;
    return { id, name, role, content: contentBlocks, metadata, created_at, finished_at, usage };
}

/**
 * Create a user {@link Msg}.
 * @param root0
 * @param root0.name
 * @param root0.content
 * @param root0.metadata
 * @param root0.id
 * @param root0.created_at
 * @returns A Msg object with role 'user'.
 */
export function UserMsg({
    name,
    content,
    metadata = {},
    id = crypto.randomUUID(),
    created_at = new Date().toISOString(),
}: {
    name: string;
    content: string | ContentBlock[];
    metadata?: Record<string, JSONSerializableObject>;
    id?: string;
    created_at?: string;
}): Msg {
    return createMsg({ name, content, role: 'user', metadata, id, created_at });
}

/**
 * Create an assistant {@link Msg}.
 * @param root0
 * @param root0.name
 * @param root0.content
 * @param root0.metadata
 * @param root0.id
 * @param root0.created_at
 * @param root0.usage
 * @returns A Msg object with role 'assistant'.
 */
export function AssistantMsg({
    name,
    content,
    metadata = {},
    id = crypto.randomUUID(),
    created_at = new Date().toISOString(),
    usage,
}: {
    name: string;
    content: string | ContentBlock[];
    metadata?: Record<string, JSONSerializableObject>;
    id?: string;
    created_at?: string;
    usage?: Msg['usage'];
}): Msg {
    return createMsg({ name, content, role: 'assistant', metadata, id, created_at, usage });
}

/**
 * Create a system {@link Msg}.
 * @param root0
 * @param root0.name
 * @param root0.content
 * @param root0.metadata
 * @param root0.id
 * @param root0.created_at
 * @returns A Msg object with role 'system'.
 */
export function SystemMsg({
    name,
    content,
    metadata = {},
    id = crypto.randomUUID(),
    created_at = new Date().toISOString(),
}: {
    name: string;
    content: string | ContentBlock[];
    metadata?: Record<string, JSONSerializableObject>;
    id?: string;
    created_at?: string;
}): Msg {
    return createMsg({ name, content, role: 'system', metadata, id, created_at });
}

/**
 * Extract the plain-text content from a message.
 *
 * When `content` is a string it is returned as-is. When it is an array of
 * content blocks, all {@link TextBlock} texts are joined with `separator`.
 *
 * @param msg - The message to read.
 * @param separator - String inserted between consecutive text blocks. Defaults to `'\n'`.
 * @returns The concatenated text, or `null` when no text blocks are present.
 */
export function getTextContent(msg: Msg, separator: string = '\n'): string | null {
    const textBlocks = msg.content.filter(block => block.type === 'text');
    if (textBlocks.length === 0) return null;
    return textBlocks.map(block => (block as TextBlock).text).join(separator);
}

/**
 * Return all content blocks from a message, regardless of type.
 *
 * When `content` is a plain string it is wrapped in a single {@link TextBlock}.
 *
 * @param msg - The message to read.
 * @returns An array of all {@link ContentBlock} objects.
 */
export function getContentBlocks(msg: Msg): ContentBlock[];
export function getContentBlocks(msg: Msg, blockType: 'text'): TextBlock[];
export function getContentBlocks(msg: Msg, blockType: 'thinking'): ThinkingBlock[];
export function getContentBlocks(msg: Msg, blockType: 'data'): DataBlock[];
export function getContentBlocks(msg: Msg, blockType: 'tool_call'): ToolCallBlock[];
export function getContentBlocks(msg: Msg, blockType: 'tool_result'): ToolResultBlock[];
export function getContentBlocks(
    msg: Msg,
    blockType?: 'text' | 'thinking' | 'data' | 'tool_call' | 'tool_result'
): ContentBlock[] {
    if (!blockType) return msg.content;
    return msg.content.filter(block => block.type === blockType);
}
