import { TextBlock } from '../message';
import type { PermissionContext, PermissionDecision } from '../permission';
import { PermissionBehavior, createPermissionDecision } from '../permission/runtime';
import type { Skill } from '../skill';
import type { AgentState } from '../state';
import { ToolBase } from './base';
import { ToolChunk } from './response';
import type { ToolGroup } from './tool-group';

export const DEFAULT_META_TOOL_RESPONSE_TEMPLATE = 'default';

/** Built-in tool used by an agent to reset active tool groups. */
export class ResetTools extends ToolBase {
    readonly name = 'reset_tools';
    readonly description =
        'This tool allows you to reset your equipped tools based on your current task requirements.';
    readonly isConcurrencySafe = true;
    readonly isReadOnly = false;
    override isStateInjected = true;
    private readonly groups: ToolGroup[];
    private readonly responseTemplate: string;

    /**
     * Create the group-management tool.
     * @param options Meta-tool dependencies.
     * @param options.groups
     * @param options.responseTemplate
     */
    constructor(options: { groups: ToolGroup[]; responseTemplate?: string }) {
        super();
        this.groups = options.groups;
        this.responseTemplate = options.responseTemplate ?? DEFAULT_META_TOOL_RESPONSE_TEMPLATE;
    }

    /** Dynamic schema derived from every non-basic group. */
    get inputSchema() {
        return {
            type: 'object' as const,
            properties: Object.fromEntries(
                this.groups
                    .filter(group => group.name !== 'basic')
                    .map(group => [
                        group.name,
                        { type: 'boolean', default: false, description: group.description },
                    ])
            ),
        };
    }

    /**
     * @param _toolInput
     * @param _context
     * @returns The always-allow meta-tool decision.
     */
    checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): PermissionDecision {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'The meta tool is always allowed to be called.',
        });
    }

    /**
     * Replace active groups after validating all arguments.
     * @param input Group booleans plus injected state.
     * @returns Activation result and group instructions.
     */
    override async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const state = input._agent_state as AgentState | undefined;
        if (!state) throw new Error('Error: ResetTools requires state to be provided.');
        const values = Object.entries(input).filter(([name]) => name !== '_agent_state');
        const available = this.groups
            .filter(group => group.name !== 'basic')
            .map(group => group.name);
        const unknown = values.map(([name]) => name).filter(name => !available.includes(name));
        if (unknown.length > 0) {
            return chunk(
                `Invalid group name(s): ${unknown.join(', ')}. ` +
                    `The current available groups are: ${available.join(', ')}`,
                'error'
            );
        }
        for (const [name, value] of values) {
            if (typeof value !== 'boolean') {
                return chunk(
                    `Invalid arguments: the argument '${name}' should be a bool value, ` +
                        `but got ${typeof value}.`,
                    'error'
                );
            }
        }
        const active = values.filter(([, value]) => value).map(([name]) => name);
        state.toolContext.activatedGroups.splice(
            0,
            state.toolContext.activatedGroups.length,
            ...active
        );
        const groups = this.groups.filter(group => active.includes(group.name));
        return chunk(renderMetaResponse(groups, this.responseTemplate), 'success');
    }
}

/** Built-in read-only tool that returns full skill markdown. */
export class SkillViewer extends ToolBase {
    readonly name = 'Skill';
    readonly description =
        'Retrieve a skill within the conversation. When users asks you to perform tasks, ' +
        'check if any of the available skills match. Skills provide specialized capabilities ' +
        'and domain knowledge.';
    readonly inputSchema = {
        type: 'object' as const,
        properties: {
            skill: {
                type: 'string',
                description: 'The exact name of the skill to view. ',
            },
        },
        required: ['skill'],
    };
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;
    override isStateInjected = true;
    private readonly getSkills: (groups?: string[]) => Promise<Map<string, Skill>>;

    /**
     * Create the skill viewer.
     * @param getSkills Current-skill resolver.
     */
    constructor(getSkills: (groups?: string[]) => Promise<Map<string, Skill>>) {
        super();
        this.getSkills = getSkills;
    }

    /**
     * @param _toolInput
     * @param _context
     * @returns The always-allow skill-viewer decision.
     */
    checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): PermissionDecision {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'The skill viewer is always allowed to be called.',
        });
    }

    /**
     * Return one active skill's markdown.
     * @param input Skill name and injected state.
     * @returns Skill content or a not-found error chunk.
     */
    override async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const state = input._agent_state as AgentState | undefined;
        if (!state) throw new Error('Expected AgentState for the Skill viewer tool.');
        const skill = (await this.getSkills(state.toolContext.activatedGroups)).get(
            String(input.skill)
        );
        if (!skill) {
            return chunk(`SkillNotFoundError: Skill '${String(input.skill)}' not found.`, 'error');
        }
        return chunk(skill.markdown, 'running');
    }
}

/**
 * Create a one-text-block tool chunk.
 * @param text
 * @param state
 */
function chunk(text: string, state: 'running' | 'success' | 'error'): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text })], state });
}

/**
 * Render the default activation summary without introducing a template runtime.
 * @param groups
 * @param template
 */
function renderMetaResponse(groups: ToolGroup[], template: string): string {
    if (template !== DEFAULT_META_TOOL_RESPONSE_TEMPLATE) {
        return template.replace('{{ groups }}', groups.map(group => group.name).join(', '));
    }
    if (groups.length === 0) return 'All tool groups are currently deactivated.';
    let result = `The currently activated tool group(s): ${groups.map(group => group.name).join(', ')}.`;
    const instructions = groups.filter(group => group.instructions);
    if (instructions.length > 0) {
        result +=
            '\n<tool-instructions>\n' +
            'The tool instructions are a collection of suggestions, rules and notifications ' +
            'about how to use the tools in the activated groups.\n' +
            instructions
                .map(group => `<group name="${group.name}">${group.instructions}</group>`)
                .join('') +
            '\n</tool-instructions>';
    }
    return result;
}
