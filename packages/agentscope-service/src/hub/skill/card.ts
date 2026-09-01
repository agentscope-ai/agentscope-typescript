/* eslint-disable jsdoc/require-jsdoc */

export interface SkillCardOptions {
    hubId: string;
    id?: string;
    name: string;
    description?: string;
    displayName?: string | null;
    tags?: string[];
    version?: string | null;
    updatedAt?: number | null;
    author?: string | null;
    iconUrl?: string | null;
    installs?: number | null;
    downloads?: number | null;
    url?: string | null;
    markdown?: string | null;
    metadata?: Record<string, unknown>;
}

/** Installable skill record published by a hub. */
export class SkillCard {
    readonly hubId: string;
    readonly id: string;
    readonly name: string;
    description: string;
    readonly displayName: string | null;
    readonly tags: string[];
    readonly version: string | null;
    readonly updatedAt: number | null;
    readonly author: string | null;
    readonly iconUrl: string | null;
    readonly installs: number | null;
    readonly downloads: number | null;
    readonly url: string | null;
    markdown: string | null;
    readonly metadata: Record<string, unknown>;

    constructor(options: SkillCardOptions) {
        this.hubId = options.hubId;
        this.id = options.id || options.name;
        this.name = options.name;
        this.description = options.description ?? '';
        this.displayName = options.displayName ?? null;
        this.tags = options.tags ?? [];
        this.version = options.version ?? null;
        this.updatedAt = options.updatedAt ?? null;
        this.author = options.author ?? null;
        this.iconUrl = options.iconUrl ?? null;
        this.installs = options.installs ?? null;
        this.downloads = options.downloads ?? null;
        this.url = options.url ?? null;
        this.markdown = options.markdown ?? null;
        this.metadata = options.metadata ?? {};
    }

    toJSON(): Record<string, unknown> {
        return {
            hub_id: this.hubId,
            id: this.id,
            name: this.name,
            description: this.description,
            display_name: this.displayName,
            tags: this.tags,
            version: this.version,
            updated_at: this.updatedAt,
            author: this.author,
            icon_url: this.iconUrl,
            installs: this.installs,
            downloads: this.downloads,
            url: this.url,
            markdown: this.markdown,
            metadata: this.metadata,
        };
    }
}

/** One cursor page of skill cards. */
export class SkillHubPage {
    constructor(
        readonly cards: SkillCard[],
        readonly nextCursor: string | null = null
    ) {}

    toJSON(): Record<string, unknown> {
        return { cards: this.cards, next_cursor: this.nextCursor };
    }
}
