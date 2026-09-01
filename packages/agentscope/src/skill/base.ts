/** One discovered AgentScope skill. */
export class Skill {
    name: string;
    description: string;
    dir: string;
    markdown: string;
    updatedAt: number;

    /**
     * Create skill metadata and content.
     * @param options Skill fields.
     * @param options.name
     * @param options.description
     * @param options.dir
     * @param options.markdown
     * @param options.updatedAt
     */
    constructor(options: {
        name: string;
        description: string;
        dir: string;
        markdown: string;
        updatedAt: number;
    }) {
        this.name = options.name;
        this.description = options.description;
        this.dir = options.dir;
        this.markdown = options.markdown;
        this.updatedAt = options.updatedAt;
    }

    /**
     * Serialize skill metadata using the Python field name.
     * @returns Python-compatible skill data.
     */
    toJSON() {
        return {
            name: this.name,
            description: this.description,
            dir: this.dir,
            markdown: this.markdown,
            updated_at: this.updatedAt,
        };
    }
}

/** Source of lazily discovered skills. */
export abstract class SkillLoaderBase {
    /**
     * List all currently available skills.
     * @returns Discovered skills.
     */
    abstract listSkills(): Promise<Skill[]>;
}
