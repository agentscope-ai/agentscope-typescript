import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { HttpMCPConfig, MCPClient } from '../mcp';
import { LocalBackend } from '../tool';
import { GatewayClient } from './gateway';
import { SandboxedWorkspaceBase } from './sandboxed';

/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

describe('SandboxedWorkspaceBase Python parity', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-sandboxed-'));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    test('runs lifecycle once and routes scoped MCPs through the gateway', async () => {
        const gateway = new RegistryGateway();
        const workspace = new TestSandbox(root, gateway, [httpMcp('seed')]);

        await workspace.initialize();
        await workspace.initialize();
        expect(workspace.isAlive).toBe(true);
        expect(workspace.provisions).toBe(1);
        expect(
            (await workspace.listMcps({ agentId: 'a', sessionId: 's' })).map(x => x.name)
        ).toEqual(['seed']);

        await workspace.addMcp(httpMcp('extra'), { agentId: 'a', sessionId: 's' });
        expect(
            (await workspace.listMcps({ agentId: 'a', sessionId: 's' })).map(x => x.name)
        ).toEqual(['seed', 'extra']);
        await workspace.removeMcp('seed', { agentId: 'a', sessionId: 's' });
        expect(gateway.requests).toEqual([
            ['POST', '/mcps', 'a', 's'],
            ['POST', '/mcps', 'a', 's'],
            ['DELETE', '/mcps/seed', 'a', 's'],
        ]);

        const persisted = JSON.parse(await fs.readFile(path.join(root, '.mcp'), 'utf8'));
        expect(persisted).toEqual({
            version: 2,
            mcps: {
                a: {
                    s: [
                        expect.objectContaining({
                            name: 'extra',
                            is_stateful: false,
                            mcp_config: expect.objectContaining({ type: 'http_mcp' }),
                        }),
                    ],
                },
            },
        });

        await workspace.close();
        await workspace.close();
        expect(workspace.isAlive).toBe(false);
        expect(workspace.teardowns).toBe(2);
        expect(() => workspace.getBackend()).toThrow('no active backend');
    });

    test('reset deregisters live proxies and wipes user state but keeps the sandbox alive', async () => {
        const gateway = new RegistryGateway();
        const workspace = new TestSandbox(root, gateway, [httpMcp('seed')]);
        await workspace.initialize();
        await workspace.listMcps({ agentId: 'a', sessionId: 's' });
        await workspace.offloadContext('s', []);
        await fs.mkdir(path.join(root, 'skills', 'a'), { recursive: true });

        await workspace.reset();

        expect(workspace.isAlive).toBe(true);
        expect(gateway.requests.at(-1)).toEqual(['DELETE', '/mcps/seed', 'a', 's']);
        for (const target of ['.mcp', 'skills', 'sessions', 'data']) {
            await expect(fs.stat(path.join(root, target))).rejects.toThrow();
        }
        expect(
            (await workspace.listMcps({ agentId: 'a', sessionId: 's' })).map(x => x.name)
        ).toEqual(['seed']);
    });
});

/**
 *
 */
class TestSandbox extends SandboxedWorkspaceBase {
    readonly workdir: string;
    readonly gatewayPort = 5600;
    protected readonly gatewayHome: string;
    provisions = 0;
    teardowns = 0;
    private readonly injectedGateway: GatewayClient;

    /**
     *
     * @param workdir
     * @param gateway
     * @param defaults
     */
    constructor(workdir: string, gateway: GatewayClient, defaults: MCPClient[]) {
        super({ defaultMcps: defaults });
        this.workdir = workdir;
        this.gatewayHome = path.join(workdir, '.agentscope');
        this.injectedGateway = gateway;
    }

    /**
     *
     */
    async getInstructions(): Promise<string> {
        return 'sandbox';
    }

    /**
     *
     */
    protected async provisionBackend(): Promise<void> {
        this.provisions += 1;
        this.backend = new LocalBackend();
    }

    /**
     *
     */
    protected async teardownBackend(): Promise<void> {
        this.teardowns += 1;
    }

    /**
     *
     */
    protected override async ensureWorkspaceLayout(): Promise<void> {
        await Promise.all(
            [this.workdir, this.gatewayHome].map(directory =>
                fs.mkdir(directory, { recursive: true })
            )
        );
    }

    /**
     *
     */
    protected override async setupMcpGateway(): Promise<void> {
        this.gateway = this.injectedGateway;
    }

    /**
     *
     */
    protected override async migrateSkillLayout(): Promise<void> {}
    /**
     *
     */
    protected override async setupSkillSeeds(): Promise<void> {}
}

/**
 *
 */
class RegistryGateway extends GatewayClient {
    readonly requests: Array<[string, string, string, string]> = [];

    /**
     *
     */
    constructor() {
        super({ backend: new LocalBackend(), gatewayPort: 5600 });
    }

    /**
     *
     * @param method
     * @param requestPath
     * @param options
     * @param options.params
     * @param options.body
     */
    override async execRequest(
        method: string,
        requestPath: string,
        options: { params?: Record<string, string>; body?: unknown } = {}
    ): Promise<[number, Buffer]> {
        this.requests.push([
            method,
            requestPath,
            options.params?.agent_id ?? '',
            options.params?.session_id ?? '',
        ]);
        return [200, Buffer.from('{}')];
    }
}

/**
 *
 * @param name
 */
function httpMcp(name: string): MCPClient {
    return new MCPClient({
        name,
        isStateful: false,
        mcpConfig: new HttpMCPConfig({ url: `https://example.com/${name}` }),
    });
}
