/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { HttpMCPConfig, MCPClient, StdioMCPConfig } from '@agentscope-ai/agentscope/mcp';
import { Validator } from '@cfworker/json-schema';

export type JSONSchemaObject = Record<string, unknown>;

export type MCPConfigTemplate =
    | {
          type: 'http_mcp';
          url: string;
          headers?: Record<string, string>;
          timeout?: number | null;
      }
    | {
          type: 'stdio_mcp';
          command: string;
          args?: string[];
          env?: Record<string, string>;
          cwd?: string;
          encodingErrorHandler?: 'strict' | 'ignore' | 'replace';
          encoding_error_handler?: 'strict' | 'ignore' | 'replace';
      };

export interface MCPCardTemplate {
    name: string;
    isStateful?: boolean;
    is_stateful?: boolean;
    inputsSchema?: JSONSchemaObject;
    inputs_schema?: JSONSchemaObject;
    configTemplate?: MCPConfigTemplate;
    config_template?: MCPConfigTemplate;
}

/** A single public error boundary for schema, substitution and client failures. */
export class MCPRenderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MCPRenderError';
    }
}

const templatePattern = /\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function identifiers(value: string): Set<string> {
    const found = new Set<string>();
    for (const match of value.matchAll(templatePattern)) {
        const identifier = match[2] ?? match[3];
        if (identifier) found.add(identifier);
    }
    return found;
}

function propertySchemas(schema: JSONSchemaObject): Record<string, JSONSchemaObject> {
    const properties = schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
    return properties as Record<string, JSONSchemaObject>;
}

function effectiveValues(
    schema: JSONSchemaObject,
    supplied: Record<string, unknown>
): Record<string, unknown> {
    const effective: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(propertySchemas(schema))) {
        if (property && typeof property === 'object' && 'default' in property) {
            effective[name] = structuredClone(property.default);
        }
    }
    return { ...effective, ...supplied };
}

function pythonString(value: unknown): string {
    if (value === true) return 'True';
    if (value === false) return 'False';
    if (value === null) return 'None';
    return String(value);
}

function substitute(
    node: unknown,
    values: Record<string, unknown>,
    declared: Set<string>,
    missing: Set<string>
): unknown {
    if (typeof node === 'string') {
        for (const identifier of identifiers(node)) {
            if (declared.has(identifier) && !(identifier in values)) missing.add(identifier);
        }
        return node.replace(
            templatePattern,
            (original, token: string, braced: string, bare: string) => {
                if (token === '$') return '$';
                const identifier = braced ?? bare;
                return identifier in values ? pythonString(values[identifier]) : original;
            }
        );
    }
    if (Array.isArray(node)) {
        return node.map(item => substitute(item, values, declared, missing));
    }
    if (node && typeof node === 'object') {
        return Object.fromEntries(
            Object.entries(node).map(([key, value]) => [
                key,
                substitute(value, values, declared, missing),
            ])
        );
    }
    return node;
}

function omitUnfilledOptionalEnv(
    template: MCPConfigTemplate,
    values: Record<string, unknown>,
    declared: Set<string>,
    required: Set<string>
): void {
    if (template.type !== 'stdio_mcp' || !template.env) return;
    const optional = new Set([...declared].filter(name => !required.has(name)));
    for (const [key, value] of Object.entries(template.env)) {
        const hasMissingOptional = [...identifiers(value)].some(
            identifier => optional.has(identifier) && !(identifier in values)
        );
        if (hasMissingOptional) delete template.env[key];
    }
}

function requiredNames(schema: JSONSchemaObject): Set<string> {
    return new Set(
        Array.isArray(schema.required)
            ? schema.required.filter((value): value is string => typeof value === 'string')
            : []
    );
}

/** Render a Python-compatible MCP card template into a validated MCP client. */
export function renderMCP(
    card: MCPCardTemplate,
    supplied: Record<string, unknown>,
    name?: string
): MCPClient {
    const schema = card.inputsSchema ?? card.inputs_schema ?? {};
    const values = effectiveValues(schema, supplied);
    const validation = new Validator(schema as ConstructorParameters<typeof Validator>[0]).validate(
        values
    );
    if (!validation.valid) {
        throw new MCPRenderError(
            `Invalid values for MCP '${card.name}': ${JSON.stringify(validation.errors)}`
        );
    }

    const sourceTemplate = card.configTemplate ?? card.config_template;
    if (!sourceTemplate) {
        throw new MCPRenderError(`MCP '${card.name}' produced an invalid client: missing config`);
    }
    const template = structuredClone(sourceTemplate);
    const declared = new Set(Object.keys(propertySchemas(schema)));
    omitUnfilledOptionalEnv(template, values, declared, requiredNames(schema));
    const missing = new Set<string>();
    const rendered = substitute(template, values, declared, missing) as MCPConfigTemplate;
    if (missing.size > 0) {
        throw new MCPRenderError(
            `MCP '${card.name}' needs a value for: ${[...missing].sort().join(', ')}`
        );
    }

    try {
        const mcpConfig =
            rendered.type === 'http_mcp'
                ? new HttpMCPConfig(rendered)
                : new StdioMCPConfig({
                      ...rendered,
                      encodingErrorHandler:
                          rendered.encodingErrorHandler ?? rendered.encoding_error_handler,
                  });
        return new MCPClient({
            name: name ?? card.name,
            isStateful: card.isStateful ?? card.is_stateful ?? true,
            mcpConfig,
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new MCPRenderError(`MCP '${card.name}' produced an invalid client: ${detail}`);
    }
}

/** Python-style alias retained for service ports mirroring the original name. */
export const render_mcp = renderMCP;
