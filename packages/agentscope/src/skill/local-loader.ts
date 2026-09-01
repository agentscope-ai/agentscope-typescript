import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';

import { _normalizeLocalPath } from '../_utils/path';
import { logger } from '../logger';
import { Skill, SkillLoaderBase } from './base';

export interface LocalSkillLoaderOptions {
    directory: string;
    scanSubdir?: boolean;
}

/** Load SKILL.md packages from a local directory tree. */
export class LocalSkillLoader extends SkillLoaderBase {
    readonly directory: string;
    readonly scanSubdir: boolean;
    private readonly cache = new Map<string, Skill>();

    /**
     * Create a local skill loader.
     * @param options Loader configuration.
     */
    constructor(options: LocalSkillLoaderOptions) {
        super();
        this.directory = _normalizeLocalPath(options.directory);
        this.scanSubdir = options.scanSubdir ?? false;
    }

    /**
     * Discover and load valid skills, reusing unchanged cached objects.
     * @returns Available skills.
     */
    async listSkills(): Promise<Skill[]> {
        try {
            if (!(await isDirectory(this.directory))) {
                logger.warning('Skill directory %s does not exist.', this.directory);
                return [];
            }
            const directories = await this.findSkillDirectories();
            const skills = await Promise.all(
                directories.map(directory => this.loadSkill(directory))
            );
            return skills.filter((skill): skill is Skill => skill !== null);
        } catch (error) {
            logger.warning('Failed to list skills from directory %s: %s', this.directory, error);
            return [];
        }
    }

    /**
     * Load and cache one skill root.
     * @param directory
     * @returns A loaded skill, or null when invalid.
     */
    private async loadSkill(directory: string): Promise<Skill | null> {
        const markdownPath = path.join(directory, 'SKILL.md');
        try {
            const fileStat = await stat(markdownPath);
            if (!fileStat.isFile()) return null;
            const updatedAt = fileStat.mtimeMs / 1000;
            const cached = this.cache.get(directory);
            if (cached?.updatedAt === updatedAt) return cached;

            const parsed = matter(await readFile(markdownPath, 'utf8'));
            if (!parsed.data.name || !parsed.data.description) {
                logger.warning(
                    'SKILL.md in %s is missing required fields (name or description). Skipping.',
                    directory
                );
                return null;
            }
            const skill = new Skill({
                name: String(parsed.data.name),
                description: String(parsed.data.description),
                dir: directory,
                markdown: parsed.content,
                updatedAt,
            });
            this.cache.set(directory, skill);
            return skill;
        } catch (error) {
            logger.warning('Failed to load skill from %s: %s', directory, error);
            return null;
        }
    }

    /**
     * Discover roots containing SKILL.md in stable traversal order.
     * @returns Skill root directories.
     */
    private async findSkillDirectories(): Promise<string[]> {
        const result: string[] = [];
        if (await isFile(path.join(this.directory, 'SKILL.md'))) result.push(this.directory);
        if (!this.scanSubdir) return result;

        const visit = async (directory: string): Promise<void> => {
            const entries = await readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const child = path.join(directory, entry.name);
                if (await isFile(path.join(child, 'SKILL.md'))) result.push(child);
                await visit(child);
            }
        };
        await visit(this.directory);
        return result;
    }
}

/**
 * Return whether a path is a directory without leaking stat errors.
 * @param value
 * @returns Whether the path is a directory.
 */
async function isDirectory(value: string): Promise<boolean> {
    try {
        return (await stat(value)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Return whether a path is a file without leaking stat errors.
 * @param value
 * @returns Whether the path is a file.
 */
async function isFile(value: string): Promise<boolean> {
    try {
        return (await stat(value)).isFile();
    } catch {
        return false;
    }
}
