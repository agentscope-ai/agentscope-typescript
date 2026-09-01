/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'fs';
import * as path from 'path';

import { Validator } from '@cfworker/json-schema';
import matter from 'gray-matter';
import { z } from 'zod';

import {
    _describeException,
    _generateId,
    _generateTimestamp,
    _jsonLoadsWithRepair,
} from '../_utils';
import {
    DeveloperOrientedException,
    ToolGroupInactiveError,
    ToolNotFoundError,
} from '../exception';
import { logger } from '../logger';
import { MCPClient } from '../mcp/client';
import { HTTPMCPClient } from '../mcp/http';
import { StdioMCPClient } from '../mcp/stdio';
import type { ToolCallBlock } from '../message/block';
import { TextBlock } from '../message/block';
import { LocalSkillLoader, Skill, SkillLoaderBase } from '../skill';
import type { AgentState } from '../state';
import type { ToolInputSchema, ToolSchema } from '../type';
import { ToolBase } from './base';
import type { Tool } from './base';
import { DEFAULT_META_TOOL_RESPONSE_TEMPLATE, ResetTools, SkillViewer } from './meta';
import { createToolResponse, isToolResponse, ToolChunk, ToolResponse } from './response';
import { ToolGroup, ToolGroupMCPClient } from './tool-group';
import { RegisteredTool } from './types';

interface LegacyRegisteredTool extends Tool {
    type: 'function' | 'mcp';
    mcpName?: string;
}

export const DEFAULT_SKILL_INSTRUCTION = `<agent-skills>
Skills are a collection of instructions, scripts, and resources to extend your capabilities.

**IMPORTANT**: Skills are NOT tools, and you cannot call a skill directly. To use a skill, you MUST use the \`Skill\` tool to read the skill's full instructions, and then follow those instructions to use the tools and resources provided by the skill.

# Available Skills:`;

/**
 * The toolkit module in AgentScope, which is responsible for registering tool functions, MCP, and agent skills.
 * It also provides group-wise management of tools.
 */
export class Toolkit {
    tools: LegacyRegisteredTool[];
    skills: string[];
    skillDirs: string[];
    toolGroups: ToolGroup[];
    builtinMetaTool: RegisteredTool;
    builtinSkillViewer: RegisteredTool;
    readonly metaToolResponseTemplate: string;
    readonly skillInstructionTemplate: string;

    // The cache mapping from the skill name to its corresponding tool name in the toolkit.
    private _skillCache: { [name: string]: string };

    /**
     * Initializes a new instance of the Toolkit class.
     * @param config - The configuration object for initializing the toolkit, which can include an array of tools, an array of skill paths, an array of skill directory paths, and a boolean indicating whether to include the built-in skill tool for reading SKILL.md files.
     * @param config.tools - An array of tool definitions to register in the toolkit.
     * @param config.skills - An array of file paths pointing to individual skills.
     * @param config.skillDirs - An array of directory paths, where each directory can contain multiple skills in its subdirectories.
     * @param config.builtInSkillTool - A boolean flag indicating whether to include the built-in skill tool for reading SKILL.md files.
     * @param config.skillsOrLoaders
     * @param config.mcps
     * @param config.toolGroups
     * @param config.metaToolResponseTemplate
     * @param config.skillInstructionTemplate
     */
    constructor(config?: {
        tools?: Array<Tool | ToolBase>;
        skills?: string[];
        skillDirs?: string[];
        builtInSkillTool?: boolean;
        skillsOrLoaders?: Array<string | Skill | SkillLoaderBase>;
        mcps?: ToolGroupMCPClient[];
        toolGroups?: ToolGroup[];
        metaToolResponseTemplate?: string;
        skillInstructionTemplate?: string;
    }) {
        const {
            tools = [],
            skills = [],
            skillDirs = [],
            builtInSkillTool = true,
            skillsOrLoaders = [],
            mcps = [],
            toolGroups = [],
            metaToolResponseTemplate = DEFAULT_META_TOOL_RESPONSE_TEMPLATE,
            skillInstructionTemplate = DEFAULT_SKILL_INSTRUCTION,
        } = config || {};

        this.tools = [];

        if (builtInSkillTool) {
            this.tools.push({
                type: 'function',
                name: 'Skill',
                description: `Retrieves the full content of a skill by reading its SKILL.md file. Skills are packages of domain expertise that extend agent capabilities. Use this tool to access detailed instructions, examples, and guidelines for a specific skill.

Usage:
- Provide the skill name as the input parameter
- The tool will return the complete SKILL.md file content for that skill
- If the skill is not found, an error message with available skills will be returned
- Available skills are listed in the skills-system section of the agent prompt`,
                inputSchema: z.object({ name: z.string().describe('The name of the skill') }),
                call: this._skillTool.bind(this),
                requireUserConfirm: false,
            });
        }

        tools
            .filter((tool): tool is Tool => !(tool instanceof ToolBase))
            .map(tool => {
                this.tools.push({
                    type: 'function',
                    ...tool,
                });
            });
        tools
            .filter((tool): tool is ToolBase => tool instanceof ToolBase)
            .forEach(tool => this.tools.push(adaptToolBaseToLegacy(tool)));

        this.skills = skills;
        this.skillDirs = skillDirs;

        this._skillCache = {};

        if (toolGroups.some(group => group.name === 'basic')) {
            throw new Error(
                "The 'basic' tool group is reserved for the default tool group. " +
                    "Don't include 'basic' in the toolGroups argument."
            );
        }
        this.toolGroups = [
            new ToolGroup({
                name: 'basic',
                tools: tools.filter((tool): tool is ToolBase => tool instanceof ToolBase),
                skillsOrLoaders: [
                    ...skillsOrLoaders,
                    ...skills.map(directory => new LocalSkillLoader({ directory })),
                    ...skillDirs.map(
                        directory => new LocalSkillLoader({ directory, scanSubdir: true })
                    ),
                ],
                mcps,
            }),
            ...toolGroups,
        ];
        if (new Set(this.toolGroups.map(group => group.name)).size !== this.toolGroups.length) {
            throw new Error('Tool groups must not contain duplicate tool groups.');
        }
        this.metaToolResponseTemplate = metaToolResponseTemplate;
        this.skillInstructionTemplate = skillInstructionTemplate;
        this.builtinMetaTool = new RegisteredTool({
            tool: new ResetTools({
                groups: this.toolGroups,
                responseTemplate: metaToolResponseTemplate,
            }),
        });
        this.builtinSkillViewer = new RegisteredTool({
            tool: new SkillViewer(groups => this.getAvailableSkills(groups)),
        });
    }

    /**
     * Registers a tool function to the toolkit. The function can be either a plain function that adheres to the ToolFunction type, or an instance of a class that extends ToolBase. When registering a plain function, the name, description, and input schema must be provided explicitly. When registering a ToolBase instance, these properties will be extracted from the instance itself.
     *
     * @params tool - The tool function to register, which can be either a plain function with explicit properties or an instance of a class that extends ToolBase.
     * @returns The Toolkit instance with the new tool function registered
     * @param tool
     */
    registerToolFunction(tool: Tool): Toolkit {
        this.tools.push({
            type: 'function',
            ...tool,
        });
        return this;
    }

    /**
     * Registers functions from a given MCP client.
     *
     * @param root0
     * @param root0.client
     * @param root0.enabledTools
     * @param root0.disabledTools
     * @param root0.requireUserConfirm
     * @returns The Toolkit instance with the new tools registered
     */
    async registerMCPClient({
        client,
        enabledTools,
        disabledTools = [],
        requireUserConfirm = false,
    }: {
        client: HTTPMCPClient | StdioMCPClient | MCPClient;
        enabledTools?: string[];
        disabledTools?: string[];
        requireUserConfirm?: boolean;
    }): Promise<Toolkit> {
        const tools = await client.listTools();

        const appendTools: string[] = [];
        tools
            .filter(
                tool =>
                    !(
                        enabledTools &&
                        !enabledTools.includes(tool.name) &&
                        !enabledTools.includes(tool.originalName)
                    ) &&
                    !disabledTools.includes(tool.name) &&
                    !disabledTools.includes(tool.originalName)
            )
            .forEach(tool => {
                this.tools.push({
                    type: 'mcp',
                    mcpName: client.name,
                    name: tool.originalName,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    call: async input => {
                        const result = await tool.call(input);
                        return new ToolResponse({
                            content: result.content,
                            state: result.state === 'error' ? 'error' : 'success',
                            metadata: result.metadata,
                        });
                    },
                    requireUserConfirm,
                });
                appendTools.push(tool.originalName);
            });
        console.log(`Registered tools from MCP client '${client.name}': ${appendTools.join(', ')}`);
        return this;
    }

    /**
     * Executes a registered tool function based on the provided ToolUseBlock.
     * Note this method always returns an AsyncGenerator of ToolResponse, regardless of the tool function type.
     *
     * @param toolCall - The ToolUseBlock containing the tool name and input arguments
     * @yields Incremental ToolResponse objects as they are produced by the tool function
     * @returns The final complete ToolResponse after the tool function execution is finished
     */
    async *callToolFunction(toolCall: ToolCallBlock): AsyncGenerator<ToolResponse, ToolResponse> {
        // If the tool is registered
        const tool = this.tools.find(tool => tool.name === toolCall.name);

        if (!tool) {
            const notFoundRes = createToolResponse({
                content: [
                    {
                        id: _generateId(),
                        created_at: _generateTimestamp(),
                        type: 'text',
                        text: `FunctionNotFoundError: Cannot find the function named ${toolCall.name}`,
                    },
                ],
                state: 'error',
            });
            yield notFoundRes;
            return notFoundRes;
        }

        // Parse the input arguments using the tool's schema
        let parsedInput: Record<string, unknown>;
        try {
            parsedInput = _jsonLoadsWithRepair(toolCall.input);
            if (tool.inputSchema instanceof z.ZodObject) {
                tool.inputSchema.parse(parsedInput);
            } else {
                //
                const validator = new Validator(tool.inputSchema);
                const validation = validator.validate(parsedInput);
                if (!validation.valid) {
                    throw new Error(`Invalid input arguments: ${validation.errors}`);
                }
            }
        } catch (error) {
            const parseErrorRes = createToolResponse({
                content: [
                    {
                        id: _generateId(),
                        created_at: _generateTimestamp(),
                        type: 'text',
                        text: `InvalidArgumentError: ${String(error)}`,
                    },
                ],
                state: 'error',
            });
            yield parseErrorRes;
            return parseErrorRes;
        }

        // Log the tool call with parsed input
        if (!tool.call) {
            throw new Error(
                `Cannot execute external tool '${toolCall.name}' because no call method is defined for it in the toolkit.`
            );
        }

        // Execute the tool function and await the result
        // Note: await on a non-Promise value returns the value itself
        let finalRes: ToolResponse | null = null;
        try {
            const res = await tool.call(parsedInput);

            // If res is a string
            if (typeof res === 'string') {
                const textRes = createToolResponse({
                    content: [
                        {
                            id: _generateId(),
                            created_at: _generateTimestamp(),
                            type: 'text',
                            text: res,
                        },
                    ],
                    state: 'success',
                });
                yield textRes;
                finalRes = textRes;
            } else if (isToolResponse(res)) {
                // If res is a ToolResponse
                yield res as ToolResponse;
                finalRes = res as ToolResponse;
            } else if (Symbol.asyncIterator in res) {
                // If res is an AsyncGenerator of string or ToolResponse
                const accContent: ToolResponse['content'] = [];
                let nextResult = await (res as AsyncGenerator<string | ToolResponse>).next();

                while (!nextResult.done) {
                    const currentValue = nextResult.value;
                    // Peek ahead to determine if this is the last value
                    nextResult = await (res as AsyncGenerator<string | ToolResponse>).next();
                    const isLastValue = nextResult.done;

                    if (typeof currentValue === 'string') {
                        const itemRes = createToolResponse({
                            content: [
                                {
                                    id: _generateId(),
                                    created_at: _generateTimestamp(),
                                    type: 'text',
                                    text: currentValue,
                                },
                            ],
                            isLast: isLastValue,
                            state: 'running',
                        });
                        yield itemRes;

                        // Accumulate the text content into finalRes
                        accContent.push({
                            id: _generateId(),
                            created_at: _generateTimestamp(),
                            type: 'text',
                            text: currentValue,
                        });
                    } else if (isToolResponse(currentValue)) {
                        // Use the isLast from the ToolResponse if set, otherwise use our calculated value
                        currentValue.isLast = currentValue.isLast ?? isLastValue;
                        yield currentValue as ToolResponse;

                        // Accumulate the content of the ToolResponse into finalRes
                        accContent.push(...currentValue.content);
                    }
                }
                finalRes = createToolResponse({
                    content: accContent,
                    state: 'success',
                });
            } else if (Symbol.iterator in res) {
                // If res is a Generator of string or ToolResponse
                const accContent: ToolResponse['content'] = [];
                let nextResult = (res as Generator<string | ToolResponse>).next();

                while (!nextResult.done) {
                    const currentValue = nextResult.value;
                    // Peek ahead to determine if this is the last value
                    nextResult = (res as Generator<string | ToolResponse>).next();
                    const isLastValue = nextResult.done;

                    if (typeof currentValue === 'string') {
                        const itemRes = createToolResponse({
                            content: [
                                {
                                    id: _generateId(),
                                    created_at: _generateTimestamp(),
                                    type: 'text',
                                    text: currentValue,
                                },
                            ],
                            isLast: isLastValue,
                            state: 'running',
                        });
                        yield itemRes;
                        // Accumulate the text content into finalRes
                        accContent.push({
                            id: _generateId(),
                            created_at: _generateTimestamp(),
                            type: 'text',
                            text: currentValue,
                        });
                    } else if (isToolResponse(currentValue)) {
                        // Use the isLast from the ToolResponse if set, otherwise use our calculated value
                        currentValue.isLast = currentValue.isLast ?? isLastValue;
                        yield currentValue as ToolResponse;
                        // Accumulate the content of the ToolResponse into finalRes
                        accContent.push(...currentValue.content);
                    }
                }
                finalRes = createToolResponse({
                    content: accContent,
                    state: 'success',
                });
            } else {
                const invalidRes = createToolResponse({
                    content: [
                        {
                            id: _generateId(),
                            created_at: _generateTimestamp(),
                            type: 'text',
                            text: String(res),
                        },
                    ],
                    state: 'running',
                });
                yield invalidRes;
                finalRes = invalidRes;
            }
        } catch (error) {
            const errorRes = createToolResponse({
                content: [
                    {
                        id: _generateId(),
                        created_at: _generateTimestamp(),
                        type: 'text',
                        text: `ToolExecutionError: ${String(error)}`,
                    },
                ],
                state: 'error',
            });
            yield errorRes;
            finalRes = errorRes;
        }

        if (!finalRes) {
            return createToolResponse({
                content: [
                    {
                        id: _generateId(),
                        created_at: _generateTimestamp(),
                        type: 'text',
                        text: `Tool ${toolCall.name} executed successfully.`,
                    },
                ],
                state: 'success',
            });
        }

        // Clean the finalRes by merging the adjacent text blocks into one block, leaving
        // multimodal content blocks (e.g. image, audio) unchanged
        const cleanedContent: ToolResponse['content'] = [];
        let textBuffer = '';
        for (const block of finalRes.content) {
            if (block.type === 'text') {
                textBuffer += block.text;
            } else {
                if (textBuffer) {
                    cleanedContent.push({
                        id: _generateId(),
                        created_at: _generateTimestamp(),
                        type: 'text',
                        text: textBuffer,
                    });
                    textBuffer = '';
                }
                cleanedContent.push(block);
            }
        }
        // The remaining text in the buffer, if any, should also be pushed to the cleanedContent
        if (textBuffer) {
            cleanedContent.push({
                id: _generateId(),
                created_at: _generateTimestamp(),
                type: 'text',
                text: textBuffer,
            });
        }

        return new ToolResponse({
            ...finalRes,
            content: cleanedContent,
        });
    }

    /**
     * Get schemas for the basic and requested active groups.
     * @param options Group filter.
     * @param options.groups
     * @returns Model-facing function schemas.
     */
    async getToolSchemas(options: { groups?: string[] } = {}): Promise<ToolSchema[]> {
        return [...(await this.getAvailableTools(options.groups)).values()].map(tool =>
            tool.getToolSchema()
        );
    }

    /**
     * Execute a ToolBase and yield incremental chunks followed by one final response.
     * @param toolCall Parsed model tool-call block.
     * @param state Current agent state for group and state injection.
     */
    async *callTool(
        toolCall: ToolCallBlock,
        state: AgentState
    ): AsyncGenerator<ToolChunk | ToolResponse, void> {
        const response = new ToolResponse({ id: toolCall.id });
        const available = await this.getAvailableTools(state.toolContext.activatedGroups);
        const registered = available.get(toolCall.name);
        if (!registered) {
            const all = await this.getAvailableTools(this.toolGroups.map(group => group.name));
            const known = all.get(toolCall.name);
            const result = known
                ? new ToolChunk({
                      content: [
                          TextBlock({
                              text:
                                  `ToolGroupInactiveError: The tool '${toolCall.name}' in group ` +
                                  `'${known.group}' is currently inactive. You should first activate ` +
                                  `the group by calling the '${this.builtinMetaTool.tool.name}' tool.`,
                          }),
                      ],
                      state: 'error',
                  })
                : new ToolChunk({
                      content: [
                          TextBlock({
                              text: `ToolNotFoundError: The tool named '${toolCall.name}' doesn't exist.`,
                          }),
                      ],
                      state: 'error',
                  });
            yield result;
            response.appendChunk(result);
            yield response;
            return;
        }

        try {
            const input = _jsonLoadsWithRepair(toolCall.input) as Record<string, unknown>;
            const tool = registered.tool as ToolBase;
            if (tool.isStateInjected && !tool.isMcp && !tool.isExternalTool) {
                input._agent_state = state;
            }
            const result = await tool.invoke(input);
            if (result instanceof ToolChunk) {
                yield result;
                response.appendChunk(result);
            } else {
                for await (const chunk of result) {
                    yield chunk;
                    response.appendChunk(chunk);
                }
            }
        } catch (error) {
            if (error instanceof DeveloperOrientedException) throw error;
            const chunk = new ToolChunk({
                content: [
                    TextBlock({ text: error instanceof Error ? error.message : String(error) }),
                ],
                state: 'error',
            });
            yield chunk;
            response.appendChunk(chunk);
        }
        yield response;
    }

    /**
     * Build instructions for every skill visible in active groups.
     * @param options Optional active-group filter; omitted includes all groups.
     * @param options.activatedGroups
     * @returns The skill prompt, or null when no skill is available.
     */
    async getSkillInstructions(
        options: { activatedGroups?: string[] } = {}
    ): Promise<string | null> {
        const groups = options.activatedGroups ?? this.toolGroups.map(group => group.name);
        const skills = [...(await this.getAvailableSkills(groups)).values()];
        if (skills.length === 0) return null;
        return (
            this.skillInstructionTemplate +
            skills
                .map(
                    skill =>
                        `\n<skill>\n<name>${skill.name}</name>\n` +
                        `<description>${skill.description}</description>\n` +
                        `<dir>${skill.dir}</dir>\n</skill>`
                )
                .join('') +
            '\n</agent-skills>'
        );
    }

    /**
     * Resolve a currently active tool or throw an agent-oriented error.
     * @param toolName Tool name.
     * @param activatedGroups Active group names.
     * @returns The available tool.
     */
    async checkToolAvailable(toolName: string, activatedGroups: string[]): Promise<ToolBase> {
        const active = await this.getAvailableTools(activatedGroups);
        const result = active.get(toolName);
        if (result) return result.tool as ToolBase;
        const all = await this.getAvailableTools(this.toolGroups.map(group => group.name));
        const known = all.get(toolName);
        if (known) {
            throw new ToolGroupInactiveError(
                `ToolGroupInactiveError: The tool '${toolName}' in group '${known.group}' ` +
                    `is currently inactive. You should first activate the group by calling ` +
                    `the '${this.builtinMetaTool.tool.name}' tool.`
            );
        }
        throw new ToolNotFoundError(
            `ToolNotFoundError: The tool named '${toolName}' doesn't exist.`
        );
    }

    /**
     * Get a tool regardless of group activation.
     * @param name Tool name.
     * @returns The tool, or null when absent.
     */
    async getTool(name: string): Promise<ToolBase | null> {
        const all = await this.getAvailableTools(this.toolGroups.map(group => group.name));
        return (all.get(name)?.tool as ToolBase | undefined) ?? null;
    }

    /** Clear all new-style groups. */
    clear(): void {
        this.toolGroups.splice(0);
    }

    /**
     * Add or replace tools in one group.
     * @param tool Tool or tools to add.
     * @param groupName Target group.
     */
    async addTool(tool: ToolBase | ToolBase[], groupName = 'basic'): Promise<void> {
        const group = this.toolGroups.find(candidate => candidate.name === groupName);
        if (!group) {
            throw new Error(
                `Cannot find group '${groupName}' in toolkit, only ` +
                    `${JSON.stringify(this.toolGroups.map(candidate => candidate.name))} are available.`
            );
        }
        for (const value of Array.isArray(tool) ? tool : [tool]) {
            const index = group.tools.findIndex(existing => existing.name === value.name);
            if (index === -1) group.tools.push(value);
            else group.tools.splice(index, 1, value);
        }
    }

    /**
     * Remove tools with matching names from every group.
     * @param toolName Name or names to remove.
     */
    async removeTool(toolName: string | string[]): Promise<void> {
        const names = new Set(Array.isArray(toolName) ? toolName : [toolName]);
        for (const group of this.toolGroups) {
            group.tools = group.tools.filter(tool => !names.has(tool.name));
        }
    }

    /**
     * Collect skills in basic and requested groups with last-write-wins names.
     * @param groups
     */
    private async getAvailableSkills(groups?: string[]): Promise<Map<string, Skill>> {
        const filter = new Set(['basic', ...(groups ?? [])]);
        const result = new Map<string, Skill>();
        for (const group of this.toolGroups) {
            if (!filter.has(group.name)) continue;
            for (const skill of await group.listSkills()) result.set(skill.name, skill);
        }
        return result;
    }

    /**
     * Collect tools in basic and requested groups, including conditional built-ins.
     * @param groups
     */
    private async getAvailableTools(groups?: string[]): Promise<Map<string, RegisteredTool>> {
        const result = new Map<string, RegisteredTool>();
        if ((await this.getAvailableSkills(groups)).size > 0) {
            result.set(this.builtinSkillViewer.tool.name, this.builtinSkillViewer);
        }
        if (this.toolGroups.length > 1) {
            result.set(this.builtinMetaTool.tool.name, this.builtinMetaTool);
        }
        const filter = new Set(['basic', ...(groups ?? [])]);
        for (const group of this.toolGroups) {
            if (!filter.has(group.name)) continue;
            const tools = [...group.tools];
            for (const client of group.mcps) {
                if (!client.listTools) continue;
                try {
                    tools.push(...(await client.listTools()));
                } catch (error) {
                    logger.warning(
                        "Skipping MCP '%s' in group '%s': listing its tools failed with %s",
                        client.name,
                        group.name,
                        _describeException(error)
                    );
                }
            }
            for (const tool of tools) {
                result.set(tool.name, new RegisteredTool({ tool, group: group.name }));
            }
        }
        return result;
    }

    /**
     * Returns the JSON schemas for all registered tools in a format compatible with LLM APIs.
     *
     * @returns An array of ToolJSONSchema objects
     */
    getJSONSchemas(): ToolSchema[] {
        return this.tools.map(tool => {
            const inputSchema =
                tool.inputSchema instanceof z.ZodObject
                    ? tool.inputSchema.toJSONSchema({ target: 'openapi-3.0' })
                    : tool.inputSchema;

            return {
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: inputSchema as ToolInputSchema,
                },
            };
        });
    }

    /**
     * Get the instruction prompt for the agent to use the skills.
     *
     * @returns A string containing the instruction prompt of the available skills and how to use them.
     */
    getSkillsPrompt(): string {
        this._skillCache = {};
        if (this.skills.length === 0 && this.skillDirs.length === 0) return '';

        if (typeof process !== 'undefined' && process.versions && process.versions.node) {
            const skillsInfo: { name: string; description: string; location: string }[] = [];
            this.skills.forEach(skillPath => {
                // 首先获取绝对路径
                const absSkillPath = path.resolve(skillPath);

                // Check if directory exists
                if (!fs.existsSync(absSkillPath) || !fs.statSync(absSkillPath).isDirectory()) {
                    return;
                }

                // First, check if SKILL.md exists directly in this directory
                const skillMdPath = path.join(absSkillPath, 'SKILL.md');
                if (!fs.existsSync(skillMdPath)) return;

                // Read the SKILL.md file and extract the name and description from the YAML front matter
                try {
                    const content = fs.readFileSync(skillMdPath, 'utf-8');
                    const { data } = matter(content);

                    const name = data.name || path.basename(skillPath);
                    const description = data.description || 'No description provided';

                    skillsInfo.push({
                        name,
                        description,
                        location: absSkillPath,
                    });

                    this._skillCache[name] = absSkillPath;
                } catch (e) {
                    console.error(`Error reading SKILL.md for skill at ${skillPath}:`, e);
                }
            });

            this.skillDirs.forEach(skillDir => {
                const absSkillDir = path.resolve(skillDir);

                // Check if directory exists
                if (!fs.existsSync(absSkillDir) || !fs.statSync(absSkillDir).isDirectory()) {
                    return;
                }

                // Read all subdirectories in the skillDir
                const subdirs = fs.readdirSync(absSkillDir).filter(subdir => {
                    const subdirPath = path.join(absSkillDir, subdir);
                    return fs.statSync(subdirPath).isDirectory();
                });

                subdirs.forEach(subdir => {
                    const skillMdPath = path.join(absSkillDir, subdir, 'SKILL.md');
                    if (!fs.existsSync(skillMdPath)) return;

                    try {
                        const content = fs.readFileSync(skillMdPath, 'utf-8');
                        const { data } = matter(content);

                        const name = data.name || subdir;
                        const description = data.description || 'No description provided';

                        skillsInfo.push({
                            name,
                            description,
                            location: path.join(skillDir, subdir),
                        });

                        this._skillCache[name] = path.join(absSkillDir, subdir);
                    } catch (e) {
                        console.error(
                            `Error reading SKILL.md for skill at ${path.join(skillDir, subdir)}:`,
                            e
                        );
                    }
                });
            });

            if (skillsInfo.length === 0) return '';

            const skillsXml = skillsInfo
                .map(
                    skill => `<skill>
<name>${skill.name}</name>
<description>${skill.description}</description>
<location>${skill.location}</location>
</skill>`
                )
                .reduce((acc, skillInfo) => acc + `\n${skillInfo}\n`, '');

            return `<skills-system>
## What are Skills?
Skills are packages of domain expertise that extend your capabilities.

## Important: How to Use Skills
**Skill names are NOT callable functions.** You cannot call a skill directly by its name.
${skillsXml}
</skills-system>`;
        }

        return '';
    }

    /**
     * The agent skill tool to read SKILL.md file content based on the skill name.
     * @param root0
     * @param root0.name
     * @returns The content of the SKILL.md file for the specified skill, or an error message if the skill is not
     * found or the SKILL.md file cannot be read.
     */
    private async _skillTool({ name }: { name: string }): Promise<ToolResponse> {
        if (this._skillCache[name]) {
            // Look up the skill name in the cache to get the corresponding directory path
            const skillDir = this._skillCache[name];
            // Read the SKILL.md file in the skill directory and return its content as the tool response
            const skillMdPath = path.join(skillDir, 'SKILL.md');
            if (!fs.existsSync(skillMdPath)) {
                try {
                    const fileContent = fs.readFileSync(skillMdPath, 'utf-8');
                    return createToolResponse({
                        content: [
                            {
                                id: _generateId(),
                                created_at: _generateTimestamp(),
                                type: 'text',
                                text: fileContent,
                            },
                        ],
                        state: 'success',
                    });
                } catch {}
            }
        }

        // Scan the skills and skillDirs again to find the skill if it's not in the cache and refresh the cache at the same time
        this.getSkillsPrompt();
        const refreshedSkillDir = this._skillCache[name];
        if (refreshedSkillDir) {
            const skillMdPath = path.join(refreshedSkillDir, 'SKILL.md');
            try {
                const fileContent = fs.readFileSync(skillMdPath, 'utf-8');
                return createToolResponse({
                    content: [
                        {
                            id: _generateId(),
                            created_at: _generateTimestamp(),
                            type: 'text',
                            text: fileContent,
                        },
                    ],
                    state: 'success',
                });
            } catch {}
        }

        return createToolResponse({
            content: [
                {
                    id: _generateId(),
                    created_at: _generateTimestamp(),
                    type: 'text',
                    text: `SkillNotFoundError: Cannot find the skill named ${name}, current available skills are ${Object.keys(this._skillCache).join(', ')}`,
                },
            ],
            state: 'error',
        });
    }

    /**
     * Checks if a tool requires user confirmation before execution based on its name.
     * @param toolName The name of the tool to check for user confirmation requirement.
     * @returns A boolean indicating whether the specified tool requires user confirmation before execution. If the tool is not found, it returns false.
     */
    requireUserConfirm(toolName: string): boolean {
        const tool = this.tools.find(tool => tool.name === toolName);
        return tool ? (tool.requireUserConfirm ?? false) : false;
    }

    /**
     * Checks if a tool requires external execution (e.g., by an MCP client) based on its name.
     * @param toolName
     * @returns A boolean indicating whether the specified tool requires external execution. If the tool is not found, it returns false.
     */
    requireExternalExecution(toolName: string): boolean {
        const tool = this.tools.find(tool => tool.name === toolName);
        return tool ? !tool.call : false;
    }
}

function adaptToolBaseToLegacy(tool: ToolBase): LegacyRegisteredTool {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        requireUserConfirm: !tool.name.startsWith('Task'),
        call: async input => {
            const result = await tool.invoke(input);
            if (result instanceof ToolChunk) {
                return new ToolResponse({
                    content: result.content,
                    state: result.state === 'error' ? 'error' : 'success',
                    metadata: result.metadata,
                });
            }
            return adaptToolChunkStream(result);
        },
    };
}

async function* adaptToolChunkStream(
    stream: AsyncGenerator<ToolChunk, void, void>
): AsyncGenerator<ToolResponse, void, void> {
    for await (const chunk of stream) {
        yield new ToolResponse({
            content: chunk.content,
            state: chunk.state === 'error' ? 'error' : 'success',
            metadata: chunk.metadata,
        });
    }
}
