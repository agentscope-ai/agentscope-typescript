import { Msg, createMsg, appendEvent } from './message';
import { EventType, AgentEvent } from '../event';
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

// Block-dict helpers
/**
 * Creates a text block dict for testing.
 * @param blockId
 * @param text
 * @returns A text block object.
 */
function tb(blockId: string, text: string): TextBlock {
    return { type: 'text', id: blockId, text };
}

/**
 * Creates a thinking block dict for testing.
 * @param blockId
 * @param thinking
 * @returns A thinking block object.
 */
function thb(blockId: string, thinking: string): ThinkingBlock {
    return { type: 'thinking', id: blockId, thinking };
}

/**
 * Creates a base64 data block dict for testing.
 * @param blockId
 * @param data
 * @param mediaType
 * @returns A base64 data block object.
 */
function dbB64(blockId: string, data: string, mediaType: string): DataBlock {
    return {
        type: 'data',
        id: blockId,
        source: { type: 'base64', data, media_type: mediaType },
    };
}

/**
 * Creates a URL data block dict for testing.
 * @param blockId
 * @param url
 * @param mediaType
 * @returns A URL data block object.
 */
function dbUrl(blockId: string, url: string, mediaType: string): DataBlock {
    return {
        type: 'data',
        id: blockId,
        source: { type: 'url', url, media_type: mediaType },
    };
}

/**
 * Creates a tool call block dict for testing.
 * @param tcId
 * @param name
 * @param inp
 * @param state
 * @param suggestedRules
 * @returns A tool call block object.
 */
function tcb(
    tcId: string,
    name: string,
    inp: string,
    state: ToolCallBlock['state'],
    suggestedRules?: PermissionRule[]
): ToolCallBlock {
    const block: ToolCallBlock = { type: 'tool_call', id: tcId, name, input: inp, state };
    if (suggestedRules !== undefined) block.suggested_rules = suggestedRules;
    return block;
}

/**
 * Creates a tool result block dict for testing.
 * @param tcId
 * @param name
 * @param output
 * @param state
 * @returns A tool result block object.
 */
function trb(
    tcId: string,
    name: string,
    output: ToolResultBlock['output'],
    state: ToolResultBlock['state']
): ToolResultBlock {
    return { type: 'tool_result', id: tcId, name, output, state };
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
     * @returns A plain message object for comparison.
     */
    function base(content: ContentBlock[], finishedAt: string | null = null) {
        return {
            id: REPLY_ID,
            name: 'TestAgent',
            role: 'assistant',
            metadata: {},
            created_at: createdAt,
            finished_at: finishedAt,
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
            content: m.content,
        };
    }

    test('full streaming event sequence', () => {
        const events: AgentEvent[] = [];
        const groundTruths: ReturnType<typeof base>[] = [];

        // Stage 1: Text block streaming
        events.push({
            id: '1',
            created_at: '',
            type: EventType.TEXT_BLOCK_START,
            reply_id: REPLY_ID,
            block_id: B_TEXT,
        });
        groundTruths.push(base([tb(B_TEXT, '')]));

        events.push({
            id: '2',
            created_at: '',
            type: EventType.TEXT_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_TEXT,
            delta: 'Hello',
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello')]));

        events.push({
            id: '3',
            created_at: '',
            type: EventType.TEXT_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_TEXT,
            delta: ' World',
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello World')]));

        events.push({
            id: '4',
            created_at: '',
            type: EventType.TEXT_BLOCK_END,
            reply_id: REPLY_ID,
            block_id: B_TEXT,
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello World')]));

        // Stage 2: Thinking block streaming
        events.push({
            id: '5',
            created_at: '',
            type: EventType.THINKING_BLOCK_START,
            reply_id: REPLY_ID,
            block_id: B_THINK,
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello World'), thb(B_THINK, '')]));

        events.push({
            id: '6',
            created_at: '',
            type: EventType.THINKING_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_THINK,
            delta: 'Let me',
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello World'), thb(B_THINK, 'Let me')]));

        events.push({
            id: '7',
            created_at: '',
            type: EventType.THINKING_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_THINK,
            delta: ' think',
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello World'), thb(B_THINK, 'Let me think')]));

        events.push({
            id: '8',
            created_at: '',
            type: EventType.THINKING_BLOCK_END,
            reply_id: REPLY_ID,
            block_id: B_THINK,
        });
        groundTruths.push(base([tb(B_TEXT, 'Hello World'), thb(B_THINK, 'Let me think')]));

        // Stage 3: Data block streaming (base64)
        events.push({
            id: '9',
            created_at: '',
            type: EventType.DATA_BLOCK_START,
            reply_id: REPLY_ID,
            block_id: B_DATA,
            media_type: 'image/png',
        });
        groundTruths.push(
            base([
                tb(B_TEXT, 'Hello World'),
                thb(B_THINK, 'Let me think'),
                dbB64(B_DATA, '', 'image/png'),
            ])
        );

        events.push({
            id: '10',
            created_at: '',
            type: EventType.DATA_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_DATA,
            data: 'abc',
            media_type: 'image/png',
        });
        groundTruths.push(
            base([
                tb(B_TEXT, 'Hello World'),
                thb(B_THINK, 'Let me think'),
                dbB64(B_DATA, 'abc', 'image/png'),
            ])
        );

        events.push({
            id: '11',
            created_at: '',
            type: EventType.DATA_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: B_DATA,
            data: 'def',
            media_type: 'image/png',
        });
        groundTruths.push(
            base([
                tb(B_TEXT, 'Hello World'),
                thb(B_THINK, 'Let me think'),
                dbB64(B_DATA, 'abcdef', 'image/png'),
            ])
        );

        events.push({
            id: '12',
            created_at: '',
            type: EventType.DATA_BLOCK_END,
            reply_id: REPLY_ID,
            block_id: B_DATA,
        });
        groundTruths.push(
            base([
                tb(B_TEXT, 'Hello World'),
                thb(B_THINK, 'Let me think'),
                dbB64(B_DATA, 'abcdef', 'image/png'),
            ])
        );

        // Stage 4: ToolCall → confirm (allowed) + text result (success)
        const s4Prefix = [
            tb(B_TEXT, 'Hello World'),
            thb(B_THINK, 'Let me think'),
            dbB64(B_DATA, 'abcdef', 'image/png'),
        ];

        events.push({
            id: '13',
            created_at: '',
            type: EventType.TOOL_CALL_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            tool_call_name: 'search',
        });
        groundTruths.push(base([...s4Prefix, tcb(TC_ALLOW, 'search', '', 'pending')]));

        events.push({
            id: '14',
            created_at: '',
            type: EventType.TOOL_CALL_DELTA,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            delta: '{"q"',
        });
        groundTruths.push(base([...s4Prefix, tcb(TC_ALLOW, 'search', '{"q"', 'pending')]));

        events.push({
            id: '15',
            created_at: '',
            type: EventType.TOOL_CALL_DELTA,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            delta: ': "hi"}',
        });
        groundTruths.push(base([...s4Prefix, tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'pending')]));

        events.push({
            id: '16',
            created_at: '',
            type: EventType.TOOL_CALL_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
        });
        groundTruths.push(base([...s4Prefix, tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'pending')]));

        // RequireUserConfirmEvent → state: pending → asking
        const tcAllowBlock: ToolCallBlock = {
            type: 'tool_call',
            id: TC_ALLOW,
            name: 'search',
            input: '{"q": "hi"}',
            state: 'pending',
        };
        events.push({
            id: '17',
            created_at: '',
            type: EventType.REQUIRE_USER_CONFIRM,
            reply_id: REPLY_ID,
            tool_calls: [tcAllowBlock],
        });
        groundTruths.push(
            base([...s4Prefix, tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'asking', [])])
        );

        // UserConfirmResultEvent (confirmed=true) → state: asking → allowed
        events.push({
            id: '18',
            created_at: '',
            type: EventType.USER_CONFIRM_RESULT,
            reply_id: REPLY_ID,
            confirm_results: [{ confirmed: true, tool_call: tcAllowBlock }],
        });
        groundTruths.push(
            base([...s4Prefix, tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'allowed', [])])
        );

        // ToolResult for TC_ALLOW - text output
        events.push({
            id: '19',
            created_at: '',
            type: EventType.TOOL_RESULT_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            tool_call_name: 'search',
        });
        const s4bPrefix = [...s4Prefix, tcb(TC_ALLOW, 'search', '{"q": "hi"}', 'allowed', [])];
        groundTruths.push(base([...s4bPrefix, trb(TC_ALLOW, 'search', [], 'running')]));

        // ToolResult text deltas
        events.push({
            id: '20',
            created_at: '',
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
                    [{ type: 'text', id: expect.any(String), text: 'Found:' }],
                    'running'
                ),
            ])
        );

        events.push({
            id: '21',
            created_at: '',
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
                    [{ type: 'text', id: expect.any(String), text: 'Found: 3 items' }],
                    'running'
                ),
            ])
        );

        events.push({
            id: '22',
            created_at: '',
            type: EventType.TOOL_RESULT_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_ALLOW,
            state: 'success',
        });
        groundTruths.push(
            base([
                ...s4bPrefix,
                trb(
                    TC_ALLOW,
                    'search',
                    [{ type: 'text', id: expect.any(String), text: 'Found: 3 items' }],
                    'success'
                ),
            ])
        );

        // Stage 5: ToolCall (TC_DENY) → confirm → denied (finished)
        const s5Prefix = [
            ...s4bPrefix,
            trb(
                TC_ALLOW,
                'search',
                [{ type: 'text', id: expect.any(String), text: 'Found: 3 items' }],
                'success'
            ),
        ];

        events.push({
            id: '23',
            created_at: '',
            type: EventType.TOOL_CALL_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_DENY,
            tool_call_name: 'delete',
        });
        groundTruths.push(base([...s5Prefix, tcb(TC_DENY, 'delete', '', 'pending')]));

        events.push({
            id: '24',
            created_at: '',
            type: EventType.TOOL_CALL_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_DENY,
        });
        groundTruths.push(base([...s5Prefix, tcb(TC_DENY, 'delete', '', 'pending')]));

        const tcDenyBlock: ToolCallBlock = {
            type: 'tool_call',
            id: TC_DENY,
            name: 'delete',
            input: '',
            state: 'pending',
        };
        events.push({
            id: '25',
            created_at: '',
            type: EventType.REQUIRE_USER_CONFIRM,
            reply_id: REPLY_ID,
            tool_calls: [tcDenyBlock],
        });
        groundTruths.push(base([...s5Prefix, tcb(TC_DENY, 'delete', '', 'asking', [])]));

        events.push({
            id: '26',
            created_at: '',
            type: EventType.USER_CONFIRM_RESULT,
            reply_id: REPLY_ID,
            confirm_results: [{ confirmed: false, tool_call: tcDenyBlock }],
        });
        groundTruths.push(base([...s5Prefix, tcb(TC_DENY, 'delete', '', 'finished', [])]));

        // Stage 6: ToolCall (TC_EXT) → external execution
        const s6Prefix = [...s5Prefix, tcb(TC_DENY, 'delete', '', 'finished', [])];

        events.push({
            id: '27',
            created_at: '',
            type: EventType.TOOL_CALL_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_EXT,
            tool_call_name: 'run_code',
        });
        groundTruths.push(base([...s6Prefix, tcb(TC_EXT, 'run_code', '', 'pending')]));

        events.push({
            id: '28',
            created_at: '',
            type: EventType.TOOL_CALL_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_EXT,
        });
        groundTruths.push(base([...s6Prefix, tcb(TC_EXT, 'run_code', '', 'pending')]));

        const tcExtBlock: ToolCallBlock = {
            type: 'tool_call',
            id: TC_EXT,
            name: 'run_code',
            input: '',
            state: 'pending',
        };
        events.push({
            id: '29',
            created_at: '',
            type: EventType.REQUIRE_EXTERNAL_EXECUTION,
            reply_id: REPLY_ID,
            tool_calls: [tcExtBlock],
        });
        groundTruths.push(base([...s6Prefix, tcb(TC_EXT, 'run_code', '', 'submitted')]));

        // ExternalExecutionResultEvent
        const extResultBlock: ToolResultBlock = {
            type: 'tool_result',
            id: TC_EXT,
            name: 'run_code',
            output: 'output: hello',
            state: 'success',
        };
        events.push({
            id: '30',
            created_at: '',
            type: EventType.EXTERNAL_EXECUTION_RESULT,
            reply_id: REPLY_ID,
            execution_results: [extResultBlock],
        });
        const s6bPrefix = [...s6Prefix, tcb(TC_EXT, 'run_code', '', 'submitted')];
        groundTruths.push(
            base([...s6bPrefix, trb(TC_EXT, 'run_code', 'output: hello', 'success')])
        );

        // Stage 7: ToolResult with data output (base64 + URL)
        const s7Prefix = [...s6bPrefix, trb(TC_EXT, 'run_code', 'output: hello', 'success')];

        events.push({
            id: '31',
            created_at: '',
            type: EventType.TOOL_CALL_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
            tool_call_name: 'screenshot',
        });
        groundTruths.push(base([...s7Prefix, tcb(TC_IMG, 'screenshot', '', 'pending')]));

        events.push({
            id: '32',
            created_at: '',
            type: EventType.TOOL_CALL_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
        });
        groundTruths.push(base([...s7Prefix, tcb(TC_IMG, 'screenshot', '', 'pending')]));

        events.push({
            id: '33',
            created_at: '',
            type: EventType.TOOL_RESULT_START,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
            tool_call_name: 'screenshot',
        });
        const s7bPrefix = [...s7Prefix, tcb(TC_IMG, 'screenshot', '', 'pending')];
        groundTruths.push(base([...s7bPrefix, trb(TC_IMG, 'screenshot', [], 'running')]));

        events.push({
            id: '34',
            created_at: '',
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
                trb(TC_IMG, 'screenshot', [dbB64(RES_DATA_B, 'iVBOR==', 'image/png')], 'running'),
            ])
        );

        events.push({
            id: '35',
            created_at: '',
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
                        dbB64(RES_DATA_B, 'iVBOR==', 'image/png'),
                        dbUrl(RES_URL_B, 'https://example.com/img.jpg', 'image/jpeg'),
                    ],
                    'running'
                ),
            ])
        );

        events.push({
            id: '36',
            created_at: '',
            type: EventType.TOOL_RESULT_END,
            reply_id: REPLY_ID,
            tool_call_id: TC_IMG,
            state: 'error',
        });
        groundTruths.push(
            base([
                ...s7bPrefix,
                trb(
                    TC_IMG,
                    'screenshot',
                    [
                        dbB64(RES_DATA_B, 'iVBOR==', 'image/png'),
                        dbUrl(RES_URL_B, 'https://example.com/img.jpg', 'image/jpeg'),
                    ],
                    'error'
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
        });
        const finalContent = [
            ...s7bPrefix,
            trb(
                TC_IMG,
                'screenshot',
                [
                    dbB64(RES_DATA_B, 'iVBOR==', 'image/png'),
                    dbUrl(RES_URL_B, 'https://example.com/img.jpg', 'image/jpeg'),
                ],
                'error'
            ),
        ];
        groundTruths.push(base(finalContent, FIXED_END_TS));

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
            created_at: '',
            type: EventType.TEXT_BLOCK_START,
            reply_id: 'totally_wrong_id',
            block_id: 'should_not_appear',
        };
        appendEvent(msg, wrongEvent);
        expect(msgDump(msg)).toEqual(original);
    });

    test('missing block does not crash', () => {
        const original = msgDump(msg);
        const ghostEvents: AgentEvent[] = [
            {
                id: 'g1',
                created_at: '',
                type: EventType.TEXT_BLOCK_DELTA,
                reply_id: REPLY_ID,
                block_id: 'ghost',
                delta: 'x',
            },
            {
                id: 'g2',
                created_at: '',
                type: EventType.THINKING_BLOCK_DELTA,
                reply_id: REPLY_ID,
                block_id: 'ghost',
                delta: 'x',
            },
            {
                id: 'g3',
                created_at: '',
                type: EventType.DATA_BLOCK_DELTA,
                reply_id: REPLY_ID,
                block_id: 'ghost',
                data: 'x',
                media_type: 'image/png',
            },
            {
                id: 'g4',
                created_at: '',
                type: EventType.TOOL_CALL_DELTA,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
                delta: 'x',
            },
            {
                id: 'g5',
                created_at: '',
                type: EventType.TOOL_RESULT_TEXT_DELTA,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
                delta: 'x',
            },
            {
                id: 'g6',
                created_at: '',
                type: EventType.TOOL_RESULT_DATA_DELTA,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
                block_id: 'b',
                media_type: 'image/png',
                data: 'x',
            },
            {
                id: 'g7',
                created_at: '',
                type: EventType.TOOL_RESULT_END,
                reply_id: REPLY_ID,
                tool_call_id: 'ghost',
                state: 'success',
            },
        ];
        for (const ev of ghostEvents) {
            appendEvent(msg, ev);
        }
        expect(msgDump(msg)).toEqual(original);
    });
});
