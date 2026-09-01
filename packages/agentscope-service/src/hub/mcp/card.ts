/* eslint-disable jsdoc/require-jsdoc */

import type { JSONSchemaObject, MCPConfigTemplate } from '../../service/mcp-render';

export type MCPAuthentication = 'none' | 'inputs';

export interface MCPCardOptions {
    hubId: string;
    id?: string;
    name: string;
    displayName?: string | null;
    description?: string;
    tags?: string[];
    version?: string | null;
    updatedAt?: number | null;
    author?: string | null;
    iconUrl?: string | null;
    url?: string | null;
    readme?: string | null;
    installs?: number | null;
    downloads?: number | null;
    isStateful?: boolean;
    auth?: MCPAuthentication;
    inputsSchema?: JSONSchemaObject;
    configTemplate: MCPConfigTemplate;
}

/** Installable MCP template published by a hub. */
export class MCPCard {
    readonly hubId: string;
    readonly id: string;
    name: string;
    readonly displayName: string | null;
    readonly description: string;
    readonly tags: string[];
    readonly version: string | null;
    readonly updatedAt: number | null;
    readonly author: string | null;
    readonly iconUrl: string | null;
    readonly url: string | null;
    readonly readme: string | null;
    readonly installs: number | null;
    readonly downloads: number | null;
    readonly isStateful: boolean;
    readonly auth: MCPAuthentication;
    readonly inputsSchema: JSONSchemaObject;
    readonly configTemplate: MCPConfigTemplate;

    constructor(options: MCPCardOptions) {
        this.hubId = options.hubId;
        this.id = options.id || options.name;
        this.name = options.name;
        this.displayName = options.displayName ?? null;
        this.description = options.description ?? '';
        this.tags = options.tags ?? [];
        this.version = options.version ?? null;
        this.updatedAt = options.updatedAt ?? null;
        this.author = options.author ?? null;
        this.iconUrl = options.iconUrl ?? null;
        this.url = options.url ?? null;
        this.readme = options.readme ?? null;
        this.installs = options.installs ?? null;
        this.downloads = options.downloads ?? null;
        this.isStateful = options.isStateful ?? true;
        this.auth = options.auth ?? 'inputs';
        this.inputsSchema = options.inputsSchema ?? {};
        this.configTemplate = options.configTemplate;
    }

    toJSON(): Record<string, unknown> {
        return {
            hub_id: this.hubId,
            id: this.id,
            name: this.name,
            display_name: this.displayName,
            description: this.description,
            tags: this.tags,
            version: this.version,
            updated_at: this.updatedAt,
            author: this.author,
            icon_url: this.iconUrl,
            url: this.url,
            readme: this.readme,
            installs: this.installs,
            downloads: this.downloads,
            is_stateful: this.isStateful,
            auth: this.auth,
            inputs_schema: this.inputsSchema,
            config_template: this.configTemplate,
        };
    }
}

/** One cursor page of MCP cards. */
export class MCPHubPage {
    constructor(
        readonly cards: MCPCard[],
        readonly nextCursor: string | null = null
    ) {}

    toJSON(): Record<string, unknown> {
        return { cards: this.cards, next_cursor: this.nextCursor };
    }
}
