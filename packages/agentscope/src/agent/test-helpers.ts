/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { TextBlock } from '../message';
import { ChatModelBase, ChatResponse } from '../model';
import type { ChatModelRequestOptions } from '../model/base';
import { createPermissionDecision, PermissionBehavior } from '../permission';
import type { PermissionContext, PermissionDecision } from '../permission';
import { ToolBase, ToolChunk } from '../tool';
import type { ToolChoice as LegacyToolChoice, ToolSchema } from '../type';

export class QueueModel extends ChatModelBase {
    responses: Array<ChatResponse | (() => AsyncGenerator<ChatResponse, ChatResponse>)> = [];
    calls: Array<ChatModelRequestOptions<unknown>> = [];

    constructor(options: { contextSize?: number } = {}) {
        super({
            modelName: 'test-model',
            stream: false,
            maxRetries: 0,
            contextSize: options.contextSize,
        });
    }

    _formatToolSchemas(_tools: ToolSchema[]): unknown[] {
        return [];
    }

    _formatToolChoice(_choice: LegacyToolChoice): unknown {
        return null;
    }

    async _callAPI(
        _modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        this.calls.push(options);
        const response = this.responses.shift();
        if (!response) throw new Error('No queued model response.');
        return typeof response === 'function' ? response() : response;
    }
}

export class TestTool extends ToolBase {
    readonly inputSchema = z.object({ value: z.string().default('ok') });
    readonly isReadOnly: boolean;
    readonly isConcurrencySafe: boolean;
    override isExternalTool: boolean;
    calls: string[] = [];
    readonly delay: number;

    constructor(
        readonly name: string,
        options: {
            readOnly?: boolean;
            concurrencySafe?: boolean;
            external?: boolean;
            delay?: number;
            decision?: PermissionBehavior;
        } = {}
    ) {
        super();
        this.isReadOnly = options.readOnly ?? false;
        this.isConcurrencySafe = options.concurrencySafe ?? true;
        this.isExternalTool = options.external ?? false;
        this.delay = options.delay ?? 0;
        this.decision = options.decision ?? PermissionBehavior.ALLOW;
    }

    readonly description = 'A deterministic test tool.';
    private readonly decision: PermissionBehavior;

    async checkPermissions(
        _input: Record<string, unknown>,
        _context: PermissionContext
    ): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: this.decision,
            message: `Decision: ${this.decision}`,
        });
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        this.calls.push(String(input.value));
        if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
        return new ToolChunk({
            content: [TextBlock({ text: `${this.name}:${String(input.value)}` })],
            state: 'success',
        });
    }
}

export function response(
    content: ChatResponse['content'],
    options: Partial<ConstructorParameters<typeof ChatResponse>[0]> = {}
): ChatResponse {
    return new ChatResponse({ content, isLast: true, ...options });
}

export function streamResponse(
    chunks: ChatResponse[],
    completed: ChatResponse
): () => AsyncGenerator<ChatResponse, ChatResponse> {
    return async function* generate() {
        for (const chunk of chunks) yield chunk;
        return completed;
    };
}
