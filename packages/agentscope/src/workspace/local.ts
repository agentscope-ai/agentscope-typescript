/* eslint-disable jsdoc/require-jsdoc */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import matter from 'gray-matter';

import { _generateId } from '../_utils';
import { logger } from '../logger';
import { MCPClient } from '../mcp';
import { Skill } from '../skill';
import type { ToolBase } from '../tool';
import { Bash, Edit, Glob, Grep, LocalBackend, PowerShell, Read, Write } from '../tool';
import { extractLocalArchive, findSkillRoot, type SkillArchiveFormat } from './archive';
import { WorkspaceBase, type WorkspaceBaseOptions } from './base';
import {
    DEFAULT_MAX_EXTRACTED_BYTES,
    DEFAULT_WORKSPACE_INSTRUCTIONS,
    SKILL_SEED_DIR,
    formatWorkspaceInstructions,
} from './utils';

interface SkillIndexEntry {
    hash: string;
    skill_name: string;
}

interface SkillIndex {
    skills_dir_mtime: number;
    skills: Record<string, SkillIndexEntry>;
}

interface ValidSkill {
    rawName: string;
    description: string;
    markdown: string;
    hash: string;
}

export interface LocalWorkspaceOptions extends WorkspaceBaseOptions {
    workdir: string;
    instructions?: string;
}

/** Workspace backed by a local directory and the host process environment. */
export class LocalWorkspace extends WorkspaceBase {
    readonly workdir: string;
    readonly instructions: string;

    constructor(options: LocalWorkspaceOptions) {
        super(options);
        this.workdir = path.resolve(expandHome(options.workdir));
        this.instructions = formatWorkspaceInstructions(
            options.instructions ?? DEFAULT_WORKSPACE_INSTRUCTIONS,
            { backend: 'local', workdir: this.workdir }
        );
        this.backend = new LocalBackend();
    }

    protected override get pythonCommand(): string {
        return process.execPath;
    }

    async listTools(): Promise<ToolBase[]> {
        const backend = this.getBackend();
        const shell =
            process.platform === 'win32'
                ? PowerShell({ cwd: this.workdir, backend })
                : Bash({ cwd: this.workdir, backend });
        return [
            shell,
            Edit({ backend }),
            Glob({ backend }),
            Grep({ backend }),
            Read({ backend }),
            Write({ backend }),
        ];
    }

    async initialize(): Promise<void> {
        if (this.isAlive) return;
        await fs.mkdir(this.workdir, { recursive: true });
        await this.restoreMcpSpecs();
        await fs.mkdir(this.skillsDir, { recursive: true });
        await this.migrateSkillLayout();
        await fs.mkdir(this.skillSeedDir, { recursive: true });

        const index = await this.loadSkillIndex(this.skillSeedDir);
        for (const skillPath of this.skillPaths) {
            const skill = await this.validateSkill(skillPath);
            if (!skill) continue;
            await this.installValidatedSkill(skillPath, skill, this.skillSeedDir, index, false);
        }
        await this.refreshAndSaveIndex(this.skillSeedDir, index);
        this.isAlive = true;
    }

    async close(): Promise<void> {
        await this.mcpLock.run(() => this.closeAllMcpInstances());
        this.isAlive = false;
    }

    async getInstructions(): Promise<string> {
        return this.instructions;
    }

    async reset(): Promise<void> {
        await this.mcpLock.run(async () => {
            await this.closeAllMcpInstances();
            this.mcpSpecs.clear();
            await this.getBackend().deletePath(this.mcpFile);
        });
        await this.skillLock.run(async () => {
            this.equippedPartitions.clear();
            await this.getBackend().deletePath(this.skillsDir);
        });
        await this.getBackend().deletePath(this.sessionsDir);
        await this.getBackend().deletePath(this.dataDir);
    }

    async addMcp(
        client: MCPClient,
        options: { agentId?: string; sessionId?: string } = {}
    ): Promise<void> {
        const agentId = options.agentId ?? '';
        const sessionId = options.sessionId ?? '';
        await this.mcpLock.run(async () => {
            const specs = this.declaredSpecs(agentId, sessionId);
            if (specs.some(item => item.name === client.name)) {
                throw new Error(
                    `MCP ${JSON.stringify(client.name)} already exists for ` +
                        `agent=${JSON.stringify(agentId)} session=${JSON.stringify(sessionId)}.`
                );
            }
            await this.enforceMcpCapacity(agentId, sessionId, client);
            if (client.isStateful && !client.isConnected) await client.connect();
            const key = this.scopeKey(agentId, sessionId);
            const live = this.mcpInstances.get(key) ?? new Map<string, MCPClient>();
            live.set(client.name, client);
            this.mcpInstances.set(key, live);
            this.mcpSpecs.set(key, [...specs, client]);
            await this.saveMcpFile();
        });
    }

    async removeMcp(
        name: string,
        options: { agentId?: string; sessionId?: string } = {}
    ): Promise<void> {
        const agentId = options.agentId ?? '';
        const sessionId = options.sessionId ?? '';
        await this.mcpLock.run(async () => {
            const specs = this.declaredSpecs(agentId, sessionId);
            if (!specs.some(item => item.name === name)) {
                logger.warning('MCP client %s not found', name);
                return;
            }
            const key = this.scopeKey(agentId, sessionId);
            const live = this.mcpInstances.get(key)?.get(name);
            if (live) {
                this.mcpInstances.get(key)?.delete(name);
                await this.closeMcpInstance(live);
            }
            this.mcpSpecs.set(
                key,
                specs.filter(item => item.name !== name)
            );
            await this.saveMcpFile();
        });
    }

    protected override async equipPartition(agentId?: string): Promise<string> {
        const partition = this.skillPartition(agentId);
        if (this.equippedPartitions.has(partition)) return partition;
        if (!(await this.getBackend().isDirectory(partition))) {
            const staging = `${partition}.equipping-${_generateId()}`;
            try {
                if (await this.getBackend().isDirectory(this.skillSeedDir)) {
                    await fs.cp(this.skillSeedDir, staging, {
                        recursive: true,
                        errorOnExist: true,
                    });
                } else {
                    await fs.mkdir(staging, { recursive: true });
                }
                await fs.rename(staging, partition).catch(async error => {
                    if (!(await this.getBackend().isDirectory(partition))) throw error;
                });
            } finally {
                await fs.rm(staging, { recursive: true, force: true });
            }
        }
        this.equippedPartitions.add(partition);
        return partition;
    }

    async listSkills(options: { agentId?: string } = {}): Promise<Skill[]> {
        const partition = await this.equipPartition(options.agentId);
        return this.skillLock.run(async () => {
            let index = await this.loadSkillIndex(partition);
            const mtime = (await this.getBackend().statMtime(partition)) ?? 0;
            if (mtime !== index.skills_dir_mtime) {
                index = await this.reconcileSkillIndex(partition, index, mtime);
            }
            const results = await Promise.all(
                Object.entries(index.skills).map(([directoryName, entry]) =>
                    this.loadSkill(path.join(partition, directoryName), entry.skill_name)
                )
            );
            return results.filter((skill): skill is Skill => skill !== null);
        });
    }

    override async addSkill(skillPath: string, options: { agentId?: string } = {}): Promise<void> {
        const source = path.resolve(expandHome(skillPath));
        const partition = await this.equipPartition(options.agentId);
        await this.skillLock.run(async () => {
            const skill = await this.validateSkill(source);
            if (!skill) {
                throw new Error(
                    `Invalid skill at ${JSON.stringify(source)}: missing or malformed SKILL.md`
                );
            }
            const index = await this.loadSkillIndex(partition);
            const installed = await this.installValidatedSkill(
                source,
                skill,
                partition,
                index,
                true
            );
            if (installed) await this.refreshAndSaveIndex(partition, index);
        });
    }

    override async addSkillArchive(
        stream: AsyncIterable<Uint8Array>,
        format: SkillArchiveFormat,
        _directoryName: string,
        maxExtractedBytes = DEFAULT_MAX_EXTRACTED_BYTES,
        options: { agentId?: string } = {}
    ): Promise<void> {
        const staging = path.join(this.workdir, `.skill-staging-${_generateId()}`);
        const archivePath = `${staging}.${format}`;
        try {
            await this.getBackend().writeStream(archivePath, stream);
            await extractLocalArchive({
                archivePath,
                destination: staging,
                format,
                maxExtractedBytes,
            });
            await this.addSkill(await findSkillRoot(this.getBackend(), staging), options);
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
            await fs.rm(archivePath, { force: true });
        }
    }

    override async removeSkill(name: string, options: { agentId?: string } = {}): Promise<void> {
        const partition = await this.equipPartition(options.agentId);
        await this.skillLock.run(async () => {
            const index = await this.loadSkillIndex(partition);
            const target = Object.entries(index.skills).find(
                ([, entry]) => entry.skill_name === name
            );
            if (!target) {
                logger.warning('Skill %s not found in workspace', name);
                return;
            }
            await fs.rm(path.join(partition, target[0]), { recursive: true, force: true });
            delete index.skills[target[0]];
            await this.refreshAndSaveIndex(partition, index);
        });
    }

    private async loadSkillIndex(directory: string): Promise<SkillIndex> {
        try {
            const raw = await fs.readFile(path.join(directory, '.index'), 'utf8');
            const value = JSON.parse(raw) as Partial<SkillIndex>;
            return {
                skills_dir_mtime: Number(value.skills_dir_mtime ?? 0),
                skills: value.skills ?? {},
            };
        } catch {
            return { skills_dir_mtime: 0, skills: {} };
        }
    }

    private async refreshAndSaveIndex(directory: string, index: SkillIndex): Promise<void> {
        index.skills_dir_mtime = (await this.getBackend().statMtime(directory)) ?? 0;
        await fs.writeFile(path.join(directory, '.index'), JSON.stringify(index, null, 2));
    }

    private async validateSkill(skillPath: string): Promise<ValidSkill | null> {
        try {
            const markdown = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8');
            const document = matter(markdown);
            if (!document.data.name || !document.data.description) return null;
            return {
                rawName: String(document.data.name),
                description: String(document.data.description),
                markdown: document.content,
                hash: createHash('sha256').update(markdown).digest('hex'),
            };
        } catch {
            return null;
        }
    }

    private async installValidatedSkill(
        source: string,
        skill: ValidSkill,
        partition: string,
        index: SkillIndex,
        throwOnFailure: boolean
    ): Promise<boolean> {
        if (Object.values(index.skills).some(entry => entry.hash === skill.hash)) return false;
        const names = new Set(Object.values(index.skills).map(entry => entry.skill_name));
        let exposedName = skill.rawName;
        for (let suffix = 1; names.has(exposedName); suffix += 1) {
            exposedName = `${skill.rawName} (${suffix})`;
        }
        const directories = new Set(Object.keys(index.skills));
        const baseName = sanitizeDirectoryName(skill.rawName);
        let directoryName = baseName;
        for (let suffix = 1; directories.has(directoryName); suffix += 1) {
            directoryName = `${baseName}_${suffix}`;
        }
        const destination = path.join(partition, directoryName);
        const relative = path.relative(partition, destination);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            if (throwOnFailure) throw new Error(`Skill path resolves outside ${partition}`);
            return false;
        }
        try {
            await fs.cp(source, destination, { recursive: true, errorOnExist: true });
        } catch (error) {
            if (throwOnFailure) throw error;
            logger.warning('Failed to copy skill %s: %s', skill.rawName, String(error));
            return false;
        }
        index.skills[directoryName] = { hash: skill.hash, skill_name: exposedName };
        return true;
    }

    private async reconcileSkillIndex(
        directory: string,
        index: SkillIndex,
        mtime: number
    ): Promise<SkillIndex> {
        const actualDirectories = new Set<string>();
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) actualDirectories.add(entry.name);
        }
        for (const indexed of Object.keys(index.skills)) {
            if (!actualDirectories.has(indexed)) delete index.skills[indexed];
        }
        const names = new Set(Object.values(index.skills).map(entry => entry.skill_name));
        const hashes = new Set(Object.values(index.skills).map(entry => entry.hash));
        for (const candidate of actualDirectories) {
            if (index.skills[candidate]) continue;
            const skill = await this.validateSkill(path.join(directory, candidate));
            if (!skill || hashes.has(skill.hash)) continue;
            let exposedName = skill.rawName;
            for (let suffix = 1; names.has(exposedName); suffix += 1) {
                exposedName = `${skill.rawName} (${suffix})`;
            }
            index.skills[candidate] = { hash: skill.hash, skill_name: exposedName };
            names.add(exposedName);
            hashes.add(skill.hash);
        }
        index.skills_dir_mtime = mtime;
        await fs.writeFile(path.join(directory, '.index'), JSON.stringify(index, null, 2));
        return index;
    }

    private async loadSkill(directory: string, name: string): Promise<Skill | null> {
        try {
            const filePath = path.join(directory, 'SKILL.md');
            const markdown = await fs.readFile(filePath, 'utf8');
            const document = matter(markdown);
            if (!document.data.description) return null;
            return new Skill({
                name,
                description: String(document.data.description),
                dir: directory,
                markdown: document.content,
                updatedAt: ((await fs.stat(filePath)).mtimeMs ?? 0) / 1000,
            });
        } catch {
            return null;
        }
    }

    private async migrateSkillLayout(): Promise<void> {
        const seed = path.join(this.skillsDir, SKILL_SEED_DIR);
        await fs.mkdir(seed, { recursive: true });
        for (const entry of await fs.readdir(this.skillsDir, { withFileTypes: true })) {
            if (entry.name === SKILL_SEED_DIR) continue;
            const source = path.join(this.skillsDir, entry.name);
            if (entry.isFile() && entry.name === '.skills') {
                await fs.rename(source, path.join(seed, '.index'));
            } else if (
                entry.isDirectory() &&
                (await this.getBackend().fileExists(path.join(source, 'SKILL.md')))
            ) {
                await fs.rename(source, path.join(seed, entry.name));
            }
        }
    }
}

function sanitizeDirectoryName(name: string): string {
    return name.replace(/[^\w\u4e00-\u9fff-]/g, '_');
}

function expandHome(value: string): string {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}
