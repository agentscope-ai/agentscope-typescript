import { MCPRenderError, renderMCP } from '../src/service';

const apiKeySchema = {
    type: 'object',
    properties: {
        api_key: { type: 'string', writeOnly: true, format: 'password' },
    },
    required: ['api_key'],
};

const httpCard = (config: Record<string, unknown> = {}) => ({
    name: 'notion',
    inputs_schema: apiKeySchema,
    config_template: {
        type: 'http_mcp' as const,
        url: 'https://mcp.example.com/sse',
        ...config,
    },
});

describe('renderMCP', () => {
    test('substitutes URL and headers', () => {
        const client = renderMCP(
            httpCard({
                url: 'https://mcp.example.com/sse?key=${api_key}',
                headers: { Authorization: 'Bearer ${api_key}' },
            }),
            { api_key: 'sk-secret' }
        );
        expect(client.mcpConfig).toMatchObject({
            url: 'https://mcp.example.com/sse?key=sk-secret',
            headers: { Authorization: 'Bearer sk-secret' },
        });
        expect(client.name).toBe('notion');
    });

    test('substitutes stdio args and env', () => {
        const client = renderMCP(
            {
                name: 'local',
                inputs_schema: apiKeySchema,
                config_template: {
                    type: 'stdio_mcp',
                    command: 'uvx',
                    args: ['server', '--token', '${api_key}'],
                    env: { API_KEY: '${api_key}' },
                },
            },
            { api_key: 'sk-secret' }
        );
        expect(client.mcpConfig).toMatchObject({
            args: ['server', '--token', 'sk-secret'],
            env: { API_KEY: 'sk-secret' },
        });
    });

    test('preserves literal braces and undeclared variables', () => {
        const http = renderMCP(
            httpCard({
                url: 'https://mcp.example.com/{tenant}/sse',
                headers: {
                    'X-Filter': '{"kind": "all"}',
                    Authorization: 'Bearer ${api_key}',
                },
            }),
            { api_key: 'sk-secret' }
        );
        expect(http.mcpConfig).toMatchObject({
            url: 'https://mcp.example.com/{tenant}/sse',
            headers: {
                'X-Filter': '{"kind": "all"}',
                Authorization: 'Bearer sk-secret',
            },
        });

        const stdio = renderMCP(
            {
                name: 'local',
                inputs_schema: apiKeySchema,
                config_template: {
                    type: 'stdio_mcp',
                    command: 'uvx',
                    args: ['--config', '$HOME/.config', '$$CACHE', '${api_key}'],
                },
            },
            { api_key: 'sk-secret' }
        );
        expect(stdio.mcpConfig).toMatchObject({
            args: ['--config', '$HOME/.config', '$CACHE', 'sk-secret'],
        });
    });

    test('rejects missing required and invalid typed values', () => {
        expect(() => renderMCP(httpCard(), {})).toThrow(/api_key/);
        expect(() => renderMCP(httpCard(), { api_key: 12345 })).toThrow(MCPRenderError);
    });

    test('reports optional placeholders outside env', () => {
        expect(() =>
            renderMCP(
                {
                    name: 'notion',
                    inputs_schema: {
                        type: 'object',
                        properties: { region: { type: 'string' } },
                    },
                    config_template: {
                        type: 'http_mcp',
                        url: 'https://${region}.example.com/sse',
                    },
                },
                {}
            )
        ).toThrow(/region/);
    });

    test('omits optional env and fills schema defaults without mutating input', () => {
        const optional = renderMCP(
            {
                name: 'local',
                inputs_schema: {
                    type: 'object',
                    properties: { region: { type: 'string' } },
                },
                config_template: {
                    type: 'stdio_mcp',
                    command: 'uvx',
                    args: ['server'],
                    env: { REGION: '${region}' },
                },
            },
            {}
        );
        expect(optional.mcpConfig).toMatchObject({ env: {} });

        const submitted = {};
        const defaulted = renderMCP(
            {
                name: 'local',
                inputs_schema: {
                    type: 'object',
                    properties: { mode: { type: 'string', default: 'safe' } },
                },
                config_template: {
                    type: 'stdio_mcp',
                    command: 'uvx',
                    args: ['server'],
                    env: { MODE: '${mode}' },
                },
            },
            submitted
        );
        expect(defaulted.mcpConfig).toMatchObject({ env: { MODE: 'safe' } });
        expect(submitted).toEqual({});
    });

    test('supports no-input cards and name overrides', () => {
        const client = renderMCP(
            {
                name: 'public',
                is_stateful: false,
                config_template: {
                    type: 'http_mcp',
                    url: 'https://public.example.com/sse',
                },
            },
            {},
            'my-public'
        );
        expect(client.name).toBe('my-public');
        expect(client.mcpConfig).toMatchObject({ url: 'https://public.example.com/sse' });
    });

    test('wraps invalid client names', () => {
        expect(() =>
            renderMCP(
                {
                    name: 'not.a.valid.name',
                    config_template: {
                        type: 'http_mcp',
                        url: 'https://public.example.com/sse',
                    },
                },
                {}
            )
        ).toThrow(/invalid client/);
    });
});
