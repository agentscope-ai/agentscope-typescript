/* eslint-disable jsdoc/require-jsdoc */

import {
    CredentialBase,
    CredentialOptions,
    apiKeySchema,
    baseCredentialProperties,
    commonOptions,
    credentialJSON,
    optionalString,
    requireString,
} from './base';

interface APIKeyOptions extends CredentialOptions {
    apiKey: string;
}

interface APIKeyBaseURLOptions extends APIKeyOptions {
    baseUrl?: string | null;
}

abstract class APIKeyCredential extends CredentialBase {
    readonly apiKey: string;

    protected constructor(options: APIKeyOptions) {
        super(options);
        if (!options.apiKey) throw new Error('apiKey is required.');
        this.apiKey = options.apiKey;
    }
}

export class AnthropicCredential extends APIKeyCredential {
    static readonly credentialType = 'anthropic_credential';
    static readonly schema = credentialSchema(
        'Anthropic API',
        'The Anthropic credential model.',
        AnthropicCredential.credentialType,
        {
            api_key: apiKeySchema('The Anthropic API key'),
            base_url: nullableStringSchema('The base URL for the Anthropic API.'),
        },
        ['api_key']
    );
    readonly type = AnthropicCredential.credentialType;
    readonly chatProvider = 'anthropic';
    readonly baseUrl: string | null;

    constructor(options: APIKeyBaseURLOptions) {
        super(options);
        this.baseUrl = options.baseUrl ?? null;
    }

    static fromDict(data: Record<string, unknown>): AnthropicCredential {
        return new AnthropicCredential({
            ...commonOptions(data),
            apiKey: requireString(data, 'api_key'),
            baseUrl: optionalString(data, 'base_url'),
        });
    }

    toJSON(): Record<string, unknown> {
        return credentialJSON(this, { api_key: this.apiKey, base_url: this.baseUrl });
    }
}

export class DashScopeCredential extends APIKeyCredential {
    static readonly credentialType = 'dashscope_credential';
    static readonly defaultBaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    static readonly schema = credentialSchema(
        'DashScope API',
        'The credential for DashScope API.',
        DashScopeCredential.credentialType,
        {
            api_key: apiKeySchema('The DashScope API key.', 'API Key'),
            base_url: stringSchema(
                'The base URL for the DashScope OpenAI-compatible API endpoint.',
                'API Base URL',
                DashScopeCredential.defaultBaseUrl
            ),
        },
        ['api_key']
    );
    readonly type = DashScopeCredential.credentialType;
    readonly chatProvider = 'dashscope';
    override readonly embeddingProvider = 'dashscope';
    override readonly ttsProvider = 'dashscope';
    readonly baseUrl: string;

    constructor(options: APIKeyBaseURLOptions) {
        super(options);
        this.baseUrl = options.baseUrl ?? DashScopeCredential.defaultBaseUrl;
    }

    static fromDict(data: Record<string, unknown>): DashScopeCredential {
        return new DashScopeCredential({
            ...commonOptions(data),
            apiKey: requireString(data, 'api_key'),
            baseUrl: optionalString(data, 'base_url'),
        });
    }

    toJSON(): Record<string, unknown> {
        return credentialJSON(this, { api_key: this.apiKey, base_url: this.baseUrl });
    }
}

export class DeepSeekCredential extends APIKeyCredential {
    static readonly credentialType = 'deepseek_credential';
    static readonly defaultBaseUrl = 'https://api.deepseek.com';
    static readonly schema = credentialSchema(
        'DeepSeek API',
        'The DeepSeek credential model.',
        DeepSeekCredential.credentialType,
        {
            api_key: apiKeySchema('The DeepSeek API key.'),
            base_url: stringSchema(
                'The base URL for the DeepSeek API.',
                'Base Url',
                DeepSeekCredential.defaultBaseUrl
            ),
        },
        ['api_key']
    );
    readonly type = DeepSeekCredential.credentialType;
    readonly chatProvider = 'deepseek';
    readonly baseUrl: string;

    constructor(options: APIKeyBaseURLOptions) {
        super(options);
        this.baseUrl = options.baseUrl ?? DeepSeekCredential.defaultBaseUrl;
    }

    static fromDict(data: Record<string, unknown>): DeepSeekCredential {
        return new DeepSeekCredential({
            ...commonOptions(data),
            apiKey: requireString(data, 'api_key'),
            baseUrl: optionalString(data, 'base_url'),
        });
    }

    toJSON(): Record<string, unknown> {
        return credentialJSON(this, { api_key: this.apiKey, base_url: this.baseUrl });
    }
}

export class GeminiCredential extends APIKeyCredential {
    static readonly credentialType = 'gemini_credential';
    static readonly schema = credentialSchema(
        'Gemini API',
        'The Google Gemini credential model.',
        GeminiCredential.credentialType,
        { api_key: apiKeySchema('The Google Gemini API key.') },
        ['api_key']
    );
    readonly type = GeminiCredential.credentialType;
    readonly chatProvider = 'gemini';
    override readonly embeddingProvider = 'gemini';
    override readonly ttsProvider = 'gemini';

    constructor(options: APIKeyOptions) {
        super(options);
    }

    static fromDict(data: Record<string, unknown>): GeminiCredential {
        return new GeminiCredential({
            ...commonOptions(data),
            apiKey: requireString(data, 'api_key'),
        });
    }

    toJSON(): Record<string, unknown> {
        return credentialJSON(this, { api_key: this.apiKey });
    }
}

export class MoonshotCredential extends APIKeyCredential {
    static readonly credentialType = 'moonshot_credential';
    static readonly defaultBaseUrl = 'https://api.moonshot.cn/v1';
    static readonly schema = credentialSchema(
        'Moonshot API',
        'The Moonshot AI credential model.',
        MoonshotCredential.credentialType,
        {
            api_key: apiKeySchema('The Moonshot AI API key.'),
            base_url: stringSchema(
                'The base URL for the Moonshot AI API.',
                'Base Url',
                MoonshotCredential.defaultBaseUrl
            ),
        },
        ['api_key']
    );
    readonly type = MoonshotCredential.credentialType;
    readonly chatProvider = 'moonshot';
    readonly baseUrl: string;

    constructor(options: APIKeyBaseURLOptions) {
        super(options);
        this.baseUrl = options.baseUrl ?? MoonshotCredential.defaultBaseUrl;
    }

    static fromDict(data: Record<string, unknown>): MoonshotCredential {
        return new MoonshotCredential({
            ...commonOptions(data),
            apiKey: requireString(data, 'api_key'),
            baseUrl: optionalString(data, 'base_url'),
        });
    }

    toJSON(): Record<string, unknown> {
        return credentialJSON(this, { api_key: this.apiKey, base_url: this.baseUrl });
    }
}

export class OllamaCredential extends CredentialBase {
    static readonly credentialType = 'ollama_credential';
    static readonly schema = credentialSchema(
        'Ollama API',
        'The Ollama credential model (connection settings).',
        OllamaCredential.credentialType,
        {
            host: nullableStringSchema(
                'The Ollama server host URL. Defaults to http://localhost:11434 if not specified.',
                'Host'
            ),
        }
    );
    readonly type = OllamaCredential.credentialType;
    readonly chatProvider = 'ollama';
    override readonly embeddingProvider = 'ollama';
    readonly host: string | null;

    constructor(options: CredentialOptions & { host?: string | null } = {}) {
        super(options);
        this.host = options.host ?? null;
    }

    static fromDict(data: Record<string, unknown>): OllamaCredential {
        return new OllamaCredential({
            ...commonOptions(data),
            host: optionalString(data, 'host'),
        });
    }

    toJSON(): Record<string, unknown> {
        return credentialJSON(this, { host: this.host });
    }
}

export class OpenAICredential extends APIKeyCredential {
    static readonly credentialType = 'openai_credential';
    static readonly schema = credentialSchema(
        'OpenAI API',
        'The OpenAI credential model.',
        OpenAICredential.credentialType,
        {
            api_key: apiKeySchema('The OpenAI API key.'),
            organization: nullableStringSchema('The OpenAI organization ID.', 'Organization'),
            base_url: nullableStringSchema(
                'The base URL for the OpenAI API. Can be used for OpenAI-compatible endpoints.'
            ),
        },
        ['api_key']
    );
    readonly type = OpenAICredential.credentialType;
    readonly chatProvider = 'openai_chat';
    override readonly embeddingProvider = 'openai';
    override readonly ttsProvider = 'openai';
    readonly organization: string | null;
    readonly baseUrl: string | null;

    constructor(options: APIKeyBaseURLOptions & { organization?: string | null }) {
        super(options);
        this.organization = options.organization ?? null;
        this.baseUrl = options.baseUrl ?? null;
    }

    static fromDict(data: Record<string, unknown>): OpenAICredential {
        return new OpenAICredential({
            ...commonOptions(data),
            apiKey: requireString(data, 'api_key'),
            organization: optionalString(data, 'organization'),
            baseUrl: optionalString(data, 'base_url'),
        });
    }

    toJSON(): Record<string, unknown> {
        return credentialJSON(this, {
            api_key: this.apiKey,
            organization: this.organization,
            base_url: this.baseUrl,
        });
    }
}

export class XAICredential extends APIKeyCredential {
    static readonly credentialType = 'xai_credential';
    static readonly schema = credentialSchema(
        'xAI API',
        'The xAI credential model.',
        XAICredential.credentialType,
        {
            api_key: apiKeySchema('The xAI API key.'),
            api_host: stringSchema(
                'The xAI API host (without scheme). Override to point at a compatible/self-hosted endpoint.',
                'API Host',
                'api.x.ai'
            ),
        },
        ['api_key']
    );
    readonly type = XAICredential.credentialType;
    readonly chatProvider = 'xai';
    readonly apiHost: string;

    constructor(options: APIKeyOptions & { apiHost?: string }) {
        super(options);
        this.apiHost = options.apiHost ?? 'api.x.ai';
    }

    static fromDict(data: Record<string, unknown>): XAICredential {
        return new XAICredential({
            ...commonOptions(data),
            apiKey: requireString(data, 'api_key'),
            apiHost: optionalString(data, 'api_host') ?? undefined,
        });
    }

    toJSON(): Record<string, unknown> {
        return credentialJSON(this, { api_key: this.apiKey, api_host: this.apiHost });
    }
}

function credentialSchema(
    title: string,
    description: string,
    type: string,
    properties: Record<string, unknown>,
    required: string[] = []
): Record<string, unknown> {
    return {
        description,
        properties: { ...baseCredentialProperties(type), ...properties },
        ...(required.length > 0 ? { required } : {}),
        title,
        type: 'object',
    };
}

function nullableStringSchema(description: string, title = 'Base Url') {
    return {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        default: null,
        description,
        title,
    };
}

function stringSchema(description: string, title: string, defaultValue: string) {
    return { default: defaultValue, description, title, type: 'string' };
}
