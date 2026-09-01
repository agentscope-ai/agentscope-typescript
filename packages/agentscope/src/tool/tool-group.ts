import { LocalSkillLoader, Skill, SkillLoaderBase } from '../skill';
import type { ToolBase } from './base';

export type SkillSource = string | Skill | SkillLoaderBase;

/** Minimum MCP identity required while groups remain transport-agnostic. */
export interface ToolGroupMCPClient {
    name: string;
    listTools?: () => Promise<ToolBase[]>;
    isStateful?: boolean;
    isConnected?: boolean;
}

export interface ToolGroupOptions {
    name: string;
    description?: string | null;
    instructions?: string | null;
    tools?: ToolBase[];
    skillsOrLoaders?: SkillSource[];
    mcps?: ToolGroupMCPClient[];
}

/** Activatable group of related tools, skills, and MCP clients. */
export class ToolGroup {
    name: string;
    description: string;
    instructions: string | null;
    tools: ToolBase[];
    skillsOrLoaders: Array<Skill | SkillLoaderBase>;
    mcps: ToolGroupMCPClient[];

    /**
     * Create a tool group.
     * @param options Group fields.
     */
    constructor(options: ToolGroupOptions) {
        if (options.name !== 'basic' && options.description == null) {
            throw new Error(
                `The tool group description is required for tool group '${options.name}' ` +
                    "(Only the 'basic' tool group can have an optional description)."
            );
        }
        this.name = options.name;
        this.description = options.description ?? '';
        this.instructions = options.instructions ?? null;
        this.tools = options.tools ?? [];
        this.mcps = options.mcps ?? [];
        this.skillsOrLoaders = (options.skillsOrLoaders ?? []).map(source => {
            if (typeof source === 'string') {
                return new LocalSkillLoader({ directory: source });
            }
            if (source instanceof Skill || source instanceof SkillLoaderBase) return source;
            throw new TypeError(
                `Invalid skill or loader: ${String(source)}. Must be a skill, ` +
                    'skill loader, or directory path.'
            );
        });
    }

    /**
     * Resolve every direct and lazily loaded skill.
     * @returns Skills in source order.
     */
    async listSkills(): Promise<Skill[]> {
        const result: Skill[] = [];
        for (const source of this.skillsOrLoaders) {
            if (source instanceof Skill) result.push(source);
            else result.push(...(await source.listSkills()));
        }
        return result;
    }
}
