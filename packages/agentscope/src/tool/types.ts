import { z } from 'zod';

import type { ToolInputSchema, ToolSchema } from '../type';
import type { Tool, ToolBase } from './base';
import { removeSchemaTitles } from './utils';

/** Model-facing tool choice, including an optional schema whitelist. */
export class ToolChoice {
    mode: 'auto' | 'none' | 'required' | string;
    tools: string[] | null;

    /**
     * Create a tool-choice configuration.
     * @param options Choice fields.
     * @param options.mode
     * @param options.tools
     */
    constructor(options: { mode: 'auto' | 'none' | 'required' | string; tools?: string[] | null }) {
        this.mode = options.mode;
        this.tools = options.tools ?? null;
    }
}

export interface RegisteredToolOptions {
    tool: Tool | ToolBase;
    group?: string;
    originalName?: string | null;
}

/** Tool registration plus dynamic schema extension metadata. */
export class RegisteredTool {
    tool: Tool | ToolBase;
    extendedSchema: ToolInputSchema | null = null;
    group: string;
    originalName: string | null;

    /**
     * Validate and store one registered tool.
     * @param options Registration fields.
     */
    constructor(options: RegisteredToolOptions) {
        this.tool = options.tool;
        this.group = options.group ?? 'basic';
        this.originalName = options.originalName ?? null;
        const schema = this.getInputSchema();
        if (
            schema.type !== 'object' ||
            typeof schema.properties !== 'object' ||
            schema.properties === null
        ) {
            throw new Error(`Invalid inputSchema: ${JSON.stringify(schema)}.`);
        }
    }

    /**
     * Build the model-facing function schema, optionally extending its parameters.
     * @param options Dynamic extension override.
     * @param options.extendedSchema
     * @returns A detached schema with generated titles removed.
     */
    getToolSchema(options: { extendedSchema?: ToolInputSchema | null } = {}): ToolSchema {
        const parameters = removeSchemaTitles(structuredClone(this.getInputSchema()));
        const extension = options.extendedSchema ?? this.extendedSchema;
        if (extension) this.mergeSchema(parameters, removeSchemaTitles(structuredClone(extension)));
        return {
            type: 'function',
            function: {
                name: this.tool.name,
                description: this.tool.description,
                parameters,
            },
        };
    }

    /**
     * Return this tool's JSON schema regardless of its source format.
     * @returns The normalized input schema.
     */
    private getInputSchema(): ToolInputSchema {
        if (this.tool.inputSchema instanceof z.ZodObject) {
            return z.toJSONSchema(this.tool.inputSchema, {
                target: 'openapi-3.0',
            }) as ToolInputSchema;
        }
        return this.tool.inputSchema;
    }

    /**
     * Merge extension properties, required fields, and definitions.
     * @param target
     * @param extension
     */
    private mergeSchema(target: ToolInputSchema, extension: ToolInputSchema): void {
        target.properties ??= {};
        for (const [key, value] of Object.entries(extension.properties ?? {})) {
            if (key in target.properties) {
                throw new Error(
                    `The field \`${key}\` already exists in the original function schema of ` +
                        `\`${this.tool.name}\`. Try to use a different name.`
                );
            }
            target.properties[key] = value;
        }
        const required = new Set([...(target.required ?? []), ...(extension.required ?? [])]);
        if (required.size > 0) target.required = [...required];

        const extensionDefs = extension.$defs as Record<string, JSONSchema> | undefined;
        if (!extensionDefs) return;
        const targetDefs = (target.$defs ??= {}) as Record<string, JSONSchema>;
        for (const [key, value] of Object.entries(extensionDefs)) {
            if (key in targetDefs && JSON.stringify(targetDefs[key]) !== JSON.stringify(value)) {
                throw new Error(
                    `The $defs key \`${key}\` conflicts with existing definition in ` +
                        `function schema of \`${this.tool.name}\`.`
                );
            }
            targetDefs[key] ??= value;
        }
    }
}

type JSONSchema = Record<string, unknown>;
