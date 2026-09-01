/* eslint-disable @typescript-eslint/no-explicit-any, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import type { MCPConfigTemplate } from '../../service/mcp-render';
import { HubCardNotFoundError, HubError } from '../errors';
import { asRecord, fetchWithTimeout, type HubFetch, type HubHTTPOptions, withQuery } from '../http';
import { MCPHubBase } from './base';
import { MCPCard, MCPHubPage } from './card';

export const GITHUB_MCP_DEFAULT_BASE_URL = 'https://api.mcp.github.com';

const placeholderPattern = /(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const runtimes: Record<string, string[]> = {
    npx: ['-y'],
    uvx: [],
    uv: ['tool', 'run'],
    docker: ['run', '-i', '--rm'],
};

interface GitHubMCPHubOptions extends HubHTTPOptions {
    hubId?: string;
    displayName?: string;
    description?: string;
    iconUrl?: string | null;
}

interface BuiltConfig {
    config: MCPConfigTemplate;
    inputs: Record<string, Record<string, unknown>>;
}

function substituteRegistryPlaceholders(value: unknown): unknown {
    if (typeof value === 'string') return value.replace(placeholderPattern, '${$1}');
    if (Array.isArray(value)) return value.map(substituteRegistryPlaceholders);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, substituteRegistryPlaceholders(item)])
        );
    }
    return value;
}

function inputProperty(name: string, spec: Record<string, any>): Record<string, unknown> {
    const property: Record<string, unknown> = {
        type: 'string',
        title: name,
        description: spec.description || '',
    };
    if (spec.is_secret) {
        property.writeOnly = true;
        property.format = 'password';
    }
    if (spec.choices) property.enum = spec.choices.map(String);
    if (spec.default !== undefined && spec.default !== null)
        property.default = String(spec.default);
    return property;
}

function inputsSchema(inputs: Record<string, Record<string, any>>): Record<string, unknown> {
    if (Object.keys(inputs).length === 0) return {};
    const schema: Record<string, unknown> = {
        type: 'object',
        properties: Object.fromEntries(
            Object.entries(inputs).map(([name, spec]) => [name, inputProperty(name, spec)])
        ),
    };
    const required = Object.entries(inputs)
        .filter(([, spec]) => Boolean(spec.is_required))
        .map(([name]) => name)
        .sort();
    if (required.length > 0) schema.required = required;
    return schema;
}

/** GitHub's public MCP Registry exposed as an AgentScope hub. */
export class GitHubMCPHub extends MCPHubBase {
    readonly baseUrl: string;
    readonly apiToken: string | null;
    readonly timeout: number;
    private readonly fetcher: HubFetch;

    constructor(options: GitHubMCPHubOptions = {}) {
        super({
            hubId: options.hubId ?? 'github',
            displayName: options.displayName ?? 'GitHub MCP Registry',
            description: options.description ?? "MCP servers published to GitHub's registry.",
            iconUrl: options.iconUrl ?? 'https://avatars.githubusercontent.com/u/9919?s=64',
        });
        this.baseUrl = (options.baseUrl ?? GITHUB_MCP_DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.apiToken = options.apiToken ?? null;
        this.timeout = options.timeout ?? 30;
        this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    }

    private headers(): HeadersInit {
        return {
            Accept: 'application/json',
            ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
        };
    }

    private async request(
        path: string,
        params?: Record<string, string | number | null | undefined>
    ): Promise<Response> {
        const response = await fetchWithTimeout(
            this.fetcher,
            withQuery(this.baseUrl, path, params),
            { method: 'GET', headers: this.headers() },
            this.timeout
        );
        if (!response.ok) {
            throw new HubError(this.hubId, response.status, await response.text());
        }
        return response;
    }

    static fromRemote(remote: Record<string, any>): BuiltConfig {
        const inputs: Record<string, Record<string, unknown>> = {};
        const headers: Record<string, string> = {};
        for (const rawHeader of remote.headers ?? []) {
            const header = asRecord(rawHeader);
            const value = header.value || '';
            const key = header.name || 'Authorization';
            headers[key] = String(substituteRegistryPlaceholders(value));
            for (const match of String(value).matchAll(placeholderPattern)) {
                inputs[match[1]] = {
                    description: header.description || '',
                    is_required: true,
                    is_secret: header.is_secret ?? true,
                };
            }
        }
        return {
            config: {
                type: 'http_mcp',
                url: String(remote.url),
                ...(Object.keys(headers).length > 0 ? { headers } : {}),
            },
            inputs,
        };
    }

    static fromPackage(pkg: Record<string, any>): BuiltConfig | null {
        const runtime = pkg.runtime_hint;
        if (typeof runtime !== 'string' || !(runtime in runtimes)) return null;
        if (!pkg.name) return null;

        const spec = pkg.version && runtime === 'npx' ? `${pkg.name}@${pkg.version}` : pkg.name;
        const env: Record<string, string> = {};
        const inputs: Record<string, Record<string, unknown>> = {};
        for (const rawVariable of pkg.environment_variables ?? []) {
            const variable = asRecord(rawVariable);
            const key = variable.name;
            if (!key) continue;
            const nested = asRecord(variable.variables);
            if (
                variable.variables &&
                typeof variable.variables === 'object' &&
                !Array.isArray(variable.variables)
            ) {
                env[key] = String(substituteRegistryPlaceholders(variable.value || ''));
                for (const [inputName, inputSpec] of Object.entries(nested)) {
                    if (inputSpec && typeof inputSpec === 'object' && !Array.isArray(inputSpec)) {
                        inputs[inputName] = inputSpec;
                    }
                }
            } else if (variable.value !== undefined && variable.value !== null) {
                env[key] = String(variable.value);
            } else {
                env[key] = `\${${key}}`;
                inputs[key] = variable;
            }
        }
        return {
            config: {
                type: 'stdio_mcp',
                command: runtime,
                args: [...runtimes[runtime], String(spec)],
                ...(Object.keys(env).length > 0 ? { env } : {}),
            },
            inputs,
        };
    }

    /** Convert one registry response record to an installable card. */
    toCard(entry: Record<string, any>, includeReadme = false): MCPCard | null {
        const server = asRecord(entry.server);
        const github = asRecord(entry['x-github']);
        let built: BuiltConfig | null = null;
        for (const rawRemote of server.remotes ?? []) {
            const remote = asRecord(rawRemote);
            if (remote.url) {
                built = GitHubMCPHub.fromRemote(remote);
                break;
            }
        }
        if (!built) {
            for (const rawPackage of server.packages ?? []) {
                built = GitHubMCPHub.fromPackage(asRecord(rawPackage));
                if (built) break;
            }
        }
        if (!built) return null;

        const name = String(server.name || '');
        const owner = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : null;
        const repository = asRecord(server.repository);
        const slug = name
            .slice(name.lastIndexOf('/') + 1)
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const stamp = server.updated_at;
        const milliseconds = stamp ? Date.parse(String(stamp)) : Number.NaN;
        const nameWithOwner = String(github.name_with_owner || '');
        const githubOwner = nameWithOwner.includes('/')
            ? nameWithOwner.slice(0, nameWithOwner.lastIndexOf('/'))
            : nameWithOwner;
        const config = built.config;
        return new MCPCard({
            hubId: this.hubId,
            id: String(server.id),
            name: slug || 'mcp',
            displayName: github.display_name || name,
            description: server.description || '',
            tags: github.primary_language ? [String(github.primary_language)] : [],
            version: asRecord(server.version_detail).version ?? null,
            updatedAt: Number.isNaN(milliseconds) ? null : milliseconds / 1000,
            author: githubOwner || owner,
            iconUrl: github.preferred_image || github.owner_avatar_url || null,
            url: repository.url ?? null,
            readme: includeReadme ? repository.readme || github.readme || null : null,
            isStateful: config.type === 'stdio_mcp',
            auth: Object.keys(built.inputs).length > 0 ? 'inputs' : 'none',
            inputsSchema: inputsSchema(built.inputs),
            configTemplate: config,
        });
    }

    async listMCPs(
        _userId: string,
        query: string | null = null,
        cursor: string | null = null,
        limit = 20
    ): Promise<MCPHubPage> {
        const response = await this.request('/v0/servers', { limit, cursor });
        const payload = asRecord(await response.json());
        const needle = (query ?? '').toLowerCase();
        const cards: MCPCard[] = [];
        for (const rawEntry of payload.servers ?? []) {
            const card = this.toCard(asRecord(rawEntry));
            if (!card) continue;
            const haystack = `${card.name} ${card.displayName} ${card.description}`.toLowerCase();
            if (!needle || haystack.includes(needle)) cards.push(card);
        }
        return new MCPHubPage(cards, asRecord(payload.metadata).next_cursor ?? null);
    }

    async getMCP(_userId: string, cardId: string): Promise<MCPCard> {
        let response: Response;
        try {
            response = await this.request(`/v0/servers/${cardId}`);
        } catch (error) {
            if (error instanceof HubError && error.statusCode === 404) {
                throw new HubCardNotFoundError(cardId);
            }
            throw error;
        }
        const card = this.toCard(asRecord(await response.json()), true);
        if (!card) throw new HubCardNotFoundError(cardId);
        return card;
    }

    /** Python-style method aliases for parity-oriented integrations. */
    readonly list_mcps = this.listMCPs.bind(this);
    readonly get_mcp = this.getMCP.bind(this);
}
