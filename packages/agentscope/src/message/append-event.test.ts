import { Msg, createMsg, appendEvent } from './message';
import { EventType, AgentEvent, ReplyFinishedReason } from '../event';
import {
    ContentBlock,
    DataBlock,
    TextBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
} from './block';
import { PermissionRule } from '../permission';

// Fixed IDs used throughout
const REPLY_ID = 'reply_001';
const SESSION_ID = 'session_001';

const B_TEXT = 'b_text_001';
const B_THINK = 'b_think_001';
const B_DATA = 'b_data_001';

const TC_ALLOW = 'tc_allow_001';
const TC_DENY = 'tc_deny_001';
const TC_EXT = 'tc_ext_001';
const TC_IMG = 'tc_img_001';

const RES_DATA_B = 'res_data_001';
const RES_URL_B = 'res_url_001';

const FIXED_END_TS = '2026-01-01T12:00:00';

/**
 * Deterministic ISO timestamp for the nth event in a sequence.
 * @param n
 * @returns An ISO-8601 timestamp string.
 */
function ts(n: number): string {
    return `2024-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
}

// Block-dict helpers
/**
 * Creates a text block dict for testing.
 * @param blockId
 * @param text
 * @param createdAt
 * @param finishedAt
 * @returns A text block object.
 */
function tb(blockId: string, text: string, createdAt: string, finishedAt?: string): TextBlock {
    return { type: 'text', id: blockId, text, created_at: createdAt, finished_at: finishedAt };
}

/**
 * Creates a thinking block dict for testing.
 * @param blockId
 * @param thinking
 * @param createdAt
 * @param finishedAt
 * @returns A thinking block object.
 */
function thb(
    blockId: string,
    thinking: string,
    createdAt: string,
    finishedAt?: string
): ThinkingBlock {
    return {
        type: 'thinking',
        id: blockId,
        thinking,
        created_at: createdAt,
        finished_at: finishedAt,
    };
}

/**
 * Creates a base64 data block dict for testing.
 * @param blockId
 * @param data
 * @param mediaType
 * @param createdAt
 * @param finishedAt
 * @returns A base64 data block object.
 */
function dbB64(
    blockId: string,
    data: string,
    mediaType: string,
    createdAt: string,
    finishedAt?: string
): DataBlock {
    return {
        type: 'data',
        id: blockId,
        source: { type: 'base64', data, media_type: mediaType },
        created_at: createdAt,
        finished_at: finishedAt,
    };
}

/**
 * Creates a URL data block dict for testing.
 * @param blockId
 * @param url
 * @param mediaType
 * @param createdAt
 * @param finishedAt
 * @returns A URL data block object.
 */
function dbUrl(
    blockId: string,
    url: string,
    mediaType: string,
    createdAt: string,
    finishedAt?: string
): DataBlock {
    return {
        type: 'data',
        id: blockId,
        source: { type: 'url', url, media_type: mediaType },
        created_at: createdAt,
        finished_at: finishedAt,
    };
}

/**
 * Creates a tool call block dict for testing.
 * @param tcId
 * @param name
 * @param inp
 * @param state
 * @param createdAt
 * @param finishedAt
 * @param suggestedRules
 * @returns A tool call block object.
 */
function tcb(
    tcId: string,
    name: string,
    inp: string,
    state: ToolCallBlock['state'],
    createdAt: string,
    finishedAt?: string,
    suggestedRules?: PermissionRule[]
): ToolCallBlock {
    const block: ToolCallBlock = {
        type: 'tool_call',
        id: tcId,
        name,
        input: inp,
        state,
        created_at: createdAt,
        finished_at: finishedAt,
    };
    if (suggestedRules !== undefined) block.suggested_rules = suggestedRules;
    return block;
}

/**
 * Creates a tool result block dict for testing.
 * @param tcId
 * @param name
 * @param output
 * @param state
 * @param createdAt
 * @param finishedAt
 * @returns A tool result block object.
 */
function trb(
    tcId: string,
    name: string,
    output: ToolResultBlock['output'],
    state: ToolResultBlock['state'],
    createdAt: string,
    finishedAt?: string
): ToolResultBlock {
    return {
        type: 'tool_result',
        id: tcId,
        name,
        output,
        state,
        created_at: createdAt,
        finished_at: finishedAt,
    };
}

describe('appendEvent', () => {
    let msg: Msg;
    let createdAt: string;

    beforeEach(() => {
        msg = createMsg({
            id: REPLY_ID,
            name: 'TestAgent',
            role: 'assistant',
            content: [],
        });
        createdAt = msg.created_at;
    });

    /**
     * Creates a base message object for comparison in tests.
     * @param content
     * @param finishedAt
     * @param finishedReason
     * @returns A plain message object for comparison.
     */
    function base(
        content: ContentBlock[],
        finishedAt: string | null = null,
        finishedReason: ReplyFinishedReason | null = null
    ) {
        return {
            id: REPLY_ID,
            name: 'TestAgent',
            role: 'assistant',
            metadata: {},
            created_at: createdAt,
            finished_at: finishedAt,
            finished_reason: finishedReason,
            error: null,
            content,
        };
    }

    /**
     * Extracts a plain object representation of a Msg for comparison.
     * @param m
     * @returns A plain object with message fields.
     */
    function msgDump(m: Msg) {
        return {
            id: m.id,
            name: m.name,
            role: m.role,
            metadata: m.metadata,
            created_at: m.created_at,
            finished_at: m.finished_at ?? null,
            finished_reason: m.finished_reason ?? null,
            error: m.error ?? null,
            content: m.content,
        };
    }

    test('full streaming event sequence', () => {
        const events: AgentEvent[] = [];
        const groundTruths: ReturnType<typeof base>[] = [];

        // Stage 1: Text block streaming
        // START stamps created_at from the event; END stamps finished_at.
        events.push({
            id: '1',
            created_at: ts(1),
            type: EventType.TEXT_BLOCK_START,
            reply_id: REPLY_ID,
            block_id: B_TEXT,
        });
        groundTruths.push(base([tb(B_TEXT, '', ts(1))]));

        events.push({
            id: '2',
            created_at: ts(2),
            type: EventType.TEXT_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_TEXT,
            delta: 'Hello',
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello', ts(1))]));

        events.push({
            id: '3',
            created_at: ts(3),
            type: EventType.TEXT_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_TEXT,
            delta: ' World',
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello World', ts(1))]));

        events.push({
            id: '4',
            created_at: ts(4),
            type: EventType.TEXT_BLOCK_END,
            reply_id: REPLY_ID,
            block_id: B_TEXT,
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello World', ts(1), ts(4))]));

        // Finished text block reused in all later ground truths.
        const TB_DONE = tb(B_TEXT, 'Hello World', ts(1), ts(4));

        // Stage 2: Thinking block streaming
        events.push({
            id: '5',
            created_at: ts(5),
            type: EventType.THINKING_BLOCK_START,
            reply_id: REPLY_ID,
            block_id: B_THINK,
        });
        groundTruths.push(base([TB_DONE, thb(B_THINK, '', ts(5))]));

        events.push({
            id: '6',
            created_at: ts(6),
            type: EventType.THINKING_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_THINK,
            delta: 'Let me',
        });
        groundTruths.push(base([TB_DONE, thb(B_THINK, 'Let me', ts(5))]));

        events.push({
            id: '7',
            created_at: ts(7),
            type: EventType.THINKING_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_THINK,
            delta: ' think',
        });
        groundTruths.push(base([TB_DONE, thb(B_THINK, 'Let me think', ts(5))]));

        events.push({
            id: '8',
            created_at: ts(8),
            type: EventType.THINKING_BLOCK_END,
            reply_id: REPLY_ID,
            block_id: B_THINK,
        });
        groundTruths.push(base([TB_DONE, thb(B_THINK, 'Let me think', ts(5), ts(8))]));

        const THB_DONE = thb(B_THINK, 'Let me think', ts(5), ts(8));

        // Stage 3: Data block streaming (base64)
        events.push({
            id: '9',
            created_at: ts(9),
            type: EventType.DATA_BLOCK_START,
            reply_id: REPLY_ID,
            block_id: B_DATA,
            media_type: 'image/png',
        });
        groundTruths.push(base([TB_DONE, THB_DONE, dbB64(B_DATA, '', 'image/png', ts(9))]));

        // Use independently base64-encoded chunks whose raw byte lengths
        // aren't multiples of 3 — each chunk's base64 carries its own '='
        // padding. The accumulated base64 must equal base64(concat(raw
        // bytes)), NOT string-concat of the per-chunk base64 (which would
        // splice padding into the middle of the stream and corrupt it).
        const DATA_CHUNK_1 = Buffer.from([0x01, 0x02]).toString('base64'); // "AQI="
        const DATA_CHUNK_2 = Buffer.from([0x03]).toString('base64'); // "Aw=="
        const DATA_MERGED = Buffer.from([0x01, 0x02, 0x03]).toString('base64'); // "AQID"

        events.push({
            id: '10',
            created_at: ts(10),
            type: EventType.DATA_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_DATA,
            data: DATA_CHUNK_1,
            media_type: 'image/png',
        });
        groundTruths.push(
            base([TB_DONE, THB_DONE, dbB64(B_DATA, DATA_CHUNK_1, 'image/png', ts(9))])
        );

        events.push({
            id: '11',
            created_at: ts(11),
            type: EventType.DATA_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_DATA,
            data: DATA_CHUNK_2,
            media_type: 'image/png',
        });
        groundTruths.push(
            base([TB_DONE, THB_DONE, dbB64(B_DATA, DATA_MERGED, 'image/png', ts(9))])
        );

        events.push({
            id: '12',
            created_at: ts(12),
            type: EventType.DATA_BLOCK_END,
            reply_id: REPLY_ID,
            block_id: B_DATA,
        });
        groundTruths.push(
            base([TB_DONE, THB_DONE, dbB64(B_DATA, DATA_MERGED, 'image/png', ts(9), ts(12))])
        );

        // Stage 4: ToolCall → confirm (allowed) + text result (success)
        const s4Prefix = [
            TB_DONE,
            THB_DONE,
            dbB64(B_DATA, DATA_MERGED, 'image/png', ts(9), ts(12)),
        ];

        events.push({
            id: '13',
            created_at: ts(13),
            type: EventType.TOOL_CALL_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            tool_call_name: 'search',
        });
        groundTruths.push(base([...s4Prefix, tcb(TC_ALLOW, 'search', '', 'pending', ts(13))]));

        events.push({
            id: '14',
            created_at: ts(14),
            type: EventType.TOOL_CALL_DELTA,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            delta: '{"q"',
        });
        groundTruths.push(base([...s4Prefix, tcb(TC_ALLOW, 'search', '{"q"', 'pending', ts(13))]));

        events.push({
            id: '15',
            created_at: ts(15),
            type: EventType.TOOL_CALL_DELTA,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            delta: ': "hi"}',
        });
        groundTruths.push(
            base([...s4Prefix, tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'pending', ts(13))])
        );

        events.push({
            id: '16',
            created_at: ts(16),
            type: EventType.TOOL_CALL_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
        });
        groundTruths.push(
            base([...s4Prefix, tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'pending', ts(13), ts(16))])
        );

        // RequireUserConfirmEvent → state: pending → asking
        const tcAllowBlock: ToolCallBlock = {
            type: 'tool_call',
            id: TC_ALLOW,
            name: 'search',
            input: '{"q": "hi"}',
            state: 'pending',
            created_at: ts(13),
        };
        events.push({
            id: '17',
            created_at: ts(17),
            type: EventType.REQUIRE_USER_CONFIRM,
            reply_id: REPLY_ID,
            tool_calls: [tcAllowBlock],
        });
        groundTruths.push(
            base([
                ...s4Prefix,
                tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'asking', ts(13), ts(16), []),
            ])
        );

        // UserConfirmResultEvent (confirmed=true) → state: asking → allowed
        events.push({
            id: '18',
            created_at: ts(18),
            type: EventType.USER_CONFIRM_RESULT,
            reply_id: REPLY_ID,
            confirm_results: [{ confirmed: true, tool_call: tcAllowBlock }],
        });
        groundTruths.push(
            base([
                ...s4Prefix,
                tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'allowed', ts(13), ts(16), []),
            ])
        );

        // ToolResult for TC_ALLOW - text output
        events.push({
            id: '19',
            created_at: ts(19),
            type: EventType.TOOL_RESULT_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            tool_call_name: 'search',
        });
        const s4bPrefix = [
            ...s4Prefix,
            tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'allowed', ts(13), ts(16), []),
        ];
        groundTruths.push(base([...s4bPrefix, trb(TC_ALLOW, 'search', [], 'running', ts(19))]));

        // ToolResult text deltas — the nested TextBlock is created with the
        // first delta event's timestamp.
        events.push({
            id: '20',
            created_at: ts(20),
            type: EventType.TOOL_RESULT_TEXT_DELTA,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            delta: 'Found:',
        });
        groundTruths.push(
            base([
                ...s4bPrefix,
                trb(
                    TC_ALLOW,
                    'search',
                    [
                        {
                            type: 'text',
                            id: expect.any(String),
                            text: 'Found:',
                            created_at: ts(20),
                        },
                    ],
                    'running',
                    ts(19)
                ),
            ])
        );

        events.push({
            id: '21',
            created_at: ts(21),
            type: EventType.TOOL_RESULT_TEXT_DELTA,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            delta: ' 3 items',
        });
        groundTruths.push(
            base([
                ...s4bPrefix,
                trb(
                    TC_ALLOW,
                    'search',
                    [
                        {
                            type: 'text',
                            id: expect.any(String),
                            text: 'Found: 3 items',
                            created_at: ts(20),
                        },
                    ],
                    'running',
                    ts(19)
                ),
            ])
        );

        events.push({
            id: '22',
            created_at: ts(22),
            type: EventType.TOOL_RESULT_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            state: 'success',
        });
        // After TOOL_RESULT_END the paired tool_call flips to 'finished' and
        // the tool_result gets finished_at from the event.
        const s4cPrefix = [
            ...s4Prefix,
            tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'finished', ts(13), ts(16), []),
        ];
        groundTruths.push(
            base([
                ...s4cPrefix,
                trb(
                    TC_ALLOW,
                    'search',
                    [
                        {
                            type: 'text',
                            id: expect.any(String),
                            text: 'Found: 3 items',
                            created_at: ts(20),
                        },
                    ],
                    'success',
                    ts(19),
                    ts(22)
                ),
            ])
        );

        // Stage 5: ToolCall (TC_DENY) → confirm → denied (finished)
        const s5Prefix = [
            ...s4cPrefix,
            trb(
                TC_ALLOW,
                'search',
                [
                    {
                        type: 'text',
                        id: expect.any(String),
                        text: 'Found: 3 items',
                        created_at: ts(20),
                    },
                ],
                'success',
                ts(19),
                ts(22)
            ),
        ];

        events.push({
            id: '23',
            created_at: ts(23),
            type: EventType.TOOL_CALL_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_DENY,
            tool_call_name: 'delete',
        });
        groundTruths.push(base([...s5Prefix, tcb(TC_DENY, 'delete', '', 'pending', ts(23))]));

        events.push({
            id: '24',
            created_at: ts(24),
            type: EventType.TOOL_CALL_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_DENY,
        });
        groundTruths.push(
            base([...s5Prefix, tcb(TC_DENY, 'delete', '', 'pending', ts(23), ts(24))])
        );

        const tcDenyBlock: ToolCallBlock = {
            type: 'tool_call',
            id: TC_DENY,
            name: 'delete',
            input: '',
            state: 'pending',
            created_at: ts(23),
        };
        events.push({
            id: '25',
            created_at: ts(25),
            type: EventType.REQUIRE_USER_CONFIRM,
            reply_id: REPLY_ID,
            tool_calls: [tcDenyBlock],
        });
        groundTruths.push(
            base([...s5Prefix, tcb(TC_DENY, 'delete', '', 'asking', ts(23), ts(24), [])])
        );

        events.push({
            id: '26',
            created_at: ts(26),
            type: EventType.USER_CONFIRM_RESULT,
            reply_id: REPLY_ID,
            confirm_results: [{ confirmed: false, tool_call: tcDenyBlock }],
        });
        groundTruths.push(
            base([...s5Prefix, tcb(TC_DENY, 'delete', '', 'finished', ts(23), ts(24), [])])
        );

        // Stage 6: ToolCall (TC_EXT) → external execution
        const s6Prefix = [...s5Prefix, tcb(TC_DENY, 'delete', '', 'finished', ts(23), ts(24), [])];

        events.push({
            id: '27',
            created_at: ts(27),
            type: EventType.TOOL_CALL_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_EXT,
            tool_call_name: 'run_code',
        });
        groundTruths.push(base([...s6Prefix, tcb(TC_EXT, 'run_code', '', 'pending', ts(27))]));

        events.push({
            id: '28',
            created_at: ts(28),
            type: EventType.TOOL_CALL_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_EXT,
        });
        groundTruths.push(
            base([...s6Prefix, tcb(TC_EXT, 'run_code', '', 'pending', ts(27), ts(28))])
        );

        const tcExtBlock: ToolCallBlock = {
            type: 'tool_call',
            id: TC_EXT,
            name: 'run_code',
            input: '',
            state: 'pending',
            created_at: ts(27),
        };
        events.push({
            id: '29',
            created_at: ts(29),
            type: EventType.REQUIRE_EXTERNAL_EXECUTION,
            reply_id: REPLY_ID,
            tool_calls: [tcExtBlock],
        });
        groundTruths.push(
            base([...s6Prefix, tcb(TC_EXT, 'run_code', '', 'submitted', ts(27), ts(28))])
        );

        // ExternalExecutionResultEvent — the appended result block keeps its
        // own created_at; a missing finished_at is filled from the event.
        const EXT_RES_CREATED = '2024-01-01T00:00:29.500Z';
        const extResultBlock: ToolResultBlock = {
            type: 'tool_result',
            id: TC_EXT,
            name: 'run_code',
            output: 'output: hello',
            state: 'success',
            created_at: EXT_RES_CREATED,
        };
        events.push({
            id: '30',
            created_at: ts(30),
            type: EventType.EXTERNAL_EXECUTION_RESULT,
            reply_id: REPLY_ID,
            execution_results: [extResultBlock],
        });
        const s6bPrefix = [...s6Prefix, tcb(TC_EXT, 'run_code', '', 'submitted', ts(27), ts(28))];
        groundTruths.push(
            base([
                ...s6bPrefix,
                trb(TC_EXT, 'run_code', 'output: hello', 'success', EXT_RES_CREATED, ts(30)),
            ])
        );

        // Stage 7: ToolResult with data output (base64 + URL)
        const s7Prefix = [
            ...s6bPrefix,
            trb(TC_EXT, 'run_code', 'output: hello', 'success', EXT_RES_CREATED, ts(30)),
        ];

        events.push({
            id: '31',
            created_at: ts(31),
            type: EventType.TOOL_CALL_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
            tool_call_name: 'screenshot',
        });
        groundTruths.push(base([...s7Prefix, tcb(TC_IMG, 'screenshot', '', 'pending', ts(31))]));

        events.push({
            id: '32',
            created_at: ts(32),
            type: EventType.TOOL_CALL_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
        });
        groundTruths.push(
            base([...s7Prefix, tcb(TC_IMG, 'screenshot', '', 'pending', ts(31), ts(32))])
        );

        events.push({
            id: '33',
            created_at: ts(33),
            type: EventType.TOOL_RESULT_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
            tool_call_name: 'screenshot',
        });
        const s7bPrefix = [...s7Prefix, tcb(TC_IMG, 'screenshot', '', 'pending', ts(31), ts(32))];
        groundTruths.push(base([...s7bPrefix, trb(TC_IMG, 'screenshot', [], 'running', ts(33))]));

        events.push({
            id: '34',
            created_at: ts(34),
            type: EventType.TOOL_RESULT_DATA_DELTA,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
            block_id: RES_DATA_B,
            media_type: 'image/png',
            data: 'iVBOR==',
        });
        groundTruths.push(
            base([
                ...s7bPrefix,
                trb(
                    TC_IMG,
                    'screenshot',
                    [dbB64(RES_DATA_B, 'iVBOR==', 'image/png', ts(34))],
                    'running',
                    ts(33)
                ),
            ])
        );

        events.push({
            id: '35',
            created_at: ts(35),
            type: EventType.TOOL_RESULT_DATA_DELTA,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
            block_id: RES_URL_B,
            media_type: 'image/jpeg',
            url: 'https://example.com/img.jpg',
        });
        groundTruths.push(
            base([
                ...s7bPrefix,
                trb(
                    TC_IMG,
                    'screenshot',
                    [
                        dbB64(RES_DATA_B, 'iVBOR==', 'image/png', ts(34)),
                        dbUrl(RES_URL_B, 'https://example.com/img.jpg', 'image/jpeg', ts(35)),
                    ],
                    'running',
                    ts(33)
                ),
            ])
        );

        events.push({
            id: '36',
            created_at: ts(36),
            type: EventType.TOOL_RESULT_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
            state: 'error',
        });
        // After TOOL_RESULT_END the paired tool_call flips to 'finished'.
        const s7cPrefix = [...s7Prefix, tcb(TC_IMG, 'screenshot', '', 'finished', ts(31), ts(32))];
        groundTruths.push(
            base([
                ...s7cPrefix,
                trb(
                    TC_IMG,
                    'screenshot',
                    [
                        dbB64(RES_DATA_B, 'iVBOR==', 'image/png', ts(34)),
                        dbUrl(RES_URL_B, 'https://example.com/img.jpg', 'image/jpeg', ts(35)),
                    ],
                    'error',
                    ts(33),
                    ts(36)
                ),
            ])
        );

        // Stage 8: ReplyEnd
        events.push({
            id: '37',
            created_at: FIXED_END_TS,
            type: EventType.REPLY_END,
            reply_id: REPLY_ID,
            session_id: SESSION_ID,
            finished_reason: ReplyFinishedReason.COMPLETED,
        });
        const finalContent = [
            ...s7cPrefix,
            trb(
                TC_IMG,
                'screenshot',
                [
                    dbB64(RES_DATA_B, 'iVBOR==', 'image/png', ts(34)),
                    dbUrl(RES_URL_B, 'https://example.com/img.jpg', 'image/jpeg', ts(35)),
                ],
                'error',
                ts(33),
                ts(36)
            ),
        ];
        groundTruths.push(base(finalContent, FIXED_END_TS, ReplyFinishedReason.COMPLETED));

        // Apply all events and check ground truths
        expect(events.length).toBe(groundTruths.length);
        for (let i = 0; i < events.length; i++) {
            appendEvent(msg, events[i]);
            expect(msgDump(msg)).toEqual(groundTruths[i]);
        }
    });

    test('wrong reply_id is skipped', () => {
        const original = msgDump(msg);
        const wrongEvent: AgentEvent = {
            id: 'x',
            created_at: ts(1),
            type: EventType.TEXT_BLOCK_START,
            reply_id: 'totally_wrong_id',
            block_id: 'should_not_appear',
        };
        appendEvent(msg, wrongEvent);
        expect(msgDump(msg)).toEqual(original);
    });

    test('HINT_BLOCK one-shot event appends a complete HintBlock', () => {
        const HINT_ID_1 = 'h_001';
        const HINT_ID_2 = 'h_002';

        // String hint with source — created_at and finished_at both come
        // from the one-shot event's timestamp.
        appendEvent(msg, {
            id: 'e1',
            created_at: ts(1),
            type: EventType.HINT_BLOCK,
            reply_id: REPLY_ID,
            block_id: HINT_ID_1,
            source: 'alice',
            hint: 'Please review my code',
        });
        expect(msg.content).toEqual([
            {
                type: 'hint',
                id: HINT_ID_1,
                hint: 'Please review my code',
                source: 'alice',
                created_at: ts(1),
                finished_at: ts(1),
            },
        ]);

        // Multimodal hint (list of text + data blocks), source omitted → null
        const hintBlocks: (TextBlock | DataBlock)[] = [
            { type: 'text', id: 'tb1', text: 'See screenshot:', created_at: ts(2) },
            {
                type: 'data',
                id: 'db1',
                source: { type: 'url', url: 'https://example.com/x.png', media_type: 'image/png' },
                created_at: ts(2),
            },
        ];
        appendEvent(msg, {
            id: 'e2',
            created_at: ts(2),
            type: EventType.HINT_BLOCK,
            reply_id: REPLY_ID,
            block_id: HINT_ID_2,
            hint: hintBlocks,
        });
        expect(msg.content).toHaveLength(2);
        expect(msg.content[1]).toEqual({
            type: 'hint',
            id: HINT_ID_2,
            hint: hintBlocks,
            source: null,
            created_at: ts(2),
            finished_at: ts(2),
        });
    });

    test('missing block does not crash', () => {
        const original = msgDump(msg);
        const ghostEvents: AgentEvent[] = [
            {
                id: 'g1',
                created_at: ts(1),
                type: EventType.TEXT_BLOCK_DELTA,
                reply_id: REPLY_ID,
                block_id: 'ghost',
                delta: 'x',
            },
            {
                id: 'g2',
                created_at: ts(2),
                type: EventType.THINKING_BLOCK_DELTA,
                reply_id: REPLY_ID,
                block_id: 'ghost',
                delta: 'x',
            },
            {
                id: 'g3',
                created_at: ts(3),
                type: EventType.DATA_BLOCK_DELTA,
                reply_id: REPLY_ID,
                block_id: 'ghost',
                data: 'x',
                media_type: 'image/png',
            },
            {
                id: 'g4',
                created_at: ts(4),
                type: EventType.TOOL_CALL_DELTA,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
                delta: 'x',
            },
            {
                id: 'g5',
                created_at: ts(5),
                type: EventType.TOOL_RESULT_TEXT_DELTA,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
                delta: 'x',
            },
            {
                id: 'g6',
                created_at: ts(6),
                type: EventType.TOOL_RESULT_DATA_DELTA,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
                block_id: 'b',
                media_type: 'image/png',
                data: 'x',
            },
            {
                id: 'g7',
                created_at: ts(7),
                type: EventType.TOOL_RESULT_END,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
                state: 'success',
            },
            {
                id: 'g8',
                created_at: ts(8),
                type: EventType.TEXT_BLOCK_END,
                reply_id: REPLY_ID,
                block_id: 'ghost',
            },
            {
                id: 'g9',
                created_at: ts(9),
                type: EventType.THINKING_BLOCK_END,
                reply_id: REPLY_ID,
                block_id: 'ghost',
            },
            {
                id: 'g10',
                created_at: ts(10),
                type: EventType.DATA_BLOCK_END,
                reply_id: REPLY_ID,
                block_id: 'ghost',
            },
            {
                id: 'g11',
                created_at: ts(11),
                type: EventType.TOOL_CALL_END,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
            },
        ];
        for (const ev of ghostEvents) {
            appendEvent(msg, ev);
        }
        expect(msgDump(msg)).toEqual(original);
    });
});
