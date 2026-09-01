/* eslint-disable jsdoc/require-jsdoc */
import { TextBlock, ToolCallBlock } from '../message';
import { PermissionBehavior, createPermissionDecision } from '../permission';
import { Skill, SkillLoaderBase } from '../skill';
import { AgentState } from '../state';
import { ToolBase } from './base';
import { ToolChunk, ToolResponse } from './response';
import { ToolGroup } from './tool-group';
import { Toolkit } from './toolkit';

class EchoTool extends ToolBase {
    readonly name: string;
    readonly description = 'Echo a value.';
    readonly inputSchema = {
        type: 'object' as const,
        properties: { value: { type: 'string' } },
        required: ['value'],
    };
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;
    override isStateInjected: boolean;

    constructor(name = 'echo', stateInjected = false) {
        super();
        this.name = name;
        this.isStateInjected = stateInjected;
    }

    checkPermissions() {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'allowed',
        });
    }

    async call(input: Record<string, unknown>) {
        return new ToolChunk({
            content: [
                TextBlock({
                    text: `${String(input.value)}:${String(Boolean(input._agent_state))}`,
                }),
            ],
        });
    }
}

class MemorySkillLoader extends SkillLoaderBase {
    async listSkills(): Promise<Skill[]> {
        return [
            new Skill({
                name: 'repair_skill',
                description: 'Repair things',
                dir: '/skills/repair',
                markdown: '# Repair',
                updatedAt: 0,
            }),
        ];
    }
}

function toolCall(name: string, input: Record<string, unknown> = {}): ToolCallBlock {
    return ToolCallBlock({ id: `call-${name}`, name, input: JSON.stringify(input) });
}

async function collect(
    generator: AsyncGenerator<ToolChunk | ToolResponse, void>
): Promise<Array<ToolChunk | ToolResponse>> {
    const results: Array<ToolChunk | ToolResponse> = [];
    for await (const result of generator) results.push(result);
    return results;
}

describe('Toolkit Python parity API', () => {
    test('filters schemas by active groups and includes meta/skill tools', async () => {
        const toolkit = new Toolkit({
            tools: [new EchoTool('basic_echo')],
            skillsOrLoaders: [new MemorySkillLoader()],
            toolGroups: [
                new ToolGroup({
                    name: 'repair',
                    description: 'Repair tools',
                    tools: [new EchoTool('repair_echo')],
                }),
            ],
        });
        expect((await toolkit.getToolSchemas()).map(item => item.function.name)).toEqual([
            'Skill',
            'reset_tools',
            'basic_echo',
        ]);
        expect(
            (await toolkit.getToolSchemas({ groups: ['repair'] })).map(item => item.function.name)
        ).toEqual(['Skill', 'reset_tools', 'basic_echo', 'repair_echo']);
    });

    test('yields a chunk and final accumulated response with state injection', async () => {
        const toolkit = new Toolkit({ tools: [new EchoTool('echo', true)] });
        const call = toolCall('echo', { value: 'hello' });
        const results = await collect(toolkit.callTool(call, new AgentState()));
        expect(results).toHaveLength(2);
        expect(results[0]).toBeInstanceOf(ToolChunk);
        expect(results[0].content[0]).toMatchObject({ text: 'hello:true' });
        expect(results[1]).toBeInstanceOf(ToolResponse);
        expect(results[1].toJSON()).toMatchObject({ id: call.id, state: 'success' });
    });

    test('distinguishes inactive and missing tools', async () => {
        const toolkit = new Toolkit({
            toolGroups: [
                new ToolGroup({
                    name: 'repair',
                    description: 'Repair tools',
                    tools: [new EchoTool('repair_echo')],
                }),
            ],
        });
        const inactive = await collect(toolkit.callTool(toolCall('repair_echo'), new AgentState()));
        expect(inactive[0].content[0]).toMatchObject({
            text: expect.stringContaining('ToolGroupInactiveError'),
        });
        const missing = await collect(toolkit.callTool(toolCall('missing'), new AgentState()));
        expect(missing[0].content[0]).toMatchObject({
            text: expect.stringContaining('ToolNotFoundError'),
        });
    });

    test('renders active skill instructions and calls SkillViewer', async () => {
        const toolkit = new Toolkit({ skillsOrLoaders: [new MemorySkillLoader()] });
        expect(await toolkit.getSkillInstructions()).toContain('<name>repair_skill</name>');
        const results = await collect(
            toolkit.callTool(toolCall('Skill', { skill: 'repair_skill' }), new AgentState())
        );
        expect(results[0].content[0]).toMatchObject({ text: '# Repair' });
    });

    test('adds, replaces, removes, resolves, and clears tools', async () => {
        const toolkit = new Toolkit({ tools: [new EchoTool('echo')] });
        expect(await toolkit.getTool('echo')).toBeInstanceOf(EchoTool);
        const replacement = new EchoTool('echo');
        await toolkit.addTool(replacement);
        expect(await toolkit.getTool('echo')).toBe(replacement);
        await toolkit.removeTool('echo');
        expect(await toolkit.getTool('echo')).toBeNull();
        await expect(toolkit.addTool(new EchoTool(), 'missing')).rejects.toThrow(
            "Cannot find group 'missing'"
        );
        toolkit.clear();
        expect(toolkit.toolGroups).toEqual([]);
    });
});
