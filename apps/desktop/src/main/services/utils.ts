import {
    OllamaChatModel,
    ChatModelBase,
    DashScopeChatModel,
    DeepSeekChatModel,
    OpenAIChatModel,
} from '@agentscope-ai/agentscope/model';
import { Bash, Toolkit, Write, Edit, Read, Glob, Grep } from '@agentscope-ai/agentscope/tool';
import { ModelConfig } from '@shared/types/config';

import { mcpGetAvailableClients } from './mcpService';
import { skillGetAll } from './skillService';
import {
    ScheduleCreate,
    ScheduleDelete,
    ScheduleGet,
    ScheduleList,
    ScheduleUpdate,
} from '../scheduler/tools';

/**
 * Creates a chat model instance based on the provider config.
 * @param modelConfig - The model configuration.
 * @returns A ChatModelBase instance.
 */
export function getModel(modelConfig: ModelConfig) {
    let model: ChatModelBase;
    switch (modelConfig.provider) {
        case 'dashscope':
            model = new DashScopeChatModel({
                modelName: modelConfig.modelName,
                apiKey: modelConfig.apiKey,
                stream: true,
            });
            break;
        case 'openai':
            model = new OpenAIChatModel({
                modelName: modelConfig.modelName,
                apiKey: modelConfig.apiKey,
                stream: true,
            });
            break;
        case 'ollama':
            model = new OllamaChatModel({
                modelName: modelConfig.modelName,
                stream: true,
            });
            break;
        case 'deepseek':
            model = new DeepSeekChatModel({
                modelName: modelConfig.modelName,
                apiKey: modelConfig.apiKey,
                stream: true,
            });
            break;
    }
    return model;
}

/**
 * Builds a toolkit with all available tools and MCP clients for a session.
 * @param sessionId - The current session ID.
 * @param agentKey - The unique key for the agent instance (used for scheduling tools).
 * @returns A configured Toolkit instance.
 */
export async function getToolkit(sessionId: string, agentKey: string) {
    const skills = skillGetAll().map(skill => skill.dirPath);

    const toolkit = new Toolkit({
        tools: [
            Bash(),
            Glob(),
            Write(),
            Edit(),
            Read(),
            Glob(),
            Grep(),
            ScheduleCreate(sessionId, agentKey),
            ScheduleDelete(),
            ScheduleList(),
            ScheduleGet(),
            ScheduleUpdate(),
        ],
        skills,
        builtInSkillTool: true,
    });
    // Register all available MCP clients
    const mcpClients = await mcpGetAvailableClients();
    for (const client of mcpClients) {
        await toolkit.registerMCPClient({ client });
    }
    return toolkit;
}
