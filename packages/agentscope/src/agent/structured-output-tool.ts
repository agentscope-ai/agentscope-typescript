/* eslint-disable jsdoc/require-jsdoc */

import { Validator } from '@cfworker/json-schema';
import { z } from 'zod';

import { TextBlock } from '../message';
import { createPermissionDecision, PermissionBehavior } from '../permission';
import type { PermissionContext, PermissionDecision } from '../permission';
import type { AgentState, StructuredSchema } from '../state';
import { ToolBase } from '../tool/base';
import { ToolChunk } from '../tool/response';
import type { ToolInputSchema } from '../type';

/** Built-in finalizer used when a reply requires structured output. */
export class GenerateStructuredOutputTool extends ToolBase {
    readonly name = 'GenerateStructuredOutput';
    readonly description = `Generate the required structured output by this tool.

This tool is equipped only when you're required to generate structured output.
The input schema represents the required structured output.
When you are ready to generate a structured output, call this tool with the
structured output as input. Once this tool is called, your current response is
finished and the structured output is sent to the user.`;
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;
    override isStateInjected = true;
    readonly inputSchema: z.ZodObject | ToolInputSchema;
    private readonly schema: StructuredSchema;

    constructor(schema: StructuredSchema) {
        super();
        this.schema = schema;
        this.inputSchema = isZodSchema(schema)
            ? (schema as z.ZodObject)
            : (structuredClone(schema ?? { type: 'object', properties: {} }) as ToolInputSchema);
    }

    async checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: `${this.name} is always allowed.`,
        });
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const state = input._agent_state as AgentState | undefined;
        const payload = { ...input };
        delete payload._agent_state;
        const schema = state?.replyContext.structuredSchema ?? this.schema;
        if (!state || !schema) {
            return new ToolChunk({
                content: [TextBlock({ text: 'No structured output is required for now.' })],
                state: 'success',
            });
        }
        try {
            if (isZodSchema(schema)) {
                state.replyContext.structuredOutput = schema.parse(payload) as Record<
                    string,
                    unknown
                >;
            } else {
                applySchemaDefaults(schema, payload);
                const result = new Validator(schema as ToolInputSchema).validate(payload);
                if (!result.valid) throw new Error(JSON.stringify(result.errors));
                state.replyContext.structuredOutput = payload;
            }
        } catch (error) {
            return new ToolChunk({
                content: [
                    TextBlock({
                        text:
                            'ValidationError: Structured output validation failed with error: ' +
                            (error instanceof Error ? error.message : String(error)),
                    }),
                ],
                state: 'error',
            });
        }
        return new ToolChunk({
            content: [TextBlock({ text: 'Structured output generated successfully.' })],
            state: 'success',
        });
    }
}

function isZodSchema(value: unknown): value is z.ZodType {
    return value instanceof z.ZodType;
}

function applySchemaDefaults(
    schema: Record<string, unknown>,
    value: Record<string, unknown>
): void {
    const properties = schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return;
    for (const [key, definition] of Object.entries(properties)) {
        if (
            !(key in value) &&
            definition &&
            typeof definition === 'object' &&
            !Array.isArray(definition) &&
            'default' in definition
        ) {
            value[key] = structuredClone((definition as Record<string, unknown>).default);
        }
    }
}
