import { JSONSerializableObject } from '../type';
import {
    ContentBlock,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolCallBlock,
    DataBlock,
    HintBlock,
    Base64Source,
    URLSource,
} from './block';
import { base64ToBytes, bytesToBase64 } from '../_utils/common';
import { AgentEvent, EventType } from '../event';

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
        input_tokens: number;
        output_tokens: number;
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
/**
 * Validate that content blocks are allowed for the given role.
 *
 * Mirrors the Python `_assert_user_content_blocks` / `_assert_system_content_blocks`
 * guards: user messages may only contain text or data blocks; system messages
 * may only contain text blocks; assistant messages accept any block type.
 * @param role
 * @param content
 */
function assertContentBlocksForRole(role: Msg['role'], content: ContentBlock[]): void {
    if (role === 'user') {
        for (const block of content) {
            if (block.type !== 'text' && block.type !== 'data') {
                throw new Error('User message can only contain text blocks or data blocks.');
            }
        }
    } else if (role === 'system') {
        for (const block of content) {
            if (block.type !== 'text') {
                throw new Error('System message can only contain text blocks.');
            }
        }
    }
}

/**
 * createMsg is a low-level utility for constructing Msg objects with proper defaults and validation.
 * @param root0
 * @param root0.name
 * @param root0.content
 * @param root0.role
 * @param root0.metadata
 * @param root0.id
 * @param root0.created_at
 * @param root0.finished_at
 * @param root0.usage
 * @returns A Msg object with the specified properties, and defaults for any omitted fields.
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
    assertContentBlocksForRole(role, contentBlocks);
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
 * @param root0.finished_at
 * @returns A Msg object with role 'user'.
 */
export function UserMsg({
    name,
    content,
    metadata = {},
    id = crypto.randomUUID(),
    created_at = new Date().toISOString(),
    finished_at,
}: {
    name: string;
    content: string | ContentBlock[];
    metadata?: Record<string, JSONSerializableObject>;
    id?: string;
    created_at?: string;
    finished_at?: string | null;
}): Msg {
    return createMsg({
        name,
        content,
        role: 'user',
        metadata,
        id,
        created_at,
        finished_at: finished_at ?? created_at,
    });
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
 * @param root0.finished_at
 * @returns A Msg object with role 'system'.
 */
export function SystemMsg({
    name,
    content,
    metadata = {},
    id = crypto.randomUUID(),
    created_at = new Date().toISOString(),
    finished_at,
}: {
    name: string;
    content: string | ContentBlock[];
    metadata?: Record<string, JSONSerializableObject>;
    id?: string;
    created_at?: string;
    finished_at?: string | null;
}): Msg {
    return createMsg({
        name,
        content,
        role: 'system',
        metadata,
        id,
        created_at,
        finished_at: finished_at ?? created_at,
    });
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
export function getContentBlocks(msg: Msg, blockType: 'hint'): HintBlock[];
export function getContentBlocks(msg: Msg, blockType: 'data'): DataBlock[];
export function getContentBlocks(msg: Msg, blockType: 'tool_call'): ToolCallBlock[];
export function getContentBlocks(msg: Msg, blockType: 'tool_result'): ToolResultBlock[];
export function getContentBlocks(
    msg: Msg,
    blockType?: 'text' | 'thinking' | 'hint' | 'data' | 'tool_call' | 'tool_result'
): ContentBlock[] {
    if (!blockType) return msg.content;
    return msg.content.filter(block => block.type === blockType);
}

/**
 * Find a content block by type and id within a message.
 * @param msg
 * @param blockType
 * @param blockId
 * @returns The matching {@link ContentBlock}, or `undefined` if not found.
 */
function findBlock(msg: Msg, blockType: string, blockId: string): ContentBlock | undefined {
    return msg.content.find(block => block.type === blockType && block.id === blockId);
}

/**
 * Apply a streaming {@link AgentEvent} to a {@link Msg}, mutating it in place.
 *
 * Only `content` and `finished_at` are ever modified. Events whose
 * `reply_id` does not match `msg.id` are skipped with a warning.
 * @param msg
 * @param event
 * @returns The mutated {@link Msg} object.
 */
export function appendEvent(msg: Msg, event: AgentEvent): Msg {
    if (!('reply_id' in event)) return msg;
    if (event.reply_id !== msg.id) {
        console.warn(
            `Event reply_id "${event.reply_id}" does not match message id "${msg.id}", skipping.`
        );
        return msg;
    }

    switch (event.type) {
        case EventType.REPLY_END:
            msg.finished_at = event.created_at;
            break;

        case EventType.TEXT_BLOCK_START:
            msg.content.push({ type: 'text', id: event.block_id, text: '' });
            break;

        case EventType.TEXT_BLOCK_DELTA: {
            const block = findBlock(msg, 'text', event.block_id);
            if (!block) {
                console.warn(`TextBlock "${event.block_id}" not found, skipping.`);
            } else {
                (block as TextBlock).text += event.delta;
            }
            break;
        }

        case EventType.TEXT_BLOCK_END:
            break;

        case EventType.THINKING_BLOCK_START:
            msg.content.push({ type: 'thinking', id: event.block_id, thinking: '' });
            break;

        case EventType.THINKING_BLOCK_DELTA: {
            const block = findBlock(msg, 'thinking', event.block_id);
            if (!block) {
                console.warn(`ThinkingBlock "${event.block_id}" not found, skipping.`);
            } else {
                (block as ThinkingBlock).thinking += event.delta;
            }
            break;
        }

        case EventType.THINKING_BLOCK_END:
            break;

        case EventType.HINT_BLOCK: {
            // Hint blocks are not streamed — the full content arrives in
            // a single event and is appended as a complete HintBlock.
            const hintBlock: HintBlock = {
                type: 'hint',
                id: event.block_id,
                hint: event.hint,
                source: event.source ?? null,
            };
            msg.content.push(hintBlock);
            break;
        }

        case EventType.DATA_BLOCK_START:
            msg.content.push({
                type: 'data',
                id: event.block_id,
                source: { type: 'base64', data: '', media_type: event.media_type },
            });
            break;

        case EventType.DATA_BLOCK_DELTA: {
            const block = findBlock(msg, 'data', event.block_id);
            if (!block) {
                console.warn(`DataBlock "${event.block_id}" not found, skipping.`);
            } else if (event.data) {
                // Each delta is an independently base64-encoded chunk (with
                // its own padding); naive string concat would inject '=' into
                // the middle of the byte stream and corrupt it. Decode, concat
                // bytes, re-encode.
                const src = (block as DataBlock).source as Base64Source;
                const existing = src.data ? base64ToBytes(src.data) : new Uint8Array(0);
                const incoming = base64ToBytes(event.data);
                const merged = new Uint8Array(existing.length + incoming.length);
                merged.set(existing, 0);
                merged.set(incoming, existing.length);
                src.data = bytesToBase64(merged);
            }
            break;
        }

        case EventType.DATA_BLOCK_END:
            break;

        case EventType.TOOL_CALL_START:
            msg.content.push({
                type: 'tool_call',
                id: event.tool_call_id,
                name: event.tool_call_name,
                input: '',
                state: 'pending',
            });
            break;

        case EventType.TOOL_CALL_DELTA: {
            const block = findBlock(msg, 'tool_call', event.tool_call_id);
            if (!block) {
                console.warn(`ToolCallBlock "${event.tool_call_id}" not found, skipping.`);
            } else {
                (block as ToolCallBlock).input += event.delta;
            }
            break;
        }

        case EventType.TOOL_CALL_END:
            break;

        case EventType.TOOL_RESULT_START:
            msg.content.push({
                type: 'tool_result',
                id: event.tool_call_id,
                name: event.tool_call_name,
                output: [],
                state: 'running',
            });
            break;

        case EventType.TOOL_RESULT_TEXT_DELTA: {
            const block = findBlock(msg, 'tool_result', event.tool_call_id);
            if (!block) {
                console.warn(`ToolResultBlock "${event.tool_call_id}" not found, skipping.`);
            } else {
                const trb = block as ToolResultBlock;
                if (typeof trb.output === 'string') {
                    trb.output = [{ type: 'text', id: crypto.randomUUID(), text: trb.output }];
                }
                const last = trb.output[trb.output.length - 1];
                if (!last || last.type !== 'text') {
                    trb.output.push({
                        type: 'text',
                        id: crypto.randomUUID(),
                        text: event.delta,
                    });
                } else {
                    (last as TextBlock).text += event.delta;
                }
            }
            break;
        }

        case EventType.TOOL_RESULT_DATA_DELTA: {
            const block = findBlock(msg, 'tool_result', event.tool_call_id);
            if (!block) {
                console.warn(`ToolResultBlock "${event.tool_call_id}" not found, skipping.`);
            } else {
                const trb = block as ToolResultBlock;
                if (typeof trb.output === 'string') {
                    trb.output = [{ type: 'text', id: crypto.randomUUID(), text: trb.output }];
                }
                const source: Base64Source | URLSource =
                    event.data != null
                        ? { type: 'base64', data: event.data, media_type: event.media_type }
                        : { type: 'url', url: event.url!, media_type: event.media_type };
                trb.output.push({
                    type: 'data',
                    id: event.block_id ?? crypto.randomUUID(),
                    source,
                });
            }
            break;
        }

        case EventType.TOOL_RESULT_END: {
            const block = findBlock(msg, 'tool_result', event.tool_call_id);
            if (!block) {
                console.warn(`ToolResultBlock "${event.tool_call_id}" not found, skipping.`);
            } else {
                (block as ToolResultBlock).state = event.state;
            }
            break;
        }

        case EventType.MODEL_CALL_END:
            // Accumulated the input and output tokens here.
            if (msg.usage) {
                msg.usage.input_tokens += event.input_tokens;
                msg.usage.output_tokens += event.output_tokens;
            } else {
                msg.usage = {
                    input_tokens: event.input_tokens,
                    output_tokens: event.output_tokens,
                };
            }
            break;

        case EventType.REQUIRE_USER_CONFIRM:
            for (const tc of event.tool_calls) {
                const b = findBlock(msg, 'tool_call', tc.id);
                if (b) {
                    (b as ToolCallBlock).state = 'asking';
                    (b as ToolCallBlock).suggested_rules = tc.suggested_rules || [];
                }
            }
            break;

        case EventType.USER_CONFIRM_RESULT:
            for (const result of event.confirm_results) {
                const b = findBlock(msg, 'tool_call', result.tool_call.id);
                if (b) {
                    (b as ToolCallBlock).state = result.confirmed ? 'allowed' : 'finished';
                }
            }
            break;

        case EventType.REQUIRE_EXTERNAL_EXECUTION:
            for (const tc of event.tool_calls) {
                const b = findBlock(msg, 'tool_call', tc.id);
                if (b) (b as ToolCallBlock).state = 'submitted';
            }
            break;

        case EventType.EXTERNAL_EXECUTION_RESULT:
            for (const result of event.execution_results) {
                msg.content.push(result);
            }
            break;
    }

    return msg;
}
