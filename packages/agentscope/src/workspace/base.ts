/* eslint-disable jsdoc/require-jsdoc */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import matter from 'gray-matter';
import mime from 'mime-types';
import * as tar from 'tar';

import { _generateId } from '../_utils';
import { logger } from '../logger';
import { HttpMCPConfig, MCPClient, StdioMCPConfig, type MCPClientOptions } from '../mcp';
import type { DataBlock, Msg, ToolResultBlock } from '../message';
import { DataBlock as createDataBlock, URLSource } from '../message';
import { Skill } from '../skill';
import type { BackendBase, ToolBase } from '../tool';
import { Bash, Edit, Glob, Grep, Read, Write } from '../tool';
import { findSkillRoot, type SkillArchiveFormat } from './archive';
import {
    DEFAULT_DATA_DIR,
    DEFAULT_MAX_EXTRACTED_BYTES,
    DEFAULT_MCP_FILE,
    DEFAULT_SESSIONS_DIR,
    DEFAULT_SKILLS_DIR,
    DEFAULT_SKILL_PARTITION,
    SKILL_SEED_DIR,
} from './utils';

const MCP_FILE_VERSION = 2;
const DEFAULT_MAX_LIVE_STATEFUL_MCPS = 40;

const EXTRACT_TAR_SCRIPT = [
    'import os,sys,tarfile',
    'src,dst=sys.argv[1:3]',
    'os.makedirs(dst,exist_ok=True)',
    'root=os.path.realpath(dst)',
    'tf=tarfile.open(src)',
    'members=tf.getmembers()',
    "assert all((lambda p:p==root or p.startswith(root+os.sep))(os.path.realpath(os.path.join(dst,m.name))) for m in members),'unsafe tar member'",
    'tf.extractall(dst,members=members)',
    'tf.close()',
    'os.unlink(src)',
].join('\n');

class AsyncLock {
    private tail: Promise<void> = Promise.resolve();

    async run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.tail.then(operation, operation);
        this.tail = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }
}

export interface Offloader {
    offloadDataBlock(block: DataBlock): Promise<DataBlock>;
    offloadContext(sessionId: string, msgs: Msg[]): Promise<string>;
    offloadToolResult(sessionId: string, toolResult: ToolResultBlock): Promise<string>;
}

export interface WorkspaceBaseOptions {
    workspaceId?: string;
    defaultMcps?: MCPClient[];
    skillPaths?: string[];
    maxLiveStatefulMcps?: number;
}

interface MCPWire {
    name: string;
    is_stateful: boolean;
    mcp_config: Record<string, unknown>;
    enable_tools: string[] | null;
    disable_tools: string[] | null;
    execution_timeout: number | null;
}

/** Shared workspace lifecycle, resource isolation, and offload implementation. */
export abstract class WorkspaceBase implements Offloader {
    readonly workspaceId: string;
    readonly defaultMcps: MCPClient[];
    readonly skillPaths: string[];
    readonly maxLiveStatefulMcps: number;
    abstract readonly workdir: string;
    isAlive = false;
    protected backend: BackendBase | null = null;
    protected readonly mcpSpecs = new Map<string, MCPClient[]>();
    protected readonly mcpInstances = new Map<string, Map<string, MCPClient>>();
    protected readonly mcpLastUsed = new Map<string, number>();
    protected readonly equippedPartitions = new Set<string>();
    protected readonly mcpLock = new AsyncLock();
    protected readonly skillLock = new AsyncLock();

    constructor(options: WorkspaceBaseOptions = {}) {
        this.workspaceId = options.workspaceId ?? _generateId();
        this.defaultMcps = [...(options.defaultMcps ?? [])];
        this.skillPaths = (options.skillPaths ?? []).map(value => path.resolve(value));
        this.maxLiveStatefulMcps =
            options.maxLiveStatefulMcps ||
            Math.max(
                DEFAULT_MAX_LIVE_STATEFUL_MCPS,
                2 * this.defaultMcps.filter(client => client.isStateful).length
            );
    }

    protected get dataDir(): string {
        return this.getBackend().joinPath(this.workdir, DEFAULT_DATA_DIR);
    }

    protected get skillsDir(): string {
        return this.getBackend().joinPath(this.workdir, DEFAULT_SKILLS_DIR);
    }

    protected get skillSeedDir(): string {
        return this.getBackend().joinPath(this.skillsDir, SKILL_SEED_DIR);
    }

    protected get sessionsDir(): string {
        return this.getBackend().joinPath(this.workdir, DEFAULT_SESSIONS_DIR);
    }

    protected get mcpFile(): string {
        return this.getBackend().joinPath(this.workdir, DEFAULT_MCP_FILE);
    }

    protected get pythonCommand(): string {
        return 'python3';
    }

    get isPersistent(): boolean {
        return true;
    }

    static pathToFileUri(filePath: string): string {
        if (filePath.startsWith('/')) return `file://${filePath}`;
        if (/^[A-Za-z]:[\\/]/.test(filePath)) {
            return `file:///${filePath.replaceAll('\\', '/')}`;
        }
        if (!path.isAbsolute(filePath)) {
            throw new Error(`Cannot convert a relative path to a file URI: ${filePath}`);
        }
        return pathToFileURL(filePath).toString();
    }

    abstract initialize(): Promise<void>;
    abstract close(): Promise<void>;
    abstract getInstructions(): Promise<string>;
    abstract addMcp(
        client: MCPClient,
        options?: { agentId?: string; sessionId?: string }
    ): Promise<void>;
    abstract removeMcp(
        name: string,
        options?: { agentId?: string; sessionId?: string }
    ): Promise<void>;

    async reset(): Promise<void> {}

    getBackend(): BackendBase {
        if (!this.backend) {
            throw new Error(
                `${this.constructor.name} has no active backend. Initialize the workspace before requesting its backend.`
            );
        }
        return this.backend;
    }

    async enter(): Promise<this> {
        await this.initialize();
        this.isAlive = true;
        return this;
    }

    async exit(): Promise<void> {
        await this.close();
        this.isAlive = false;
    }

    async listTools(): Promise<ToolBase[]> {
        const backend = this.getBackend();
        return [
            Bash({ cwd: this.workdir, backend }),
            Edit({ backend }),
            Glob({ backend }),
            Grep({ backend }),
            Read({ backend }),
            Write({ backend }),
        ];
    }

    protected scopeKey(agentId = '', sessionId = ''): string {
        return JSON.stringify([agentId, sessionId]);
    }

    protected declaredSpecs(agentId: string, sessionId: string): MCPClient[] {
        const declared = this.mcpSpecs.get(this.scopeKey(agentId, sessionId));
        return declared ?? this.defaultMcps.map(cloneMcpClient);
    }

    async listMcps(options: { agentId?: string; sessionId?: string } = {}): Promise<MCPClient[]> {
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
                const client = cloneMcpClient(spec);
                try {
                    if (client.isStateful) await client.connect();
                    live.set(client.name, client);
                } catch (error) {
                    logger.warning(
                        'Failed to start MCP %s for agent=%s session=%s: %s',
                        client.name,
                        agentId,
                        sessionId,
                        String(error)
                    );
                }
            }
            return specs.flatMap(spec => {
                const client = live.get(spec.name);
                return client ? [client] : [];
            });
        });
    }

    async purgeSession(options: { agentId: string; sessionId: string }): Promise<void> {
        await this.mcpLock.run(async () => {
            const key = this.scopeKey(options.agentId, options.sessionId);
            const instances = this.mcpInstances.get(key);
            if (instances) {
                for (const client of instances.values()) await this.closeMcpInstance(client);
            }
            this.mcpInstances.delete(key);
            this.mcpLastUsed.delete(key);
            if (this.mcpSpecs.delete(key)) await this.saveMcpFile();
        });
        if (this.backend && options.sessionId) {
            try {
                await this.backend.deletePath(
                    this.backend.joinPath(this.sessionsDir, options.sessionId)
                );
            } catch (error) {
                logger.warning('Failed to purge session %s: %s', options.sessionId, String(error));
            }
        }
    }

    async purgeAgent(agentId: string): Promise<void> {
        if (!this.backend || !agentId) return;
        try {
            const partition = this.skillPartition(agentId);
            this.equippedPartitions.delete(partition);
            await this.backend.deletePath(partition);
        } catch (error) {
            logger.warning('Failed to purge agent %s: %s', agentId, String(error));
        }
    }

    protected async closeMcpInstance(client: MCPClient): Promise<void> {
        if (!client.isStateful || !client.isConnected) return;
        try {
            await client.close();
        } catch (error) {
            logger.warning('MCP %s close failed: %s', client.name, String(error));
        }
    }

    protected async closeAllMcpInstances(): Promise<void> {
        for (const clients of this.mcpInstances.values()) {
            for (const client of clients.values()) await this.closeMcpInstance(client);
        }
        this.mcpInstances.clear();
        this.mcpLastUsed.clear();
    }

    protected async enforceMcpCapacity(
        agentId: string,
        sessionId: string,
        incoming: MCPClient
    ): Promise<void> {
        if (!incoming.isStateful) return;
        const currentKey = this.scopeKey(agentId, sessionId);
        while (this.liveStatefulMcpCount() >= this.maxLiveStatefulMcps) {
            let victimKey: string | null = null;
            let victimTime = Number.POSITIVE_INFINITY;
            for (const [key, clients] of this.mcpInstances) {
                if (key === currentKey || ![...clients.values()].some(item => item.isStateful)) {
                    continue;
                }
                const used = this.mcpLastUsed.get(key) ?? 0;
                if (used < victimTime) {
                    victimKey = key;
                    victimTime = used;
                }
            }
            if (!victimKey) return;
            const victim = this.mcpInstances.get(victimKey)!;
            const entry = [...victim.entries()].find(([, client]) => client.isStateful);
            if (!entry) return;
            victim.delete(entry[0]);
            await this.closeMcpInstance(entry[1]);
        }
    }

    private liveStatefulMcpCount(): number {
        let count = 0;
        for (const clients of this.mcpInstances.values()) {
            count += [...clients.values()].filter(client => client.isStateful).length;
        }
        return count;
    }

    protected async saveMcpFile(): Promise<void> {
        if (!this.isPersistent || !this.backend) return;
        const mcps: Record<string, Record<string, MCPWire[]>> = {};
        for (const [key, clients] of this.mcpSpecs) {
            const [agentId, sessionId] = JSON.parse(key) as [string, string];
            mcps[agentId] ??= {};
            mcps[agentId][sessionId] = clients.map(mcpToWire);
        }
        try {
            await this.backend.writeFile(
                this.mcpFile,
                Buffer.from(JSON.stringify({ version: MCP_FILE_VERSION, mcps }, null, 2))
            );
        } catch (error) {
            logger.warning('Failed to save MCP file %s: %s', this.mcpFile, String(error));
        }
    }

    protected async restoreMcpSpecs(): Promise<void> {
        this.mcpSpecs.clear();
        if (!this.isPersistent || !this.backend || !(await this.backend.fileExists(this.mcpFile))) {
            return;
        }
        try {
            const data = JSON.parse(
                (await this.backend.readFile(this.mcpFile)).toString('utf8')
            ) as MCPWire[] | { mcps?: Record<string, Record<string, MCPWire[]>> };
            if (Array.isArray(data)) {
                this.mcpSpecs.set(
                    this.scopeKey(),
                    data.flatMap(value => {
                        try {
                            return [mcpFromWire(value)];
                        } catch (error) {
                            logger.warning('Skipping invalid MCP entry: %s', String(error));
                            return [];
                        }
                    })
                );
                return;
            }
            for (const [agentId, sessions] of Object.entries(data.mcps ?? {})) {
                for (const [sessionId, clients] of Object.entries(sessions)) {
                    this.mcpSpecs.set(
                        this.scopeKey(agentId, sessionId),
                        clients.flatMap(value => {
                            try {
                                return [mcpFromWire(value)];
                            } catch (error) {
                                logger.warning('Skipping invalid MCP entry: %s', String(error));
                                return [];
                            }
                        })
                    );
                }
            }
        } catch (error) {
            logger.warning('Failed to restore MCP file %s: %s', this.mcpFile, String(error));
        }
    }

    async offloadContext(sessionId: string, msgs: Msg[]): Promise<string> {
        const backend = this.getBackend();
        const outputPath = backend.joinPath(this.sessionsDir, sessionId, 'context.jsonl');
        const copied = structuredClone(msgs);
        for (const msg of copied) {
            msg.content = await Promise.all(
                msg.content.map(block =>
                    block.type === 'data' ? this.offloadDataBlock(block) : Promise.resolve(block)
                )
            );
        }
        const payload = `${copied.map(msg => JSON.stringify(msg)).join('\n')}\n`;
        let existing: Uint8Array = new Uint8Array();
        try {
            existing = await backend.readFile(outputPath);
        } catch {}
        await backend.writeFile(outputPath, Buffer.concat([existing, Buffer.from(payload)]));
        return outputPath;
    }

    async offloadToolResult(sessionId: string, toolResult: ToolResultBlock): Promise<string> {
        const backend = this.getBackend();
        const base = backend.joinPath(this.sessionsDir, sessionId);
        let outputPath = backend.joinPath(base, `tool_result-${toolResult.id}.txt`);
        let index = 1;
        while (await backend.fileExists(outputPath)) {
            outputPath = backend.joinPath(base, `tool_result-${toolResult.id}(${index}).txt`);
            index += 1;
        }
        const parts: string[] = [];
        if (typeof toolResult.output === 'string') {
            parts.push(toolResult.output);
        } else {
            for (const block of toolResult.output) {
                if (block.type === 'text') parts.push(block.text);
                if (block.type === 'data') {
                    const data = await this.offloadDataBlock(block);
                    const name = data.name == null ? 'None' : data.name;
                    parts.push(
                        `<data url='${data.source.type === 'url' ? data.source.url : ''}' ` +
                            `name='${name}' media_type='${data.source.media_type}'/>`
                    );
                }
            }
        }
        await backend.writeFile(outputPath, Buffer.from(parts.join('')));
        return outputPath;
    }

    async offloadDataBlock(block: DataBlock): Promise<DataBlock> {
        if (block.source.type !== 'base64') return block;
        const backend = this.getBackend();
        const hash = createHash('sha256').update(block.source.data).digest('hex');
        const extension = mime.extension(block.source.media_type) || 'bin';
        const relativePath = `${DEFAULT_DATA_DIR}/${hash}.${extension}`;
        const outputPath = backend.joinPath(this.dataDir, `${hash}.${extension}`);
        if (!(await backend.fileExists(outputPath))) {
            await backend.writeFile(outputPath, Buffer.from(block.source.data, 'base64'));
        }
        return createDataBlock({
            id: block.id,
            name: block.name,
            created_at: block.created_at,
            finished_at: block.finished_at,
            source: URLSource({
                url: `workspace:///${relativePath}`,
                media_type: block.source.media_type,
            }),
        });
    }

    protected skillPartition(agentId?: string): string {
        if (
            agentId &&
            (agentId.startsWith('.') || agentId.includes('/') || agentId.includes('\\'))
        ) {
            throw new Error(
                `Agent id ${JSON.stringify(agentId)} is not usable as a skill partition name.`
            );
        }
        return this.getBackend().joinPath(this.skillsDir, agentId || DEFAULT_SKILL_PARTITION);
    }

    protected async equipPartition(agentId?: string): Promise<string> {
        const partition = this.skillPartition(agentId);
        if (this.equippedPartitions.has(partition)) return partition;
        const backend = this.getBackend();
        if (!(await backend.isDirectory(partition))) {
            await backend.execShell([
                this.pythonCommand,
                '-c',
                [
                    'import os,shutil,sys',
                    'seed,dst=sys.argv[1:3]',
                    'os.makedirs(os.path.dirname(dst),exist_ok=True)',
                    'shutil.copytree(seed,dst) if os.path.isdir(seed) else os.makedirs(dst)',
                ].join('\n'),
                this.skillSeedDir,
                partition,
            ]);
        }
        this.equippedPartitions.add(partition);
        return partition;
    }

    async listSkills(options: { agentId?: string } = {}): Promise<Skill[]> {
        const backend = this.getBackend();
        const partition = await this.equipPartition(options.agentId);
        const skills: Skill[] = [];
        for (const filePath of await backend.listDirectory(partition, true)) {
            const skillDir = backend.dirname(filePath);
            if (
                backend.basename(filePath) !== 'SKILL.md' ||
                backend.dirname(skillDir) !== partition
            ) {
                continue;
            }
            try {
                const document = matter((await backend.readFile(filePath)).toString('utf8'));
                if (!document.data.name || !document.data.description) continue;
                skills.push(
                    new Skill({
                        name: String(document.data.name),
                        description: String(document.data.description),
                        dir: skillDir,
                        markdown: document.content,
                        updatedAt: 0,
                    })
                );
            } catch (error) {
                logger.warning('Failed to load skill %s: %s', filePath, String(error));
            }
        }
        return skills;
    }

    async addSkill(skillPath: string, options: { agentId?: string } = {}): Promise<void> {
        const source = path.resolve(skillPath);
        try {
            await fs.access(path.join(source, 'SKILL.md'));
        } catch {
            throw new Error(`Invalid skill at ${JSON.stringify(skillPath)}: SKILL.md not found`);
        }
        const backend = this.getBackend();
        const partition = await this.equipPartition(options.agentId);
        await this.skillLock.run(async () => {
            const directoryName = path.basename(source);
            const destination = backend.joinPath(partition, directoryName);
            if (await backend.fileExists(destination)) {
                throw new Error(`Skill directory ${directoryName} already exists in ${partition}`);
            }
            const localArchive = path.join(os.tmpdir(), `agentscope-skill-${_generateId()}.tar`);
            const remoteArchive = `/tmp/agentscope-skill-${_generateId()}.tar`;
            try {
                await tar.c({ cwd: path.dirname(source), file: localArchive }, [directoryName]);
                await backend.writeFile(remoteArchive, await fs.readFile(localArchive));
                const result = await backend.execShell([
                    this.pythonCommand,
                    '-c',
                    EXTRACT_TAR_SCRIPT,
                    remoteArchive,
                    partition,
                ]);
                if (!result.ok()) throw new Error(result.stderr.toString('utf8'));
            } finally {
                await fs.rm(localArchive, { force: true });
                await backend.deletePath(remoteArchive);
            }
        });
    }

    async addSkillArchive(
        stream: AsyncIterable<Uint8Array>,
        format: SkillArchiveFormat,
        directoryName: string,
        maxExtractedBytes = DEFAULT_MAX_EXTRACTED_BYTES,
        options: { agentId?: string } = {}
    ): Promise<void> {
        if (['.', '..'].includes(directoryName) || path.basename(directoryName) !== directoryName) {
            throw new Error(
                `Skill directory name ${JSON.stringify(directoryName)} must be a plain name.`
            );
        }
        const backend = this.getBackend();
        const partition = await this.equipPartition(options.agentId);
        await this.skillLock.run(async () => {
            const archive = `/tmp/agentscope-skill-${_generateId()}.${format}`;
            const staging = backend.joinPath(this.workdir, `.skill-staging-${_generateId()}`);
            await backend.writeStream(archive, stream);
            try {
                const script = genericArchiveScript(format, maxExtractedBytes);
                const result = await backend.execShell([
                    this.pythonCommand,
                    '-c',
                    script,
                    archive,
                    staging,
                ]);
                if (!result.ok()) throw new Error(result.stderr.toString('utf8'));
                const root = await findSkillRoot(backend, staging);
                let candidate = directoryName;
                let suffix = 1;
                while (await backend.fileExists(backend.joinPath(partition, candidate))) {
                    candidate = `${directoryName}-${suffix++}`;
                }
                const move = await backend.execShell([
                    this.pythonCommand,
                    '-c',
                    'import os,shutil,sys\nshutil.move(sys.argv[1],sys.argv[2])',
                    root,
                    backend.joinPath(partition, candidate),
                ]);
                if (!move.ok()) throw new Error(move.stderr.toString('utf8'));
            } finally {
                await backend.deletePath(staging);
                await backend.deletePath(archive);
            }
        });
    }

    async removeSkill(name: string, options: { agentId?: string } = {}): Promise<void> {
        const skill = (await this.listSkills(options)).find(item => item.name === name);
        if (!skill) throw new Error(`Skill ${JSON.stringify(name)} not found`);
        await this.getBackend().deletePath(skill.dir);
    }
}

export function cloneMcpClient(client: MCPClient): MCPClient {
    return mcpFromWire(mcpToWire(client));
}

function mcpToWire(client: MCPClient): MCPWire {
    const config = client.mcpConfig;
    return {
        name: client.name,
        is_stateful: client.isStateful,
        mcp_config:
            config.type === 'stdio_mcp'
                ? {
                      type: config.type,
                      command: config.command,
                      args: config.args ?? null,
                      env: config.env ?? null,
                      cwd: config.cwd ?? null,
                      encoding_error_handler: config.encodingErrorHandler,
                  }
                : {
                      type: config.type,
                      url: config.url,
                      headers: config.headers ?? null,
                      timeout: config.timeout,
                  },
        enable_tools: client.enableTools,
        disable_tools: client.disableTools,
        execution_timeout: client.executionTimeout,
    };
}

function mcpFromWire(value: MCPWire): MCPClient {
    const raw = value.mcp_config;
    if (raw.type !== 'stdio_mcp' && raw.type !== 'http_mcp') {
        throw new Error(`Unsupported MCP config type: ${String(raw.type)}`);
    }
    const config =
        raw.type === 'stdio_mcp'
            ? new StdioMCPConfig({
                  command: String(raw.command),
                  args: raw.args == null ? undefined : (raw.args as string[]),
                  env: raw.env == null ? undefined : (raw.env as Record<string, string>),
                  cwd: raw.cwd == null ? undefined : String(raw.cwd),
                  encodingErrorHandler: raw.encoding_error_handler as
                      | 'strict'
                      | 'ignore'
                      | 'replace'
                      | undefined,
              })
            : new HttpMCPConfig({
                  url: String(raw.url),
                  headers:
                      raw.headers == null ? undefined : (raw.headers as Record<string, string>),
                  timeout: raw.timeout as number | null | undefined,
              });
    const options: MCPClientOptions = {
        name: value.name,
        isStateful: value.is_stateful,
        mcpConfig: config,
        enableTools: value.enable_tools,
        disableTools: value.disable_tools,
        executionTimeout: value.execution_timeout,
    };
    return new MCPClient(options);
}

function genericArchiveScript(format: SkillArchiveFormat, limit: number): string {
    return [
        'import os,sys,tarfile,zipfile',
        'src,dst=sys.argv[1:3]',
        `fmt=${JSON.stringify(format)}`,
        `limit=${limit}`,
        'os.makedirs(dst,exist_ok=True)',
        'root=os.path.realpath(dst)',
        "ar=zipfile.ZipFile(src) if fmt=='zip' else tarfile.open(src)",
        "members=ar.infolist() if fmt=='zip' else ar.getmembers()",
        "names=[m.filename for m in members] if fmt=='zip' else [m.name for m in members]",
        "sizes=[m.file_size for m in members] if fmt=='zip' else [m.size for m in members]",
        "assert sum(sizes)<=limit,'archive size limit exceeded'",
        "assert all((lambda p:p==root or p.startswith(root+os.sep))(os.path.realpath(os.path.join(dst,n))) for n in names),'unsafe archive member'",
        'ar.extractall(dst,members)',
        'ar.close()',
        'os.unlink(src)',
    ].join('\n');
}
