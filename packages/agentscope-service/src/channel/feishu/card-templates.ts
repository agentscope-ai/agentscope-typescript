/* eslint-disable jsdoc/require-jsdoc */

const ACTION_TYPE = 'tool_guard_approval';
const APPROVE = 'approve';
const DENY = 'deny';

export interface FeishuApprovalDecision {
    toolCallId: string;
    chatId: string;
    approved: boolean;
    agentId: string;
    sessionId: string;
}

export function buildFeishuApprovalCard(options: {
    toolCallId: string;
    chatId: string;
    toolName: string;
    summary: string;
    agentId?: string;
    sessionId?: string;
}): Record<string, unknown> {
    const base = {
        type: ACTION_TYPE,
        tool_call_id: options.toolCallId,
        chat_id: options.chatId,
        agent_id: options.agentId ?? '',
        session_id: options.sessionId ?? '',
    };
    const shown =
        options.summary.length <= 800 ? options.summary : `${options.summary.slice(0, 799)}…`;
    const body = `**Tool:** \`${options.toolName}\`${shown ? `\n**Arguments:** ${shown}` : ''}`;
    return {
        config: { wide_screen_mode: true },
        header: {
            template: 'orange',
            title: { tag: 'plain_text', content: '🛡️ Tool execution needs approval' },
        },
        elements: [
            { tag: 'markdown', content: body },
            { tag: 'hr' },
            {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '✅ Allow' },
                        type: 'primary',
                        value: { ...base, action: APPROVE },
                    },
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '❌ Deny' },
                        type: 'danger',
                        value: { ...base, action: DENY },
                    },
                ],
            },
        ],
    };
}

export function buildResolvedFeishuCard(approved: boolean): Record<string, unknown> {
    return {
        config: { wide_screen_mode: true },
        header: {
            template: approved ? 'green' : 'red',
            title: { tag: 'plain_text', content: approved ? '✅ Allowed' : '🚫 Denied' },
        },
        elements: [
            {
                tag: 'markdown',
                content: approved ? 'The tool was allowed to run.' : 'The tool was denied.',
            },
        ],
    };
}

export function parseFeishuAction(value: unknown): FeishuApprovalDecision | null {
    let parsed = value;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const data = parsed as Record<string, unknown>;
    if (data.type !== ACTION_TYPE) return null;
    const toolCallId = String(data.tool_call_id ?? '').trim();
    const chatId = String(data.chat_id ?? '').trim();
    const action = String(data.action ?? '')
        .trim()
        .toLowerCase();
    if (!toolCallId || (action !== APPROVE && action !== DENY)) return null;
    return {
        toolCallId,
        chatId,
        approved: action === APPROVE,
        agentId: String(data.agent_id ?? '').trim(),
        sessionId: String(data.session_id ?? '').trim(),
    };
}

export function buildFeishuToast(approved: boolean): Record<string, unknown> {
    return { toast: feishuToast(approved) };
}

export function buildFeishuActionResponse(approved: boolean): Record<string, unknown> {
    return {
        toast: feishuToast(approved),
        card: { type: 'raw', data: buildResolvedFeishuCard(approved) },
    };
}

function feishuToast(approved: boolean): Record<string, string> {
    return {
        type: approved ? 'success' : 'info',
        content: approved ? 'Allowed' : 'Denied',
    };
}
