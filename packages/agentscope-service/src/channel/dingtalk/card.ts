/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';

import type { ToolCallBlock } from '@agentscope-ai/agentscope/message';

const APPROVE_ACTIONS = new Set(['allow', 'approve', 'approved', 'accept', 'agree']);
const DENY_ACTIONS = new Set(['deny', 'denied', 'reject']);
const TRACK_PREFIX_LENGTH = 32;
const PARAM_VALUE_BUDGET = 900;

export const DINGTALK_PENDING_LAYOUT = JSON.stringify({
    order: ['msgTitle', 'staticMsgContent', 'msgButtons'],
    msgButtons: [
        { text: '✅ 同意', color: 'blue', id: 'agree', request: true },
        { text: '🚫 拒绝', color: 'gray', id: 'reject', request: true },
    ],
});

const SETTLED_LAYOUT = JSON.stringify({ order: ['msgTitle', 'staticMsgContent'] });
const PENDING_TITLE = '工具审批';

export interface DingTalkApprovalDecision {
    outTrackId: string;
    userId: string;
    approverId: string;
    toolCallId: string;
    chatId: string;
    agentId: string;
    sessionId: string;
    approved: boolean;
}

export function dingTalkTrackingId(toolCallId: string): string {
    return randomUUID().replaceAll('-', '') + toolCallId;
}

export function dingTalkToolCallId(track: string): string {
    return track.slice(TRACK_PREFIX_LENGTH);
}

export function buildDingTalkApprovalCardData(
    tool: ToolCallBlock,
    agentName: string
): Record<string, string> {
    const encoded = Buffer.from(tool.input, 'utf8');
    let shown = encoded.subarray(0, PARAM_VALUE_BUDGET).toString('utf8');
    if (encoded.length > PARAM_VALUE_BUDGET) shown += '…';
    return {
        msgTitle: PENDING_TITLE,
        staticMsgContent: `工具：${tool.name}\n\n参数：${shown}`,
        sys_full_json_obj: DINGTALK_PENDING_LAYOUT,
        title: `${agentName} 提交的工具执行`.trim(),
        name: tool.name,
        input: shown,
        created_at: tool.created_at.slice(0, 19).replace('T', ' '),
        status: 'pending',
    };
}

export function buildResolvedDingTalkCardData(approved: boolean): Record<string, string> {
    return {
        msgTitle: PENDING_TITLE,
        staticMsgContent: approved ? '✅ 已同意，工具继续执行。' : '🚫 已拒绝。',
        sys_full_json_obj: SETTLED_LAYOUT,
        flowStatus: '3',
        status: approved ? 'approved' : 'denied',
    };
}

export function parseDingTalkCardCallback(payload: unknown): DingTalkApprovalDecision | null {
    const root = asRecord(payload);
    if (!root) return null;
    const content = asRecordOrJSON(root.content);
    const privateData = asRecordOrJSON(content.cardPrivateData);
    const params = asRecordOrJSON(privateData.params);
    const action = field(params, 'action', 'id').toLowerCase();
    const approved = APPROVE_ACTIONS.has(action) ? true : DENY_ACTIONS.has(action) ? false : null;
    if (approved === null) return null;

    const userId = field(root, 'userId', 'user_id');
    const outTrackId = field(root, 'outTrackId', 'out_track_id');
    if (!userId || !outTrackId) return null;
    const toolCallId =
        field(params, 'toolCallId', 'tool_call_id') || dingTalkToolCallId(outTrackId);
    const chatId = field(params, 'chatId', 'chat_id') || chatFromSpace(root, userId);
    if (!toolCallId || !chatId) return null;
    return {
        outTrackId,
        userId,
        approverId: field(params, 'approverId', 'approver_id'),
        toolCallId,
        chatId,
        agentId: field(params, 'agentId', 'agent_id'),
        sessionId: field(params, 'sessionId', 'session_id'),
        approved,
    };
}

function chatFromSpace(payload: Record<string, unknown>, userId: string): string {
    const spaceType = field(payload, 'spaceType', 'space_type').toUpperCase();
    const spaceId = field(payload, 'spaceId', 'space_id');
    if (spaceType.includes('GROUP') && spaceId) return `group:${spaceId}`;
    if (spaceType.includes('ROBOT') && userId) return `user:${userId}`;
    if (spaceId && spaceId !== userId) return `group:${spaceId}`;
    return userId ? `user:${userId}` : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asRecordOrJSON(value: unknown): Record<string, unknown> {
    const direct = asRecord(value);
    if (direct) return direct;
    if (typeof value !== 'string') return {};
    try {
        return asRecord(JSON.parse(value)) ?? {};
    } catch {
        return {};
    }
}

function field(mapping: Record<string, unknown>, ...names: string[]): string {
    for (const name of names) {
        const value = String(mapping[name] ?? '').trim();
        if (value) return value;
    }
    return '';
}
