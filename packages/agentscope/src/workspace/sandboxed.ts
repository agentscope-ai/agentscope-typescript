/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as tar from 'tar';

import { _generateId } from '../_utils';
import { logger } from '../logger';
import { MCPClient } from '../mcp';
import { WorkspaceBase, type WorkspaceBaseOptions } from './base';
import { GatewayClient, GatewayMCPClient } from './gateway';
import { GATEWAY_PYTHON_SCRIPT } from './gateway-script';

export const DEFAULT_GATEWAY_VENV = '.venv';
export const DEFAULT_GATEWAY_LOG = 'gateway.log';
export const DEFAULT_GATEWAY_SCRIPT = '_mcp_gateway_app.py';

/** Template lifecycle for workspaces backed by an isolated execution environment. */
export abstract class SandboxedWorkspaceBase extends WorkspaceBase {
    abstract readonly gatewayPort: number | null;
    protected abstract readonly gatewayHome: string;
    protected gateway: GatewayClient | null = null;
    protected bootstrapCommandTimeout = 1800;

    constructor(options: WorkspaceBaseOptions = {}) {
        super(options);
    }

    protected get gatewayVenv(): string {
        return this.getBackend().joinPath(this.gatewayHome, DEFAULT_GATEWAY_VENV);
    }

    protected get gatewayPython(): string {
        return this.getBackend().joinPath(this.gatewayVenv, 'bin', 'python');
    }

    protected get gatewayScript(): string {
        return this.getBackend().joinPath(this.gatewayHome, DEFAULT_GATEWAY_SCRIPT);
    }

    protected get gatewayLog(): string {
        return this.getBackend().joinPath(this.gatewayHome, DEFAULT_GATEWAY_LOG);
    }

    protected get gatewayAuthToken(): string | null {
        return null;
    }

    protected get gatewayInstanceNonce(): string | null {
        return null;
    }

    protected abstract provisionBackend(): Promise<void>;
    protected abstract teardownBackend(): Promise<void>;

    protected bootstrapCommands(): string[] {
        return [];
    }

    async initialize(): Promise<void> {
        if (this.isAlive) return;
        await this.provisionBackend();
        if (!this.backend) throw new Error('provisionBackend() must bind a backend.');
        await this.restoreMcpSpecs();
        await this.ensureWorkspaceLayout();
        await this.setupMcpGateway();
        await this.migrateSkillLayout();
        await this.setupSkillSeeds();
        this.isAlive = true;
    }

    async close(): Promise<void> {
        if (this.gateway) await this.gateway.close().catch(() => undefined);
        this.gateway = null;
        this.mcpInstances.clear();
        this.mcpLastUsed.clear();
        try {
            await this.teardownBackend();
        } finally {
            this.backend = null;
            this.isAlive = false;
        }
    }

    async reset(): Promise<void> {
        const backend = this.getBackend();
        await this.mcpLock.run(async () => {
            for (const clients of this.mcpInstances.values()) {
                for (const client of clients.values()) {
                    await client.close().catch(() => undefined);
                }
            }
            this.mcpInstances.clear();
            this.mcpLastUsed.clear();
            this.mcpSpecs.clear();
        });
        await this.skillLock.run(async () => {
            this.equippedPartitions.clear();
            for (const target of [this.sessionsDir, this.dataDir, this.skillsDir, this.mcpFile]) {
                await backend.deletePath(target);
            }
        });
    }

    override async listMcps(
        options: { agentId?: string; sessionId?: string } = {}
    ): Promise<GatewayMCPClient[]> {
        const gateway = this.gateway;
        if (!gateway) return [];
        const agentId = options.agentId ?? '';
        const sessionId = options.sessionId ?? '';
        return this.mcpLock.run(async () => {
            const key = this.scopeKey(agentId, sessionId);
            this.mcpLastUsed.set(key, performance.now());
            const live = this.mcpInstances.get(key) ?? new Map<string, MCPClient>();
            this.mcpInstances.set(key, live);
            const specs = this.declaredSpecs(agentId, sessionId);
            for (const spec of specs) {
                if (live.has(spec.name)) continue;
                await this.enforceMcpCapacity(agentId, sessionId, spec);
                try {
                    const client = gateway.makeClient(spec, { agentId, sessionId });
                    await client.connect();
                    live.set(client.name, client);
                } catch (error) {
                    logger.warning('Failed to start gateway MCP %s: %s', spec.name, String(error));
                }
            }
            return specs.flatMap(spec => {
                const client = live.get(spec.name);
                return client instanceof GatewayMCPClient ? [client] : [];
            });
        });
    }

    async addMcp(
        source: MCPClient,
        options: { agentId?: string; sessionId?: string } = {}
    ): Promise<void> {
        if (!this.gateway) throw new Error('Workspace has no MCP gateway attached.');
        const agentId = options.agentId ?? '';
        const sessionId = options.sessionId ?? '';
        await this.mcpLock.run(async () => {
            const specs = this.declaredSpecs(agentId, sessionId);
            if (specs.some(client => client.name === source.name)) {
                throw new Error(`MCP ${JSON.stringify(source.name)} already exists.`);
            }
            await this.enforceMcpCapacity(agentId, sessionId, source);
            const client = this.gateway!.makeClient(source, { agentId, sessionId });
            await client.connect();
            const key = this.scopeKey(agentId, sessionId);
            const live = this.mcpInstances.get(key) ?? new Map<string, MCPClient>();
            live.set(client.name, client);
            this.mcpInstances.set(key, live);
            this.mcpSpecs.set(key, [...specs, source]);
            await this.saveMcpFile();
        });
    }

    async removeMcp(
        name: string,
        options: { agentId?: string; sessionId?: string } = {}
    ): Promise<void> {
        if (!this.gateway) throw new Error('Workspace has no MCP gateway attached.');
        const agentId = options.agentId ?? '';
        const sessionId = options.sessionId ?? '';
        await this.mcpLock.run(async () => {
            const specs = this.declaredSpecs(agentId, sessionId);
            if (!specs.some(client => client.name === name)) return;
            const key = this.scopeKey(agentId, sessionId);
            const client = this.mcpInstances.get(key)?.get(name);
            if (client) {
                this.mcpInstances.get(key)?.delete(name);
                await client.close();
            }
            this.mcpSpecs.set(
                key,
                specs.filter(client => client.name !== name)
            );
            await this.saveMcpFile();
        });
    }

    protected async ensureWorkspaceLayout(): Promise<void> {
        const result = await this.getBackend().execShell([
            'mkdir',
            '-p',
            this.workdir,
            this.dataDir,
            this.skillsDir,
            this.sessionsDir,
            this.gatewayHome,
        ]);
        if (!result.ok()) throw new Error(`Failed to create workspace layout: ${result.stderr}`);
    }

    protected createGatewayClient(): GatewayClient {
        if (this.gatewayPort === null) throw new Error('Gateway port is not allocated.');
        return new GatewayClient({
            backend: this.getBackend(),
            gatewayPort: this.gatewayPort,
            timeout: 30,
            gatewayLogPath: this.gatewayLog,
            authToken: this.gatewayAuthToken,
            instanceNonce: this.gatewayInstanceNonce,
        });
    }

    protected async setupMcpGateway(): Promise<void> {
        const backend = this.getBackend();
        if (this.gatewayPort === null) throw new Error('Gateway port is not allocated.');
        if (!(await backend.fileExists(this.gatewayScript))) {
            for (const command of this.bootstrapCommands()) {
                const result = await backend.execShell(['sh', '-c', command], {
                    timeout: this.bootstrapCommandTimeout,
                });
                if (!result.ok()) {
                    throw new Error(
                        `${this.constructor.name} bootstrap failed for ${JSON.stringify(command)}: ` +
                            result.stderr.toString('utf8')
                    );
                }
            }
            await backend.writeFile(this.gatewayScript, Buffer.from(GATEWAY_PYTHON_SCRIPT));
        }
        await backend.execShell(['sh', '-c', "pkill -f '[_]mcp_gateway_app.py' || true"]);
        const arguments_ = [
            quoteShell(this.gatewayPython),
            '-u',
            quoteShell(this.gatewayScript),
            '--port',
            String(this.gatewayPort),
        ];
        if (this.gatewayAuthToken) {
            arguments_.push('--auth-token', quoteShell(this.gatewayAuthToken));
        }
        if (this.gatewayInstanceNonce) {
            arguments_.push('--instance-nonce', quoteShell(this.gatewayInstanceNonce));
        }
        const launch = `nohup ${arguments_.join(' ')} > ${quoteShell(this.gatewayLog)} 2>&1 &`;
        const launchResult = await backend.execShell(['sh', '-c', launch]);
        if (!launchResult.ok()) throw new Error(`Failed to launch gateway: ${launchResult.stderr}`);

        this.gateway = this.createGatewayClient();
        const deadline = Date.now() + 30_000;
        let delay = 100;
        while (Date.now() < deadline) {
            if (await this.gateway.health()) return;
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(Math.round(delay * 1.5), 1000);
        }
        let tail = '<no gateway log available>';
        try {
            tail = (await backend.readFile(this.gatewayLog)).subarray(-2000).toString('utf8');
        } catch {}
        throw new Error(`Gateway did not become healthy within 30s.\n${tail}`);
    }

    protected async migrateSkillLayout(): Promise<void> {
        const script = [
            'import os,shutil,sys',
            'skills,seed_name=sys.argv[1:3]',
            'seed=os.path.join(skills,seed_name)',
            'os.makedirs(seed,exist_ok=True)',
            'for name in os.listdir(skills):',
            ' p=os.path.join(skills,name)',
            ' if name==seed_name: continue',
            " if name=='.skills' and os.path.isfile(p): shutil.move(p,os.path.join(seed,'.index'))",
            " elif os.path.isfile(os.path.join(p,'SKILL.md')): shutil.move(p,os.path.join(seed,name))",
        ].join('\n');
        const result = await this.getBackend().execShell([
            this.pythonCommand,
            '-c',
            script,
            this.skillsDir,
            '.seed',
        ]);
        if (!result.ok()) logger.warning('Failed to migrate skill layout: %s', result.stderr);
    }

    protected async setupSkillSeeds(): Promise<void> {
        if (!this.skillPaths.length) return;
        const backend = this.getBackend();
        if (
            (await backend.isDirectory(this.skillSeedDir)) &&
            (await backend.listDirectory(this.skillSeedDir)).length > 0
        ) {
            return;
        }
        const valid: string[] = [];
        for (const source of this.skillPaths) {
            if (
                await fs
                    .stat(path.join(source, 'SKILL.md'))
                    .then(() => true)
                    .catch(() => false)
            ) {
                valid.push(source);
            }
        }
        if (!valid.length) return;
        const localArchive = path.join(os.tmpdir(), `agentscope-seed-${_generateId()}.tar`);
        const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-seed-stage-'));
        const remoteArchive = `/tmp/agentscope-seed-${_generateId()}.tar`;
        try {
            for (const source of valid) {
                await fs.cp(source, path.join(staging, path.basename(source)), {
                    recursive: true,
                    errorOnExist: true,
                });
            }
            await tar.c({ cwd: staging, file: localArchive }, await fs.readdir(staging));
            await backend.writeFile(remoteArchive, await fs.readFile(localArchive));
            const result = await backend.execShell([
                this.pythonCommand,
                '-c',
                [
                    'import os,sys,tarfile',
                    'src,dst=sys.argv[1:3]',
                    'os.makedirs(dst,exist_ok=True)',
                    'with tarfile.open(src) as tf: tf.extractall(dst)',
                    'os.unlink(src)',
                ].join('\n'),
                remoteArchive,
                this.skillSeedDir,
            ]);
            if (!result.ok()) throw new Error(`Failed to seed skills: ${result.stderr}`);
        } finally {
            await fs.rm(localArchive, { force: true });
            await fs.rm(staging, { recursive: true, force: true });
            await backend.deletePath(remoteArchive);
        }
    }
}

function quoteShell(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
