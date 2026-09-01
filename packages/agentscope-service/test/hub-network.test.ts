/* eslint-disable jsdoc/require-jsdoc */

import {
    ClawSkillHub,
    GitHubMCPHub,
    HubCardNotFoundError,
    HubError,
    type HubFetch,
} from '../src/hub';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function githubEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        server: {
            id: 'srv-1',
            name: 'io.github.acme/demo',
            description: 'A useful markdown server',
            remotes: [{ url: 'https://mcp.example.com/mcp' }],
            ...overrides,
        },
        'x-github': { display_name: 'Demo' },
    };
}

describe('GitHub MCP Hub HTTP behavior', () => {
    test('lists, filters, paginates, authenticates, and skips unusable entries', async () => {
        const requests: Array<{ url: URL; init?: RequestInit }> = [];
        const fetcher: HubFetch = async (input, init) => {
            requests.push({ url: new URL(input.toString()), init });
            return jsonResponse({
                servers: [githubEntry(), githubEntry({ id: 'bad', remotes: [], packages: [] })],
                metadata: { next_cursor: 'next-1' },
            });
        };
        const hub = new GitHubMCPHub({
            baseUrl: 'https://registry.example.test/',
            apiToken: 'gh-token',
            fetch: fetcher,
        });

        const page = await hub.listMCPs('alice', 'markdown', 'cursor-1', 7);

        expect(page.cards.map(card => card.id)).toEqual(['srv-1']);
        expect(page.nextCursor).toBe('next-1');
        expect(requests[0].url.pathname).toBe('/v0/servers');
        expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
            limit: '7',
            cursor: 'cursor-1',
        });
        expect(new Headers(requests[0].init?.headers).get('Authorization')).toBe('Bearer gh-token');
    });

    test('returns a detail card with README', async () => {
        const fetcher: HubFetch = async () =>
            jsonResponse(
                githubEntry({
                    repository: { readme: '# Demo', url: 'https://github.com/acme/demo' },
                })
            );
        const card = await new GitHubMCPHub({ fetch: fetcher }).getMCP('alice', 'srv-1');
        expect(card).toMatchObject({ readme: '# Demo', url: 'https://github.com/acme/demo' });
    });

    test('maps a missing or unusable detail to card-not-found', async () => {
        const missing = new GitHubMCPHub({
            fetch: async () => new Response('missing', { status: 404 }),
        });
        await expect(missing.getMCP('alice', 'missing')).rejects.toEqual(
            expect.objectContaining({ name: 'HubCardNotFoundError', cardId: 'missing' })
        );

        const unusable = new GitHubMCPHub({
            fetch: async () => jsonResponse(githubEntry({ remotes: [], packages: [] })),
        });
        await expect(unusable.getMCP('alice', 'bad')).rejects.toBeInstanceOf(HubCardNotFoundError);
    });

    test('preserves upstream status and body in HubError', async () => {
        const hub = new GitHubMCPHub({
            fetch: async () => new Response('rate limited', { status: 429 }),
        });
        await expect(hub.listMCPs('alice')).rejects.toEqual(
            expect.objectContaining({
                name: 'HubError',
                hubId: 'github',
                statusCode: 429,
                detail: 'rate limited',
            })
        );
    });
});

describe('Claw skill Hub HTTP behavior', () => {
    test('browses a cursor page and searches a single page', async () => {
        const urls: URL[] = [];
        const fetcher: HubFetch = async input => {
            const url = new URL(input.toString());
            urls.push(url);
            return url.pathname.endsWith('/search')
                ? jsonResponse({ results: [{ slug: 'search-result', ownerHandle: 'acme' }] })
                : jsonResponse({ items: [{ slug: 'catalog-result' }, {}], nextCursor: 'next' });
        };
        const hub = new ClawSkillHub({ baseUrl: 'https://claw.test', fetch: fetcher });

        const browse = await hub.listSkills('alice', null, 'cursor', 5);
        const search = await hub.listSkills('alice', 'git', 'ignored', 9);

        expect(browse.cards.map(card => card.id)).toEqual(['catalog-result']);
        expect(browse.nextCursor).toBe('next');
        expect(Object.fromEntries(urls[0].searchParams)).toEqual({ limit: '5', cursor: 'cursor' });
        expect(search.cards.map(card => card.id)).toEqual(['acme/search-result']);
        expect(search.nextCursor).toBeNull();
        expect(Object.fromEntries(urls[1].searchParams)).toEqual({ q: 'git', limit: '9' });
    });

    test('gets detail and strips YAML frontmatter from SKILL.md', async () => {
        const urls: URL[] = [];
        const fetcher: HubFetch = async input => {
            const url = new URL(input.toString());
            urls.push(url);
            if (url.pathname.endsWith('/file')) {
                return new Response('---\ndescription: From markdown\n---\nUse this skill.\n');
            }
            return jsonResponse({
                skill: { slug: 'demo', summary: '' },
                latestVersion: { version: '1.2.0' },
                owner: { handle: 'acme' },
            });
        };
        const card = await new ClawSkillHub({
            baseUrl: 'https://claw.test',
            fetch: fetcher,
        }).getSkill('alice', 'acme/demo');

        expect(card).toMatchObject({
            id: 'acme/demo',
            version: '1.2.0',
            description: 'From markdown',
            markdown: 'Use this skill.\n',
        });
        expect(urls).toHaveLength(2);
        for (const url of urls) expect(url.searchParams.get('ownerHandle')).toBe('acme');
        expect(urls.find(url => url.pathname.endsWith('/file'))?.searchParams.get('path')).toBe(
            'SKILL.md'
        );
    });

    test('maps a detail 404 and preserves other errors', async () => {
        const missing = new ClawSkillHub({
            fetch: async () => new Response('missing', { status: 404 }),
        });
        await expect(missing.getSkill('alice', 'missing')).rejects.toBeInstanceOf(
            HubCardNotFoundError
        );

        const failed = new ClawSkillHub({
            fetch: async () => new Response('boom', { status: 500 }),
        });
        await expect(failed.listSkills('alice')).rejects.toEqual(
            expect.objectContaining({ statusCode: 500, detail: 'boom' })
        );
    });

    test('retries 429 with Retry-After and jitter, then succeeds', async () => {
        const sleeps: number[] = [];
        let calls = 0;
        const hub = new ClawSkillHub({
            fetch: async () => {
                calls += 1;
                return calls === 1
                    ? new Response('slow down', {
                          status: 429,
                          headers: { 'Retry-After': '2' },
                      })
                    : jsonResponse({ items: [], nextCursor: null });
            },
            sleep: async milliseconds => {
                sleeps.push(milliseconds);
            },
            random: () => 0.25,
        });

        await expect(hub.listSkills('alice')).resolves.toMatchObject({ cards: [] });
        expect(calls).toBe(2);
        expect(sleeps).toEqual([2250]);
    });

    test('uses reset headers and stops after the configured retries', async () => {
        const hub = new ClawSkillHub({
            maxRetries: 1,
            fetch: async () =>
                new Response('still limited', {
                    status: 429,
                    headers: { 'X-RateLimit-Reset': '102' },
                }),
            now: () => 100_000,
            random: () => 0,
            sleep: async () => {},
        });
        expect(hub.retryDelay(new Headers({ 'RateLimit-Reset': '3' }))).toBe(3);
        expect(hub.retryDelay(new Headers({ 'X-RateLimit-Reset': '102' }))).toBe(2);
        await expect(hub.listSkills('alice')).rejects.toBeInstanceOf(HubError);
    });

    test('streams a ZIP archive with exact chunking and download parameters', async () => {
        let requested!: URL;
        const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);
        const hub = new ClawSkillHub({
            baseUrl: 'https://claw.test',
            apiToken: 'clh_secret',
            fetch: async (input, init) => {
                requested = new URL(input.toString());
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer clh_secret');
                return new Response(bytes);
            },
        });

        const archive = await hub.download('alice', 'acme/demo', '1.2.0', 'latest', 3);
        const chunks: number[][] = [];
        for await (const chunk of archive.stream) chunks.push([...chunk]);

        expect(archive.format).toBe('zip');
        expect(chunks).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
        expect(Object.fromEntries(requested.searchParams)).toEqual({
            slug: 'demo',
            ownerHandle: 'acme',
            version: '1.2.0',
            tag: 'latest',
        });
    });

    test('maps download 404 and a structured 409', async () => {
        const missing = new ClawSkillHub({
            fetch: async () => new Response('missing', { status: 404 }),
        });
        await expect(missing.download('alice', 'missing')).rejects.toBeInstanceOf(
            HubCardNotFoundError
        );

        const conflict = new ClawSkillHub({
            fetch: async () =>
                jsonResponse(
                    {
                        code: 'AMBIGUOUS_SKILL_SLUG',
                        slug: 'music',
                        matches: [{ ref: '@a/music' }, { ref: '@b/music' }],
                    },
                    409
                ),
        });
        await expect(conflict.download('alice', 'music')).rejects.toEqual(
            expect.objectContaining({
                statusCode: 409,
                detail: expect.stringContaining('@a/music, @b/music'),
            })
        );
    });
});
