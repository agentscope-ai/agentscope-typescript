import * as fs from 'fs';
import * as path from 'path';

import { Validator } from '@cfworker/json-schema';
import matter from 'gray-matter';
import { z } from 'zod';

import { _jsonLoadsWithRepair } from '../_utils';
import { HTTPMCPClient } from '../mcp/http';
import { StdioMCPClient } from '../mcp/stdio';
import type { ToolCallBlock } from '../message/block';
import type { ToolInputSchema, ToolSchema } from '../type';
import type { Tool } from './base';
import { createToolResponse, isToolResponse, ToolResponse } from './response';

interface RegisteredTool extends Tool {
    type: 'function' | 'mcp';
    mcpName?: string;
}

/**
 * The toolkit module in AgentScope, which is responsible for registering tool functions, MCP, and agent skills.
 * It also provides group-wise management of tools.
 */
export class Toolkit {
    tools: RegisteredTool[];
    skills: string[];
    skillDirs: string[];

    // The cache mapping from the skill name to its corresponding tool name in the toolkit.
    private _skillCache: { [name: string]: string };

    /**
     * Initializes a new instance of the Toolkit class.
     * @param config - The configuration object for initializing the toolkit, which can include an array of tools, an array of skill paths, an array of skill directory paths, and a boolean indicating whether to include the built-in skill tool for reading SKILL.md files.
     * @param config.tools - An array of tool definitions to register in the toolkit.
     * @param config.skills - An array of file paths pointing to individual skills.
     * @param config.skillDirs - An array of directory paths, where each directory can contain multiple skills in its subdirectories.
     * @param config.builtInSkillTool - A boolean flag indicating whether to include the built-in skill tool for reading SKILL.md files.
     */
    constructor(config?: {
        tools?: Tool[];
        skills?: string[];
        skillDirs?: string[];
        builtInSkillTool?: boolean;
    }) {
        const { tools = [], skills = [], skillDirs = [], builtInSkillTool = true } = config || {};

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

        tools.map(tool => {
            this.tools.push({
                type: 'function',
                ...tool,
            });
        });

        this.skills = skills;
        this.skillDirs = skillDirs;

        this._skillCache = {};
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
        client: HTTPMCPClient | StdioMCPClient;
        enabledTools?: string[];
        disabledTools?: string[];
        requireUserConfirm?: boolean;
    }): Promise<Toolkit> {
        const tools = await client.listTools();

        const appendTools: string[] = [];
        tools
            .filter(
                tool =>
                    !(enabledTools && !enabledTools.includes(tool.name)) &&
                    !disabledTools.includes(tool.name)
            )
            .forEach(tool => {
                this.tools.push({
                    type: 'mcp',
                    mcpName: client.name,
                    ...tool,
                    requireUserConfirm,
                });
                appendTools.push(tool.name);
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
                        id: crypto.randomUUID(),
                        created_at: new Date().toISOString(),
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
                        id: crypto.randomUUID(),
                        created_at: new Date().toISOString(),
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
                            id: crypto.randomUUID(),
                            created_at: new Date().toISOString(),
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
                                    id: crypto.randomUUID(),
                                    created_at: new Date().toISOString(),
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
                            id: crypto.randomUUID(),
                            created_at: new Date().toISOString(),
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
                                    id: crypto.randomUUID(),
                                    created_at: new Date().toISOString(),
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
                            id: crypto.randomUUID(),
                            created_at: new Date().toISOString(),
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
                            id: crypto.randomUUID(),
                            created_at: new Date().toISOString(),
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
                        id: crypto.randomUUID(),
                        created_at: new Date().toISOString(),
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
                        id: crypto.randomUUID(),
                        created_at: new Date().toISOString(),
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
                        id: crypto.randomUUID(),
                        created_at: new Date().toISOString(),
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
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
                type: 'text',
                text: textBuffer,
            });
        }

        return {
            ...finalRes,
            content: cleanedContent,
        };
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
                                id: crypto.randomUUID(),
                                created_at: new Date().toISOString(),
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
                            id: crypto.randomUUID(),
                            created_at: new Date().toISOString(),
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
                    id: crypto.randomUUID(),
                    created_at: new Date().toISOString(),
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
