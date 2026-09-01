/* eslint-disable @typescript-eslint/no-explicit-any, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import matter from 'gray-matter';

import { HubCardNotFoundError, HubError } from '../errors';
import { asRecord, fetchWithTimeout, type HubFetch, type HubHTTPOptions, withQuery } from '../http';
import { type SkillArchive, SkillHubBase } from './base';
import { SkillCard, SkillHubPage } from './card';

export const CLAW_SKILL_DEFAULT_BASE_URL = 'https://clawhub.ai';
export const DEFAULT_SKILL_ARCHIVE_CHUNK_SIZE = 64 * 1024;

const timestampVersionPattern = /^0\.(\d{8})\.(\d{6})$/;

export interface ClawSkillHubOptions extends HubHTTPOptions {
    hubId?: string;
    displayName?: string;
    description?: string;
    iconUrl?: string | null;
    maxRetries?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
}

function pythonTruthy(value: unknown): boolean {
    if (value === null || value === undefined || value === false || value === 0 || value === '') {
        return false;
    }
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

/** Render ClawHub's generated timestamp version as a date. */
export function humanizeClawVersion(version: string | null | undefined): string | null {
    if (version === null || version === undefined) return null;
    const match = timestampVersionPattern.exec(version);
    if (!match) return version;
    const year = Number(match[1].slice(0, 4));
    const month = Number(match[1].slice(4, 6));
    const day = Number(match[1].slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return version;
    }
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
        day
    ).padStart(2, '0')}`;
}

async function* readChunks(
    response: Response,
    chunkSize: number
): AsyncGenerator<Uint8Array, void, void> {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
        throw new RangeError('chunkSize must be a positive integer.');
    }
    if (!response.body) return;
    const reader = response.body.getReader();
    let pending = new Uint8Array(0);
    let completed = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                completed = true;
                break;
            }
            if (!value || value.byteLength === 0) continue;
            const combined = new Uint8Array(pending.byteLength + value.byteLength);
            combined.set(pending);
            combined.set(value, pending.byteLength);
            let offset = 0;
            while (combined.byteLength - offset >= chunkSize) {
                yield combined.slice(offset, offset + chunkSize);
                offset += chunkSize;
            }
            pending = combined.slice(offset);
        }
        if (pending.byteLength > 0) yield pending;
    } finally {
        if (!completed) await reader.cancel();
        reader.releaseLock();
    }
}

/** ClawHub's public skill registry exposed as an AgentScope hub. */
export class ClawSkillHub extends SkillHubBase {
    readonly baseUrl: string;
    readonly apiToken: string | null;
    readonly timeout: number;
    readonly maxRetries: number;
    private readonly fetcher: HubFetch;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private readonly random: () => number;
    private readonly now: () => number;

    constructor(options: ClawSkillHubOptions = {}) {
        super({
            hubId: options.hubId ?? 'clawhub',
            displayName: options.displayName ?? 'ClawHub',
            description: options.description ?? 'The ClawHub public skill registry.',
            iconUrl: options.iconUrl ?? 'https://openclaw.ai/favicon.svg',
        });
        this.baseUrl = (options.baseUrl ?? CLAW_SKILL_DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.apiToken = options.apiToken ?? null;
        this.timeout = options.timeout ?? 30;
        this.maxRetries = options.maxRetries ?? 3;
        this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.sleep =
            options.sleep ??
            (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
        this.random = options.random ?? Math.random;
        this.now = options.now ?? Date.now;
    }

    private headers(): HeadersInit {
        return {
            Accept: 'application/json',
            ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
        };
    }

    retryDelay(headers: Headers): number {
        const retryAfter = headers.get('Retry-After');
        if (retryAfter) {
            const delay = Number(retryAfter);
            if (!Number.isNaN(delay)) return Math.max(0, delay);
        }
        const reset = headers.get('RateLimit-Reset');
        if (reset) {
            const delay = Number(reset);
            if (!Number.isNaN(delay)) return Math.max(0, delay);
        }
        const absoluteReset = headers.get('X-RateLimit-Reset');
        if (absoluteReset) {
            const resetAt = Number(absoluteReset);
            if (!Number.isNaN(resetAt)) return Math.max(0, resetAt - this.now() / 1000);
        }
        return 1;
    }

    private async request(
        method: string,
        path: string,
        params?: Record<string, string | number | null | undefined>
    ): Promise<Response> {
        const url = withQuery(this.baseUrl, path, params);
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            const response = await fetchWithTimeout(
                this.fetcher,
                url,
                { method, headers: this.headers() },
                this.timeout
            );
            if (response.status === 429 && attempt < this.maxRetries) {
                const delay = this.retryDelay(response.headers) + this.random();
                await response.body?.cancel();
                await this.sleep(delay * 1000);
                continue;
            }
            if (!response.ok) {
                const body = await response.text();
                throw new HubError(
                    this.hubId,
                    response.status,
                    ClawSkillHub.describeError(response.status, body)
                );
            }
            return response;
        }
        throw new HubError(this.hubId, 429, 'Rate limit exceeded after retries');
    }

    static describeError(statusCode: number, body: string): string {
        if (statusCode !== 409) return body;
        let payload: Record<string, any>;
        try {
            payload = asRecord(JSON.parse(body));
        } catch {
            return body;
        }
        if (payload.code !== 'AMBIGUOUS_SKILL_SLUG') return body;
        const refs = (payload.matches ?? [])
            .map((match: unknown) => asRecord(match).ref)
            .filter(Boolean);
        return (
            `Several publishers use the skill name '${payload.slug ?? ''}': ${refs.join(', ')}. ` +
            'Search for it by name and install the one you want from the results.'
        );
    }

    static splitCardId(cardId: string): [string, Record<string, string>] {
        const separator = cardId.lastIndexOf('/');
        return separator < 0
            ? [cardId, {}]
            : [cardId.slice(separator + 1), { ownerHandle: cardId.slice(0, separator) }];
    }

    /** Convert one catalog, search, or detail record into a card. */
    toCard(item: Record<string, any>): SkillCard {
        const rawLatest = item.latestVersion;
        const latest = asRecord(rawLatest);
        const rawVersion =
            rawLatest && typeof rawLatest === 'object' && !Array.isArray(rawLatest)
                ? latest.version
                : rawLatest || item.version;
        const stats =
            item.stats && typeof item.stats === 'object' && !Array.isArray(item.stats)
                ? asRecord(item.stats)
                : {};
        const native = asRecord(item.native);
        const rawOwner = pythonTruthy(item.owner) ? item.owner : native.owner;
        const owner =
            rawOwner && typeof rawOwner === 'object' && !Array.isArray(rawOwner)
                ? asRecord(rawOwner)
                : {};
        const canonical = item.canonicalUrl;
        const handle = item.ownerHandle || owner.handle;
        const metadata = Object.fromEntries(
            ['stats', 'downloads', 'tags']
                .filter(key => pythonTruthy(item[key]))
                .map(key => [key, item[key]])
        );
        return new SkillCard({
            hubId: this.hubId,
            id: handle ? `${handle}/${item.slug}` : String(item.slug),
            name: String(item.slug),
            displayName: item.displayName ?? null,
            description: item.summary || '',
            tags: [...(item.topics ?? [])],
            version: humanizeClawVersion(rawVersion == null ? null : String(rawVersion)),
            updatedAt: item.updatedAt ? Number(item.updatedAt) / 1000 : null,
            author: owner.displayName || owner.handle || null,
            iconUrl: owner.image ?? null,
            installs: stats.installs ?? null,
            downloads: stats.downloads ?? item.downloads ?? null,
            url: canonical ? `${this.baseUrl}${canonical}` : `${this.baseUrl}/skills/${item.slug}`,
            metadata,
        });
    }

    async listSkills(
        _userId: string,
        query: string | null = null,
        cursor: string | null = null,
        limit = 20
    ): Promise<SkillHubPage> {
        let records: unknown[];
        let nextCursor: string | null;
        if (query) {
            const response = await this.request('GET', '/api/v1/search', { q: query, limit });
            records = asRecord(await response.json()).results ?? [];
            nextCursor = null;
        } else {
            const response = await this.request('GET', '/api/v1/skills', { limit, cursor });
            const payload = asRecord(await response.json());
            records = payload.items ?? [];
            nextCursor = payload.nextCursor ?? null;
        }
        return new SkillHubPage(
            records
                .map(record => asRecord(record))
                .filter(record => Boolean(record.slug))
                .map(record => this.toCard(record)),
            nextCursor
        );
    }

    async getSkill(_userId: string, cardId: string): Promise<SkillCard> {
        const [slug, ownerParams] = ClawSkillHub.splitCardId(cardId);
        let detail: Response;
        let markdown: Response;
        try {
            [detail, markdown] = await Promise.all([
                this.request('GET', `/api/v1/skills/${slug}`, ownerParams),
                this.request('GET', `/api/v1/skills/${slug}/file`, {
                    path: 'SKILL.md',
                    ...ownerParams,
                }),
            ]);
        } catch (error) {
            if (error instanceof HubError && error.statusCode === 404) {
                throw new HubCardNotFoundError(cardId);
            }
            throw error;
        }
        const payload = asRecord(await detail.json());
        const item = { ...asRecord(payload.skill) };
        item.slug ??= slug;
        item.latestVersion = payload.latestVersion;
        item.owner = payload.owner;
        const card = this.toCard(item);
        const parsed = matter(await markdown.text());
        card.markdown = parsed.content;
        if (!card.description) card.description = String(parsed.data.description ?? '');
        return card;
    }

    async download(
        _userId: string,
        cardId: string,
        version: string | null = null,
        tag: string | null = null,
        chunkSize = DEFAULT_SKILL_ARCHIVE_CHUNK_SIZE
    ): Promise<SkillArchive> {
        const [slug, ownerParams] = ClawSkillHub.splitCardId(cardId);
        const params = { slug, ...ownerParams, version, tag };
        const url = withQuery(this.baseUrl, '/api/v1/download', params);
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            const response = await fetchWithTimeout(
                this.fetcher,
                url,
                { method: 'GET', headers: this.headers() },
                this.timeout
            );
            if (response.status === 429 && attempt < this.maxRetries) {
                const delay = this.retryDelay(response.headers) + this.random();
                await response.body?.cancel();
                await this.sleep(delay * 1000);
                continue;
            }
            if (!response.ok) {
                const body = await response.text();
                if (response.status === 404) throw new HubCardNotFoundError(cardId);
                throw new HubError(
                    this.hubId,
                    response.status,
                    ClawSkillHub.describeError(response.status, body)
                );
            }
            return { format: 'zip', stream: readChunks(response, chunkSize) };
        }
        throw new HubError(this.hubId, 429, 'Rate limit exceeded after retries');
    }

    /** Python-style method aliases for parity-oriented integrations. */
    readonly list_skills = this.listSkills.bind(this);
    readonly get_skill = this.getSkill.bind(this);
}
