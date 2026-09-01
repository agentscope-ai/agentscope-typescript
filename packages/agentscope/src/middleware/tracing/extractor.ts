/* eslint-disable jsdoc/require-description, jsdoc/require-returns */
import { OperationNameValues, ProviderNameValues, SpanAttributes } from './attributes';
import { convertBlockToPart, serializeToString } from './converter';
import type { Agent } from '../../agent';
import { EventType } from '../../event';
import type { Msg, ToolCallBlock } from '../../message';
import { getContentBlocks } from '../../message';
import type { ChatModelBase, ChatResponse } from '../../model';
import { FinishedReason } from '../../model';
import type { Toolkit, ToolChoice } from '../../tool';
import type { ToolSchema } from '../../type';

export type TraceAttributes = Record<string, string | number | boolean | string[]>;

const PROVIDERS: Array<[string, string]> = [
    ['api.openai.com', ProviderNameValues.OPENAI],
    ['dashscope', ProviderNameValues.DASHSCOPE],
    ['deepseek', ProviderNameValues.DEEPSEEK],
    ['moonshot', ProviderNameValues.MOONSHOT],
    ['generativelanguage.googleapis.com', ProviderNameValues.GCP_GEMINI],
    ['openai.azure.com', ProviderNameValues.AZURE_AI_OPENAI],
    ['amazonaws.com', ProviderNameValues.AWS_BEDROCK],
    ['api.x.ai', ProviderNameValues.XAI],
];

/**
 *
 * @param sessionId
 */
export function getCommonAttributes(sessionId = ''): TraceAttributes {
    return { [SpanAttributes.GEN_AI_CONVERSATION_ID]: sessionId || '[no_session_id]' };
}

/**
 *
 * @param model
 */
export function getProviderName(model: ChatModelBase): string {
    const prefix = model.constructor.name
        .replace(/(ChatModel|MultiAgentModel|ResponseModel)$/u, '')
        .toLowerCase();
    if (prefix === 'openai') {
        const credential = model.credential as unknown as Record<string, unknown> | undefined;
        const baseURL = String(credential?.baseURL ?? credential?.base_url ?? '');
        return (
            PROVIDERS.find(([fragment]) => baseURL.includes(fragment))?.[1] ??
            ProviderNameValues.OPENAI
        );
    }
    return (
        {
            dashscope: ProviderNameValues.DASHSCOPE,
            openai: ProviderNameValues.OPENAI,
            anthropic: ProviderNameValues.ANTHROPIC,
            gemini: ProviderNameValues.GCP_GEMINI,
            ollama: ProviderNameValues.OLLAMA,
            deepseek: ProviderNameValues.DEEPSEEK,
            xai: ProviderNameValues.XAI,
            moonshot: ProviderNameValues.MOONSHOT,
        }[prefix] ?? 'unknown'
    );
}

/**
 *
 * @param tools
 * @param choice
 */
export function getToolDefinitions(
    tools: ToolSchema[] | undefined,
    choice: ToolChoice | null | undefined
): string | null {
    if (!tools?.length || choice?.mode === 'none') return null;
    const flattened = tools.map(tool => ({
        type: tool.type,
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    return serializeToString(flattened);
}

/**
 *
 * @param model
 * @param input
 */
export function getLLMRequestAttributes(
    model: ChatModelBase,
    input: Record<string, unknown>
): TraceAttributes {
    const attributes: Record<string, unknown> = {
        [SpanAttributes.GEN_AI_OPERATION_NAME]: OperationNameValues.CHAT,
        [SpanAttributes.GEN_AI_PROVIDER_NAME]: getProviderName(model),
        [SpanAttributes.GEN_AI_REQUEST_MODEL]: model.modelName,
        [SpanAttributes.GEN_AI_REQUEST_TEMPERATURE]: input.temperature,
        [SpanAttributes.GEN_AI_REQUEST_TOP_P]: input.p ?? input.top_p,
        [SpanAttributes.GEN_AI_REQUEST_TOP_K]: input.top_k,
        [SpanAttributes.GEN_AI_REQUEST_MAX_TOKENS]: input.max_tokens,
        [SpanAttributes.GEN_AI_REQUEST_PRESENCE_PENALTY]: input.presence_penalty,
        [SpanAttributes.GEN_AI_REQUEST_FREQUENCY_PENALTY]: input.frequency_penalty,
        [SpanAttributes.GEN_AI_REQUEST_STOP_SEQUENCES]: input.stop_sequences,
        [SpanAttributes.GEN_AI_REQUEST_SEED]: input.seed,
    };
    const definitions = getToolDefinitions(
        input.tools as ToolSchema[] | undefined,
        input.toolChoice as ToolChoice | null | undefined
    );
    if (definitions) attributes[SpanAttributes.GEN_AI_TOOL_DEFINITIONS] = definitions;
    if (Array.isArray(input.messages)) {
        attributes[SpanAttributes.GEN_AI_INPUT_MESSAGES] = serializeToString(
            getAgentMessages(input.messages as Msg[])
        );
    }
    return compact(attributes);
}

/**
 *
 * @param response
 */
export function getLLMResponseAttributes(response: ChatResponse | null): TraceAttributes {
    const reason = response?.finishedReason === FinishedReason.INTERRUPTED ? 'interrupted' : 'stop';
    const attributes: Record<string, unknown> = {
        [SpanAttributes.GEN_AI_RESPONSE_ID]: response?.id ?? 'unknown_id',
        [SpanAttributes.GEN_AI_RESPONSE_FINISH_REASONS]: serializeToString([reason]),
        [SpanAttributes.GEN_AI_OUTPUT_MESSAGES]: serializeToString([
            {
                role: 'assistant',
                parts: response?.content.map(convertBlockToPart).filter(Boolean) ?? [
                    { type: 'text', content: String(response) },
                ],
                finish_reason: response ? reason : 'unknown',
            },
        ]),
    };
    if (response?.usage) {
        attributes[SpanAttributes.GEN_AI_USAGE_INPUT_TOKENS] = response.usage.inputTokens;
        attributes[SpanAttributes.GEN_AI_USAGE_OUTPUT_TOKENS] = response.usage.outputTokens;
        if (response.usage.cacheInputTokens) {
            attributes[SpanAttributes.AGENTSCOPE_CACHE_INPUT_TOKENS] =
                response.usage.cacheInputTokens;
        }
        if (response.usage.cacheCreationInputTokens) {
            attributes[SpanAttributes.AGENTSCOPE_CACHE_CREATION_INPUT_TOKENS] =
                response.usage.cacheCreationInputTokens;
        }
    }
    return compact(attributes);
}

/**
 *
 * @param input
 */
export function getAgentMessages(input: Msg | Msg[]): Array<Record<string, unknown>> {
    return (Array.isArray(input) ? input : [input]).map(message => ({
        role: message.role,
        parts: getContentBlocks(message).map(convertBlockToPart).filter(Boolean),
        name: message.name,
        finish_reason: 'stop',
    }));
}

/**
 *
 * @param agent
 * @param input
 */
export function getAgentRequestAttributes(
    agent: Agent,
    input: Record<string, unknown>
): TraceAttributes {
    const attributes: Record<string, unknown> = {
        [SpanAttributes.GEN_AI_OPERATION_NAME]: OperationNameValues.INVOKE_AGENT,
        [SpanAttributes.GEN_AI_AGENT_NAME]: agent.name,
        [SpanAttributes.GEN_AI_AGENT_DESCRIPTION]:
            'Unified Python-compatible reasoning-acting agent.',
    };
    const inputs = input.inputs;
    if (isMessageInput(inputs)) {
        attributes[SpanAttributes.GEN_AI_INPUT_MESSAGES] = serializeToString(
            getAgentMessages(inputs)
        );
    } else if (isEvent(inputs, EventType.USER_CONFIRM_RESULT)) {
        attributes[SpanAttributes.AGENTSCOPE_INCOMING_EVENT_TYPE] = 'user_confirm_result';
    } else if (isEvent(inputs, EventType.EXTERNAL_EXECUTION_RESULT)) {
        attributes[SpanAttributes.AGENTSCOPE_INCOMING_EVENT_TYPE] = 'external_execution_result';
    }
    return compact(attributes);
}

/**
 *
 * @param response
 */
export function getAgentResponseAttributes(response: Msg): TraceAttributes {
    return {
        [SpanAttributes.GEN_AI_OUTPUT_MESSAGES]: serializeToString(getAgentMessages(response)),
    };
}

/**
 *
 * @param _toolkit
 * @param call
 */
export function getToolRequestAttributes(_toolkit: Toolkit, call: ToolCallBlock): TraceAttributes {
    return {
        [SpanAttributes.GEN_AI_OPERATION_NAME]: OperationNameValues.EXECUTE_TOOL,
        [SpanAttributes.GEN_AI_TOOL_CALL_ID]: call.id,
        [SpanAttributes.GEN_AI_TOOL_NAME]: call.name,
        [SpanAttributes.GEN_AI_TOOL_CALL_ARGUMENTS]: call.input,
    };
}

/**
 *
 * @param response
 */
export function getToolResponseAttributes(response: unknown): TraceAttributes {
    return { [SpanAttributes.GEN_AI_TOOL_CALL_RESULT]: serializeToString(response) };
}

/**
 *
 * @param attributes
 * @param kind
 */
export function getSpanName(attributes: TraceAttributes, kind: 'agent' | 'llm' | 'tool'): string {
    const suffix =
        kind === 'agent'
            ? attributes[SpanAttributes.GEN_AI_AGENT_NAME]
            : kind === 'llm'
              ? attributes[SpanAttributes.GEN_AI_REQUEST_MODEL]
              : attributes[SpanAttributes.GEN_AI_TOOL_NAME];
    return `${attributes[SpanAttributes.GEN_AI_OPERATION_NAME]} ${suffix}`;
}

/**
 *
 * @param value
 */
function compact(value: Record<string, unknown>): TraceAttributes {
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== null && item !== undefined)
    ) as TraceAttributes;
}

/**
 *
 * @param value
 */
function isMessageInput(value: unknown): value is Msg | Msg[] {
    const first = Array.isArray(value) ? value[0] : value;
    return !!first && typeof first === 'object' && 'role' in first && 'content' in first;
}

/**
 *
 * @param value
 * @param type
 */
function isEvent<T extends EventType>(value: unknown, type: T): boolean {
    return !!value && typeof value === 'object' && 'type' in value && value.type === type;
}
