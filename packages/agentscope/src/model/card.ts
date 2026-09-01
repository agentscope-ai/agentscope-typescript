/* eslint-disable jsdoc/require-jsdoc */

export type ModelCardKind = 'chat' | 'embedding' | 'tts';
export type ModelStatus = 'active' | 'deprecated' | 'sunset';
export type JSONSchema = Record<string, unknown>;

export interface RawModelCardRecord {
    readonly kind: ModelCardKind;
    readonly provider: string;
    readonly sourcePath: string;
    readonly config: Readonly<Record<string, unknown>>;
}

interface CardCommon {
    name: string;
    label: string;
    status: ModelStatus;
    inputTypes: string[];
    outputTypes: string[];
    parameterSchema: JSONSchema;
    parametersOverrides: Record<string, JSONSchema | null>;
}

/** Python-compatible chat model capability card. */
export class ModelCard implements CardCommon {
    readonly type = 'chat_model' as const;
    readonly name: string;
    readonly label: string;
    readonly status: ModelStatus;
    readonly deprecatedAt: string | null;
    readonly inputTypes: string[];
    readonly outputTypes: string[];
    readonly contextSize: number;
    readonly outputSize: number;
    readonly parameterSchema: JSONSchema;
    readonly parametersOverrides: Record<string, JSONSchema | null>;

    constructor(config: Readonly<Record<string, unknown>>, parameterSchema: JSONSchema = {}) {
        this.name = requiredString(config, 'name');
        this.label = requiredString(config, 'label');
        this.status = readStatus(config.status);
        this.deprecatedAt = optionalString(config.deprecated_at);
        this.inputTypes = stringArray(config.input_types, ['text/plain']);
        this.outputTypes = stringArray(config.output_types, ['text/plain']);
        this.contextSize = positiveInteger(config, 'context_size');
        this.outputSize = positiveInteger(config, 'output_size');
        const overrides = readOverrides(config.parameter_overrides);
        this.parameterSchema = mergeChatParameterSchema(
            parameterSchema,
            overrides,
            this.outputTypes,
            this.outputSize
        );
        this.parametersOverrides = overrides;
    }

    toJSON(): Record<string, unknown> {
        return {
            type: this.type,
            name: this.name,
            label: this.label,
            status: this.status,
            deprecated_at: this.deprecatedAt,
            input_types: this.inputTypes,
            output_types: this.outputTypes,
            context_size: this.contextSize,
            output_size: this.outputSize,
            parameter_schema: this.parameterSchema,
            parameters_overrides: this.parametersOverrides,
        };
    }
}

/** Python-compatible embedding model capability card. */
export class EmbeddingModelCard implements CardCommon {
    readonly type = 'embedding_model' as const;
    readonly name: string;
    readonly label: string;
    readonly status: ModelStatus;
    readonly inputTypes: string[];
    readonly outputTypes: string[];
    readonly dimensions: number;
    readonly supportedDimensions: number[] | null;
    readonly contextSize: number | null;
    readonly parameterSchema: JSONSchema;
    readonly parametersOverrides: Record<string, JSONSchema | null>;

    constructor(config: Readonly<Record<string, unknown>>, parameterSchema: JSONSchema = {}) {
        this.name = requiredString(config, 'name');
        this.label = requiredString(config, 'label');
        this.status = readStatus(config.status);
        this.inputTypes = stringArray(config.input_types, ['text/plain']);
        this.outputTypes = stringArray(config.output_types, ['application/x-embedding']);
        this.dimensions = positiveInteger(config, 'dimensions');
        this.supportedDimensions = optionalPositiveIntegerArray(config.supported_dimensions);
        this.contextSize =
            config.context_size == null ? null : positiveInteger(config, 'context_size');
        const overrides = readOverrides(config.parameter_overrides);
        this.parameterSchema = mergeParameterSchema(parameterSchema, overrides, false);
        this.parametersOverrides = overrides;
    }

    toJSON(): Record<string, unknown> {
        return {
            type: this.type,
            name: this.name,
            label: this.label,
            status: this.status,
            input_types: this.inputTypes,
            output_types: this.outputTypes,
            dimensions: this.dimensions,
            supported_dimensions: this.supportedDimensions,
            context_size: this.contextSize,
            parameter_schema: this.parameterSchema,
            parameter_overrides: this.parametersOverrides,
        };
    }
}

/** Python-compatible text-to-speech model capability card. */
export class TTSModelCard implements CardCommon {
    readonly type = 'tts_model' as const;
    readonly name: string;
    readonly label: string;
    readonly status: ModelStatus;
    readonly deprecatedAt: string | null;
    readonly inputTypes: string[];
    readonly outputTypes: string[];
    readonly realtime: boolean;
    readonly parameterSchema: JSONSchema;
    readonly parametersOverrides: Record<string, JSONSchema | null>;

    constructor(config: Readonly<Record<string, unknown>>, parameterSchema: JSONSchema = {}) {
        this.name = requiredString(config, 'name');
        this.label = requiredString(config, 'label');
        this.status = readStatus(config.status);
        this.deprecatedAt = optionalString(config.deprecated_at);
        this.inputTypes = stringArray(config.input_types, ['text/plain']);
        this.outputTypes = stringArray(config.output_types, ['audio/wav']);
        this.realtime = config.realtime === true;
        const overrides = readOverrides(config.parameter_overrides);
        const schema = cloneSchema(parameterSchema);
        const properties = schemaProperties(schema);
        const voices = stringArray(config.voices, []);
        if (voices.length > 0 && isSchema(properties.voice)) {
            properties.voice = { ...properties.voice, default: voices[0], enum: voices };
        }
        this.parameterSchema = mergeParameterSchema(schema, overrides, true);
        this.parametersOverrides = overrides;
    }

    toJSON(): Record<string, unknown> {
        return {
            type: this.type,
            name: this.name,
            label: this.label,
            status: this.status,
            deprecated_at: this.deprecatedAt,
            input_types: this.inputTypes,
            output_types: this.outputTypes,
            realtime: this.realtime,
            parameter_schema: this.parameterSchema,
            parameters_overrides: this.parametersOverrides,
        };
    }
}

export type AnyModelCard = ModelCard | EmbeddingModelCard | TTSModelCard;

export function createModelCard(
    record: RawModelCardRecord,
    parameterSchema: JSONSchema = {}
): AnyModelCard {
    if (record.kind === 'chat') return new ModelCard(record.config, parameterSchema);
    if (record.kind === 'embedding') {
        return new EmbeddingModelCard(record.config, parameterSchema);
    }
    return new TTSModelCard(record.config, parameterSchema);
}

function mergeChatParameterSchema(
    baseSchema: JSONSchema,
    overrides: Record<string, JSONSchema | null>,
    outputTypes: string[],
    outputSize: number
): JSONSchema {
    const schema = cloneSchema(baseSchema);
    const properties = schemaProperties(schema);
    if (!outputTypes.includes('application/x-thinking')) {
        for (const name of [
            'thinking_enable',
            'thinking_budget',
            'thinking_mode',
            'thinking_display',
        ]) {
            delete properties[name];
        }
    }
    if (!outputTypes.some(type => type.startsWith('audio/'))) delete properties.voice;
    if (isSchema(properties.max_tokens)) {
        properties.max_tokens = { ...properties.max_tokens, maximum: outputSize };
    }
    return mergeParameterSchema(schema, overrides, false);
}

function mergeParameterSchema(
    baseSchema: JSONSchema,
    overrides: Record<string, JSONSchema | null>,
    filterRequired: boolean
): JSONSchema {
    const schema = cloneSchema(baseSchema);
    const properties = schemaProperties(schema);
    for (const [name, override] of Object.entries(overrides)) {
        if (override === null || override.hidden === true) {
            delete properties[name];
        } else if (isSchema(properties[name])) {
            properties[name] = { ...properties[name], ...override };
        }
    }
    const required = Array.isArray(schema.required)
        ? schema.required.filter(item => typeof item === 'string')
        : [];
    return {
        type: 'object',
        properties,
        required: filterRequired ? required.filter(name => name in properties) : required,
    };
}

function cloneSchema(schema: JSONSchema): JSONSchema {
    return JSON.parse(JSON.stringify(schema)) as JSONSchema;
}

function schemaProperties(schema: JSONSchema): Record<string, JSONSchema> {
    if (!isSchema(schema.properties)) schema.properties = {};
    return schema.properties as Record<string, JSONSchema>;
}

function isSchema(value: unknown): value is JSONSchema {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOverrides(value: unknown): Record<string, JSONSchema | null> {
    if (!isSchema(value)) return {};
    return Object.fromEntries(
        Object.entries(value).map(([name, override]) => [
            name,
            override === null ? null : isSchema(override) ? cloneSchema(override) : {},
        ])
    ) as Record<string, JSONSchema | null>;
}

function requiredString(config: Readonly<Record<string, unknown>>, name: string): string {
    const value = config[name];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Model card is missing required string '${name}'.`);
    }
    return value;
}

function optionalString(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value !== 'string') throw new Error('Expected an optional string.');
    return value;
}

function positiveInteger(config: Readonly<Record<string, unknown>>, name: string): number {
    const value = config[name];
    if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new Error(`Model card field '${name}' must be a positive integer.`);
    }
    return value as number;
}

function stringArray(value: unknown, fallback: string[]): string[] {
    if (value == null) return [...fallback];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error('Expected an array of strings.');
    }
    return [...value] as string[];
}

function optionalPositiveIntegerArray(value: unknown): number[] | null {
    if (value == null) return null;
    if (!Array.isArray(value) || value.some(item => !Number.isInteger(item) || item <= 0)) {
        throw new Error('Expected an array of positive integers.');
    }
    return [...value] as number[];
}

function readStatus(value: unknown): ModelStatus {
    if (value == null) return 'active';
    if (value === 'active' || value === 'deprecated' || value === 'sunset') return value;
    throw new Error(`Unsupported model status '${String(value)}'.`);
}
