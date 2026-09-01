import { GitHubMCPHub, type MCPCard } from '../src/hub';
import { renderMCP } from '../src/service';

describe('Python GitHub MCP card conversion parity', () => {
    const hub = new GitHubMCPHub();
    const card = (server: Record<string, unknown>, github: Record<string, unknown> = {}): MCPCard =>
        hub.toCard({
            server: { id: 'abc', name: 'acme/thing', ...server },
            'x-github': github,
        })!;

    test('turns a remote into a stateless public HTTP config', () => {
        const result = card({ remotes: [{ transport_type: 'streamable-http', url: 'u' }] });
        expect(result.configTemplate.type).toBe('http_mcp');
        expect(result.isStateful).toBe(false);
        expect(result.auth).toBe('none');
    });

    test('turns a secret header into a required masked input', () => {
        const result = card({
            remotes: [
                {
                    url: 'https://example.com/mcp',
                    headers: [
                        { value: 'Bearer {TOKEN}', is_secret: true, description: 'The token.' },
                    ],
                },
            ],
        });
        expect(result.inputsSchema).toEqual({
            type: 'object',
            properties: {
                TOKEN: {
                    type: 'string',
                    title: 'TOKEN',
                    description: 'The token.',
                    writeOnly: true,
                    format: 'password',
                },
            },
            required: ['TOKEN'],
        });
        expect(result.configTemplate).toMatchObject({
            headers: { Authorization: 'Bearer ${TOKEN}' },
        });
        expect(renderMCP(result, { TOKEN: 'sk' }).mcpConfig).toMatchObject({
            headers: { Authorization: 'Bearer sk' },
        });
    });

    test('turns an npx package into a stateful stdio config', () => {
        const result = card({
            packages: [{ name: 'pkg', version: '1.2.3', runtime_hint: 'npx' }],
        });
        expect(result.configTemplate).toMatchObject({
            type: 'stdio_mcp',
            command: 'npx',
            args: ['-y', 'pkg@1.2.3'],
        });
        expect(result.isStateful).toBe(true);
    });

    test('turns a secret environment variable into an input', () => {
        const result = card({
            packages: [
                {
                    name: 'pkg',
                    runtime_hint: 'uvx',
                    environment_variables: [
                        { name: 'API_KEY', is_required: true, is_secret: true },
                    ],
                },
            ],
        });
        expect(result.inputsSchema).toMatchObject({ properties: { API_KEY: {} } });
        expect(result.configTemplate).toMatchObject({ env: { API_KEY: '${API_KEY}' } });
    });

    test('collects required non-secret environment variables', () => {
        const result = card({
            packages: [
                {
                    name: 'pkg',
                    runtime_hint: 'uvx',
                    environment_variables: [
                        {
                            name: 'DT_ENVIRONMENT',
                            description: 'Dynatrace URL',
                            is_required: true,
                        },
                    ],
                },
            ],
        });
        expect(result.inputsSchema).toMatchObject({
            properties: { DT_ENVIRONMENT: { description: 'Dynatrace URL' } },
            required: ['DT_ENVIRONMENT'],
        });
        expect(
            renderMCP(result, { DT_ENVIRONMENT: 'https://example.com' }).mcpConfig
        ).toMatchObject({
            env: { DT_ENVIRONMENT: 'https://example.com' },
        });
    });

    test('applies an input default when the caller omits it', () => {
        const result = card({
            packages: [
                {
                    name: 'pkg',
                    runtime_hint: 'uvx',
                    environment_variables: [{ name: 'MODE', default: 'safe' }],
                },
            ],
        });
        expect(result.inputsSchema).toMatchObject({ properties: { MODE: { default: 'safe' } } });
        expect(renderMCP(result, {}).mcpConfig).toMatchObject({ env: { MODE: 'safe' } });
    });

    test('uses a nested variable definition independently of its env name', () => {
        const result = card({
            packages: [
                {
                    name: 'firecrawl-mcp',
                    runtime_hint: 'npx',
                    environment_variables: [
                        {
                            name: 'FIRECRAWL_API_KEY',
                            value: '{api_key}',
                            variables: {
                                api_key: {
                                    description: 'your API key',
                                    is_required: true,
                                    is_secret: true,
                                },
                            },
                        },
                    ],
                },
            ],
        });
        expect(result.configTemplate).toMatchObject({ env: { FIRECRAWL_API_KEY: '${api_key}' } });
        expect(result.inputsSchema).toMatchObject({
            properties: { api_key: { writeOnly: true } },
        });
        expect(renderMCP(result, { api_key: 'fc-secret' }).mcpConfig).toMatchObject({
            env: { FIRECRAWL_API_KEY: 'fc-secret' },
        });
    });

    test('preserves a literal environment value', () => {
        const result = card({
            packages: [
                {
                    name: 'sendmux-mcp',
                    runtime_hint: 'uvx',
                    environment_variables: [
                        {
                            name: 'SENDMUX_MCP_SURFACES',
                            value: 'mailbox,management,sending',
                            is_required: true,
                        },
                    ],
                },
            ],
        });
        expect(result.configTemplate).toMatchObject({
            env: { SENDMUX_MCP_SURFACES: 'mailbox,management,sending' },
        });
    });

    test('skips an unrunnable package or entry with no transport', () => {
        expect(
            hub.toCard({ server: { id: 'abc', name: 'thing', packages: [{ name: 'pkg' }] } })
        ).toBeNull();
        expect(hub.toCard({ server: { id: 'abc', name: 'thing' } })).toBeNull();
    });

    test('prefers a hosted remote over a local package', () => {
        expect(
            card({
                remotes: [{ url: 'u' }],
                packages: [{ name: 'p', runtime_hint: 'npx' }],
            }).configTemplate.type
        ).toBe('http_mcp');
    });

    test('slugs registry names for MCP client use', () => {
        const result = card({
            name: 'io.github.upstash/context7',
            remotes: [{ url: 'u' }],
        });
        expect([result.name, result.id]).toEqual(['context7', 'abc']);
    });

    test('maps GitHub display fields and timestamp', () => {
        const result = card(
            {
                remotes: [{ url: 'u' }],
                updated_at: '2026-01-21T09:35:10Z',
                repository: { url: 'https://github.com/acme/thing' },
                version_detail: { version: '1.0.0' },
            },
            {
                name_with_owner: 'acme/thing',
                preferred_image: 'https://avatars/acme',
                primary_language: 'Python',
                display_name: 'Thing',
            }
        );
        expect(result).toMatchObject({
            author: 'acme',
            iconUrl: 'https://avatars/acme',
            tags: ['Python'],
            displayName: 'Thing',
            url: 'https://github.com/acme/thing',
            version: '1.0.0',
        });
        expect(result.updatedAt).not.toBeNull();
    });

    test('drops a malformed timestamp without rejecting the card', () => {
        expect(card({ remotes: [{ url: 'u' }], updated_at: 'soon' }).updatedAt).toBeNull();
    });
});
