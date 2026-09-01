import { Skill, SkillLoaderBase } from '../skill';
import { ToolGroup } from './tool-group';

/** In-memory loader used to verify group aggregation. */
class MemorySkillLoader extends SkillLoaderBase {
    /**
     * List one test skill.
     * @returns One test skill.
     */
    async listSkills(): Promise<Skill[]> {
        return [
            new Skill({
                name: 'loaded',
                description: 'Loaded skill',
                dir: '/tmp',
                markdown: '# Loaded',
                updatedAt: 0,
            }),
        ];
    }
}

describe('ToolGroup', () => {
    test('requires descriptions except for the basic group', () => {
        expect(new ToolGroup({ name: 'basic' })).toMatchObject({
            name: 'basic',
            description: '',
            instructions: null,
            tools: [],
            skillsOrLoaders: [],
            mcps: [],
        });
        expect(() => new ToolGroup({ name: 'repair' })).toThrow(
            "The tool group description is required for tool group 'repair'"
        );
    });

    test('aggregates direct and loader-provided skills', async () => {
        const direct = new Skill({
            name: 'direct',
            description: 'Direct skill',
            dir: '/tmp',
            markdown: '# Direct',
            updatedAt: 0,
        });
        const group = new ToolGroup({
            name: 'repair',
            description: 'Repair tools',
            skillsOrLoaders: [direct, new MemorySkillLoader()],
        });
        expect((await group.listSkills()).map(skill => skill.name)).toEqual(['direct', 'loaded']);
    });
});
