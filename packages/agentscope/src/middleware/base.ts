/* eslint-disable jsdoc/require-jsdoc */

import type { Agent } from '../agent/agent';
import type { ContextConfig } from '../agent/config';
import type { AgentEvent } from '../event';
import type { Msg, ToolCallBlock } from '../message';
import type { HintBlock } from '../message';
import type { ChatModelBase, ChatResponse } from '../model';
import type { PermissionDecision } from '../permission';
import type { ToolBase, ToolChunk, ToolResponse } from '../tool';
import type { ToolChoice } from '../tool/types';

export type AgentStream = AsyncGenerator<AgentEvent | Msg, void>;
export type ReasoningStream = AsyncGenerator<AgentEvent | Msg, void>;
export type ActingStream = AsyncGenerator<ToolChunk | ToolResponse, void>;
export type ModelResult = ChatResponse | AsyncGenerator<ChatResponse, ChatResponse | void>;

export interface ReplyHookInput {
    inputs?: Msg | Msg[] | AgentEvent | null;
    structuredSchema?: Record<string, unknown> | import('zod').z.ZodObject | null;
    signal?: AbortSignal;
}

export interface ReasoningHookInput {
    toolChoice?: ToolChoice | null;
    signal?: AbortSignal;
}

export interface ActingHookInput {
    toolCall: ToolCallBlock;
}

export interface PermissionHookInput {
    toolCall: ToolCallBlock;
    tool: ToolBase;
    toolInput: Record<string, unknown>;
}

export interface ModelCallHookInput {
    currentModel: ChatModelBase;
    messages: Msg[];
    tools: import('../type').ToolSchema[];
    toolChoice?: ToolChoice | null;
    signal?: AbortSignal;
}

export interface CompressContextHookInput {
    contextConfig?: ContextConfig | null;
    instructions?: HintBlock | null;
}

/** Base class for the seven Python AgentScope agent middleware hooks. */
export class MiddlewareBase {
    isImplemented(hookName: keyof MiddlewareBase): boolean {
        const base = Reflect.get(MiddlewareBase.prototype, hookName);
        const actual = Reflect.get(Object.getPrototypeOf(this), hookName);
        return base !== actual;
    }

    async *onReply(
        _agent: Agent,
        _input: ReplyHookInput,
        _next: (input?: Partial<ReplyHookInput>) => AgentStream
    ): AgentStream {
        throw new Error(`${this.constructor.name} does not implement onReply`);
    }

    async *onReasoning(
        _agent: Agent,
        _input: ReasoningHookInput,
        _next: (input?: Partial<ReasoningHookInput>) => ReasoningStream
    ): ReasoningStream {
        throw new Error(`${this.constructor.name} does not implement onReasoning`);
    }

    async *onActing(
        _agent: Agent,
        _input: ActingHookInput,
        _next: (input?: Partial<ActingHookInput>) => ActingStream
    ): ActingStream {
        throw new Error(`${this.constructor.name} does not implement onActing`);
    }

    async onCheckPermission(
        _agent: Agent,
        _input: PermissionHookInput,
        _next: (input?: Partial<PermissionHookInput>) => Promise<PermissionDecision>
    ): Promise<PermissionDecision> {
        throw new Error(`${this.constructor.name} does not implement onCheckPermission`);
    }

    async onModelCall(
        _agent: Agent,
        _input: ModelCallHookInput,
        _next: (input?: Partial<ModelCallHookInput>) => Promise<ModelResult>
    ): Promise<ModelResult> {
        throw new Error(`${this.constructor.name} does not implement onModelCall`);
    }

    async onCompressContext(
        _agent: Agent,
        _input: CompressContextHookInput,
        _next: (input?: Partial<CompressContextHookInput>) => Promise<void>
    ): Promise<void> {
        throw new Error(`${this.constructor.name} does not implement onCompressContext`);
    }

    async onSystemPrompt(_agent: Agent, _currentPrompt: string): Promise<string> {
        throw new Error(`${this.constructor.name} does not implement onSystemPrompt`);
    }

    async listTools(): Promise<ToolBase[]> {
        return [];
    }

    async getMiddlewareKey(): Promise<string> {
        return this.constructor.name;
    }
}
