import { Agent } from './agent';
import { AgentEvent, EventType, UserConfirmResultEvent } from '../event';
import { ContentBlock, Msg } from '../message';
import { ChatModelBase, ChatResponse } from '../model';
import { ChatModelRequestOptions } from '../model/base';
import { Bash, Edit, Glob, Grep, Read, Toolkit, Write } from '../tool';
import { ToolChoice, ToolSchema } from '../type';

/**
 * A mock chat model for testing purposes.
 */
class MockChatModel extends ChatModelBase {
    /**
     * Mock implementations
     * @param _tools
     */
    _formatToolSchemas(_tools: ToolSchema[]): unknown[] {
        throw new Error('Method not implemented.');
    }
    public mockContent: ContentBlock[];
    /**
     * Initialize a new instance of the MockChatModel class.
     */
    constructor() {
        super({ modelName: 'mock-model' });
        this.mockContent = [];
        this.stream = false;
    }

    /**
     * Simulate calling the API and return a ChatResponse with the mock content.
     * @param _modelName
     * @param _options
     * @returns A promise that resolves to a ChatResponse containing the mock content.
     */
    async _callAPI(
        _modelName: string,
        _options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse> {
        return {
            type: 'chat',
            id: 'mock-id',
            createdAt: new Date().toISOString(),
            content: [...this.mockContent],
        } as ChatResponse;
    }

    /**
     * Simulate formatting the tool choice. This method is not implemented in this mock model.
     * @param _toolChoice
     */
    _formatToolChoice(_toolChoice: ToolChoice): unknown {
        throw new Error('Method not implemented.');
    }
}

describe('Human-in-the-loop', () => {
    test('user confirm', async () => {
        // Prepare tools and agent
        const toolkit = new Toolkit({
            tools: [Bash(), Glob(), Grep(), Read(), Write(), Edit()],
        });

        const model = new MockChatModel();
        const agent = new Agent({
            name: 'Friday',
            sysPrompt: 'You are a helpful assistant named Friday.',
            model: model,
            toolkit,
        });

        // Set mock content to simulate model output with tool calls
        model.mockContent = [
            {
                type: 'tool_call',
                id: '1',
                name: 'Bash',
                input: `{"command": "echo Hello"}`,
                state: 'pending',
            },
            {
                type: 'tool_call',
                id: '2',
                name: 'Bash',
                input: `{"command": "echo World"}`,
                state: 'pending',
            },
        ];

        // Record the last event emitted by the agent
        let lastEvent: AgentEvent | null = null;
        for await (const event of agent.replyStream({})) {
            lastEvent = event;
        }

        expect(lastEvent).toMatchObject({
            type: EventType.REQUIRE_USER_CONFIRM,
            tool_calls: [
                {
                    type: 'tool_call',
                    id: '1',
                    name: 'Bash',
                    input: '{"command": "echo Hello"}',
                    state: 'asking',
                },
                {
                    type: 'tool_call',
                    id: '2',
                    name: 'Bash',
                    input: '{"command": "echo World"}',
                    state: 'asking',
                },
            ],
        });

        expect(await agent.toJSON()).toMatchObject({
            reply_id: expect.any(String),
            confirmedToolCallIds: [],
            curIter: 0,
        });

        // Ensure the agent context state
        expect(agent.context).toEqual([
            {
                content: [
                    {
                        id: '1',
                        input: '{"command": "echo Hello"}',
                        name: 'Bash',
                        type: 'tool_call',
                        state: 'asking',
                    },
                    {
                        id: '2',
                        input: '{"command": "echo World"}',
                        name: 'Bash',
                        type: 'tool_call',
                        state: 'asking',
                    },
                ],
                id: expect.any(String),
                metadata: {},
                name: 'Friday',
                role: 'assistant',
                created_at: expect.any(String),
            },
        ]);

        // Simulate user confirmation result for the first tool call
        for await (const event of agent.replyStream({
            event: {
                id: 'xxx',
                created_at: new Date().toISOString(),
                type: EventType.USER_CONFIRM_RESULT,
                reply_id: agent.replyId,
                confirm_results: [
                    {
                        confirmed: true,
                        tool_call: {
                            type: 'tool_call',
                            id: '1',
                            name: 'Bash',
                            input: '{"command": "echo Hello"}',
                            state: 'pending',
                        },
                    },
                ],
            } as UserConfirmResultEvent,
        })) {
            lastEvent = event;
        }

        // Verify the agent still yields user confirmation for the second tool call
        expect(lastEvent).toMatchObject({
            type: EventType.REQUIRE_USER_CONFIRM,
            reply_id: expect.any(String),
            tool_calls: [
                {
                    type: 'tool_call',
                    id: '2',
                    name: 'Bash',
                    input: '{"command": "echo World"}',
                    state: 'asking',
                },
            ],
        });

        // Verify the current agent context
        expect(agent.context.map(msg => msg.content)).toEqual([
            [
                {
                    id: '1',
                    input: '{"command": "echo Hello"}',
                    name: 'Bash',
                    type: 'tool_call',
                    state: 'allowed',
                },
                {
                    id: '2',
                    input: '{"command": "echo World"}',
                    name: 'Bash',
                    type: 'tool_call',
                    state: 'asking',
                },
                {
                    id: '1',
                    name: 'Bash',
                    output: [
                        {
                            id: expect.any(String),
                            text: 'Hello\n',
                            type: 'text',
                        },
                    ],
                    type: 'tool_result',
                    state: 'success',
                },
            ],
        ]);

        model.mockContent = [{ type: 'text', text: 'Finished', id: expect.any(String) }];

        // Reject the second tool call by simulating user confirmation result
        const res = agent.replyStream({
            event: {
                id: 'xxx',
                created_at: new Date().toISOString(),
                type: EventType.USER_CONFIRM_RESULT,
                reply_id: agent.replyId,
                confirm_results: [
                    {
                        confirmed: false,
                        tool_call: {
                            type: 'tool_call',
                            id: '2',
                            name: 'Bash',
                            input: '{"command": "echo World"}',
                            state: 'pending',
                        },
                    },
                ],
            },
        });

        let replyMsg: Msg;
        while (true) {
            const { value, done } = await res.next();
            if (done) {
                replyMsg = value as Msg;
                break;
            }
            lastEvent = value;
        }

        // Verify the lastEvent
        expect(lastEvent).toMatchObject({
            id: expect.any(String),
            type: EventType.REPLY_END,
            created_at: expect.any(String),
            reply_id: agent.replyId,
        });

        // Verify the final agent reply msg
        expect(replyMsg).toMatchObject({
            content: [
                {
                    id: expect.any(String),
                    type: 'text',
                    text: 'Finished',
                },
            ],
            id: expect.any(String),
            metadata: {},
            name: 'Friday',
            role: 'assistant',
            created_at: expect.any(String),
        });
    });

    test('external execution', async () => {
        // Prepare tools and agent with external execution tools
        const externalTool1 = {
            name: 'ExternalTool1',
            description: 'A tool that requires external execution',
            inputSchema: {
                type: 'object' as const,
                properties: { query: { type: 'string' as const } },
            },
            // No call method means it requires external execution
        };

        const externalTool2 = {
            name: 'ExternalTool2',
            description: 'Another tool that requires external execution',
            inputSchema: {
                type: 'object' as const,
                properties: { data: { type: 'string' as const } },
            },
            // No call method means it requires external execution
        };

        const toolkit = new Toolkit({
            tools: [externalTool1, externalTool2],
        });

        const model = new MockChatModel();
        const agent = new Agent({
            name: 'Friday',
            sysPrompt: 'You are a helpful assistant named Friday.',
            model: model,
            toolkit,
        });

        // Set mock content to simulate model output with external tool calls
        model.mockContent = [
            {
                type: 'tool_call',
                id: '1',
                name: 'ExternalTool1',
                input: `{"query": "test query"}`,
                state: 'pending',
            },
            {
                type: 'tool_call',
                id: '2',
                name: 'ExternalTool2',
                input: `{"data": "test data"}`,
                state: 'pending',
            },
        ];

        // Record the last event emitted by the agent
        let lastEvent: AgentEvent | null = null;
        for await (const event of agent.replyStream({})) {
            lastEvent = event;
        }

        // Verify the agent emits REQUIRE_EXTERNAL_EXECUTION event
        expect(lastEvent).toMatchObject({
            type: EventType.REQUIRE_EXTERNAL_EXECUTION,
            tool_calls: [
                {
                    type: 'tool_call',
                    id: '1',
                    name: 'ExternalTool1',
                    input: '{"query": "test query"}',
                    state: 'pending',
                },
                {
                    type: 'tool_call',
                    id: '2',
                    name: 'ExternalTool2',
                    input: '{"data": "test data"}',
                    state: 'pending',
                },
            ],
        });

        // Verify agent state
        expect(await agent.toJSON()).toMatchObject({
            reply_id: expect.any(String),
            confirmedToolCallIds: [],
            curIter: 0,
        });

        // Verify agent context
        expect(agent.context).toEqual([
            {
                content: [
                    {
                        id: '1',
                        input: '{"query": "test query"}',
                        name: 'ExternalTool1',
                        type: 'tool_call',
                        state: 'pending',
                    },
                    {
                        id: '2',
                        input: '{"data": "test data"}',
                        name: 'ExternalTool2',
                        type: 'tool_call',
                        state: 'pending',
                    },
                ],
                id: expect.any(String),
                metadata: {},
                name: 'Friday',
                role: 'assistant',
                created_at: expect.any(String),
                finished_at: undefined,
            },
        ]);

        // Provide execution result for the first tool call
        for await (const event of agent.replyStream({
            event: {
                id: 'xxx',
                created_at: new Date().toISOString(),
                type: EventType.EXTERNAL_EXECUTION_RESULT,
                reply_id: agent.replyId,
                execution_results: [
                    {
                        type: 'tool_result',
                        id: '1',
                        name: 'ExternalTool1',
                        output: [
                            {
                                id: 'output-1',
                                type: 'text',
                                text: 'Result from ExternalTool1',
                            },
                        ],
                        state: 'success',
                    },
                ],
            },
        })) {
            lastEvent = event;
        }

        // Verify the agent still requires external execution for the second tool
        expect(lastEvent).toMatchObject({
            type: EventType.REQUIRE_EXTERNAL_EXECUTION,
            reply_id: expect.any(String),
            tool_calls: [
                {
                    type: 'tool_call',
                    id: '2',
                    name: 'ExternalTool2',
                    input: '{"data": "test data"}',
                    state: 'pending',
                },
            ],
        });

        // Verify the current agent context
        expect(agent.context.map(msg => msg.content)).toEqual([
            [
                {
                    id: '1',
                    input: '{"query": "test query"}',
                    name: 'ExternalTool1',
                    type: 'tool_call',
                    state: 'pending',
                },
                {
                    id: '2',
                    input: '{"data": "test data"}',
                    name: 'ExternalTool2',
                    type: 'tool_call',
                    state: 'pending',
                },
                {
                    id: '1',
                    name: 'ExternalTool1',
                    output: [
                        {
                            id: expect.any(String),
                            text: 'Result from ExternalTool1',
                            type: 'text',
                        },
                    ],
                    type: 'tool_result',
                    state: 'success',
                },
            ],
        ]);

        model.mockContent = [{ type: 'text', text: 'All tools executed', id: expect.any(String) }];

        // Provide execution result for the second tool call
        const res = agent.replyStream({
            event: {
                id: 'xxx',
                created_at: new Date().toISOString(),
                type: EventType.EXTERNAL_EXECUTION_RESULT,
                reply_id: agent.replyId,
                execution_results: [
                    {
                        type: 'tool_result',
                        id: '2',
                        name: 'ExternalTool2',
                        output: [
                            {
                                id: expect.any(String),
                                type: 'text',
                                text: 'Result from ExternalTool2',
                            },
                        ],
                        state: 'success',
                    },
                ],
            },
        });

        let replyMsg: Msg;
        while (true) {
            const { value, done } = await res.next();
            if (done) {
                replyMsg = value as Msg;
                break;
            }
            lastEvent = value;
        }

        // Verify the lastEvent is RUN_FINISHED
        expect(lastEvent).toMatchObject({
            id: expect.any(String),
            type: EventType.REPLY_END,
            created_at: expect.any(String),
            reply_id: agent.replyId,
        });

        // Verify the final agent reply msg
        expect(replyMsg).toMatchObject({
            content: [
                {
                    id: expect.any(String),
                    type: 'text',
                    text: 'All tools executed',
                },
            ],
            id: expect.any(String),
            metadata: {},
            name: 'Friday',
            role: 'assistant',
            created_at: expect.any(String),
        });
    });

    test('mixed tool calls', async () => {
        // Create three tools: external execution, user confirm, and normal execution
        const externalTool = {
            name: 'ExternalTool',
            description: 'A tool that requires external execution',
            inputSchema: {
                type: 'object' as const,
                properties: { query: { type: 'string' as const } },
            },
            // No call method means it requires external execution
        };

        const confirmTool = {
            name: 'ConfirmTool',
            description: 'A tool that requires user confirmation',
            inputSchema: {
                type: 'object' as const,
                properties: { action: { type: 'string' as const } },
            },
            requireUserConfirm: true,
            call: async (input: { action: string }) => {
                return `Executed action: ${input.action}`;
            },
        };

        const normalTool = {
            name: 'NormalTool',
            description: 'A normal tool',
            inputSchema: {
                type: 'object' as const,
                properties: { data: { type: 'string' as const } },
            },
            call: async (input: { data: string }) => {
                return `Processed data: ${input.data}`;
            },
        };

        const toolkit = new Toolkit({
            tools: [
                externalTool,
                confirmTool,
                normalTool,
                Bash(),
                Glob(),
                Grep(),
                Read(),
                Write(),
                Edit(),
            ],
        });

        const model = new MockChatModel();
        const agent = new Agent({
            name: 'Friday',
            sysPrompt: 'You are a helpful assistant named Friday.',
            model: model,
            toolkit,
        });

        // Set mock content to simulate model output with three different tool calls
        model.mockContent = [
            {
                type: 'tool_call',
                id: '1',
                name: 'ExternalTool',
                input: `{"query": "external query"}`,
                state: 'pending',
            },
            {
                type: 'tool_call',
                id: '2',
                name: 'ConfirmTool',
                input: `{"action": "delete file"}`,
                state: 'pending',
            },
            {
                type: 'tool_call',
                id: '3',
                name: 'NormalTool',
                input: `{"data": "normal data"}`,
                state: 'pending',
            },
        ];

        // Record the last event emitted by the agent
        let lastEvent: AgentEvent | null = null;
        for await (const event of agent.replyStream({})) {
            lastEvent = event;
        }

        // Verify the agent emits REQUIRE_EXTERNAL_EXECUTION event for the first tool
        expect(lastEvent).toMatchObject({
            type: EventType.REQUIRE_EXTERNAL_EXECUTION,
            tool_calls: [
                {
                    type: 'tool_call',
                    id: '1',
                    name: 'ExternalTool',
                    input: '{"query": "external query"}',
                    state: 'pending',
                },
            ],
        });

        // Verify agent state
        expect(await agent.toJSON()).toMatchObject({
            reply_id: expect.any(String),
            confirmedToolCallIds: [],
            curIter: 0,
        });

        // Provide execution result for the external tool
        for await (const event of agent.replyStream({
            event: {
                id: 'xxx',
                created_at: new Date().toISOString(),
                type: EventType.EXTERNAL_EXECUTION_RESULT,
                reply_id: agent.replyId,
                execution_results: [
                    {
                        type: 'tool_result',
                        id: '1',
                        name: 'ExternalTool',
                        output: [
                            {
                                id: expect.any(String),
                                type: 'text',
                                text: 'External execution result',
                            },
                        ],
                        state: 'success',
                    },
                ],
            },
        })) {
            lastEvent = event;
        }

        // Verify the agent now requires user confirmation for the second tool
        expect(lastEvent).toMatchObject({
            type: EventType.REQUIRE_USER_CONFIRM,
            reply_id: expect.any(String),
            tool_calls: [
                {
                    type: 'tool_call',
                    id: '2',
                    name: 'ConfirmTool',
                    input: '{"action": "delete file"}',
                    state: 'asking',
                },
            ],
        });

        // Verify agent state after external execution
        expect(await agent.toJSON()).toMatchObject({
            reply_id: expect.any(String),
            confirmedToolCallIds: [],
            curIter: 0,
        });

        // Update mock content to return final text response
        model.mockContent = [
            {
                type: 'text',
                text: 'All tools completed successfully',
                id: expect.any(String),
            },
        ];

        // Provide user confirmation for the second tool
        for await (const event of agent.replyStream({
            event: {
                id: 'xxx',
                created_at: new Date().toISOString(),
                type: EventType.USER_CONFIRM_RESULT,
                reply_id: agent.replyId,
                confirm_results: [
                    {
                        confirmed: true,
                        tool_call: {
                            type: 'tool_call',
                            id: '2',
                            name: 'ConfirmTool',
                            input: '{"action": "delete file"}',
                            state: 'pending',
                        },
                    },
                ],
            },
        })) {
            lastEvent = event;
        }

        // Verify the lastEvent is RUN_FINISHED
        expect(lastEvent).toMatchObject({
            id: expect.any(String),
            type: EventType.REPLY_END,
            created_at: expect.any(String),
            reply_id: agent.replyId,
        });

        // Verify the agent context includes all three tool calls, their results, and the final text
        expect(agent.context.map(msg => msg.content)).toEqual([
            [
                {
                    id: '1',
                    input: '{"query": "external query"}',
                    name: 'ExternalTool',
                    type: 'tool_call',
                    state: 'pending',
                },
                {
                    id: '2',
                    input: '{"action": "delete file"}',
                    name: 'ConfirmTool',
                    type: 'tool_call',
                    state: 'allowed',
                },
                {
                    id: '3',
                    input: '{"data": "normal data"}',
                    name: 'NormalTool',
                    type: 'tool_call',
                    state: 'pending',
                },
                {
                    id: '1',
                    name: 'ExternalTool',
                    output: [
                        {
                            id: expect.any(String),
                            text: 'External execution result',
                            type: 'text',
                        },
                    ],
                    type: 'tool_result',
                    state: 'success',
                },
                {
                    id: '2',
                    name: 'ConfirmTool',
                    output: [
                        {
                            id: expect.any(String),
                            text: 'Executed action: delete file',
                            type: 'text',
                        },
                    ],
                    type: 'tool_result',
                    state: 'success',
                },
                {
                    id: '3',
                    name: 'NormalTool',
                    output: [
                        {
                            id: expect.any(String),
                            text: 'Processed data: normal data',
                            type: 'text',
                        },
                    ],
                    type: 'tool_result',
                    state: 'success',
                },
                {
                    id: expect.any(String),
                    type: 'text',
                    text: 'All tools completed successfully',
                },
            ],
        ]);
    });

    test('a tool requires both external execution and user confirmation', async () => {
        // Create two tools: one requires both external execution and user confirmation,
        // another requires only user confirmation
        const externalAndConfirmTool = {
            name: 'ExternalAndConfirmTool',
            description: 'A tool that requires both external execution and user confirmation',
            inputSchema: {
                type: 'object' as const,
                properties: { command: { type: 'string' as const } },
            },
            requireUserConfirm: true,
            // No call method means it requires external execution
        };

        const confirmOnlyTool = {
            name: 'ConfirmOnlyTool',
            description: 'A tool that requires only user confirmation',
            inputSchema: {
                type: 'object' as const,
                properties: { action: { type: 'string' as const } },
            },
            requireUserConfirm: true,
            call: async (input: { action: string }) => {
                return `Executed action: ${input.action}`;
            },
        };

        const toolkit = new Toolkit({
            tools: [externalAndConfirmTool, confirmOnlyTool],
        });

        const model = new MockChatModel();
        const agent = new Agent({
            name: 'Friday',
            sysPrompt: 'You are a helpful assistant named Friday.',
            model: model,
            toolkit,
        });

        // Set mock content to simulate model output with two tool calls
        model.mockContent = [
            {
                type: 'tool_call',
                id: '1',
                name: 'ExternalAndConfirmTool',
                input: `{"command": "rm -rf /"}`,
                state: 'pending',
            },
            {
                type: 'tool_call',
                id: '2',
                name: 'ConfirmOnlyTool',
                input: `{"action": "delete database"}`,
                state: 'pending',
            },
        ];

        // Record the last event emitted by the agent
        let lastEvent: AgentEvent | null = null;
        for await (const event of agent.replyStream({})) {
            lastEvent = event;
        }

        // Verify the agent emits REQUIRE_USER_CONFIRM event for both tools
        expect(lastEvent).toMatchObject({
            type: EventType.REQUIRE_USER_CONFIRM,
            tool_calls: [
                {
                    type: 'tool_call',
                    id: '1',
                    name: 'ExternalAndConfirmTool',
                    input: '{"command": "rm -rf /"}',
                    state: 'asking',
                },
                {
                    type: 'tool_call',
                    id: '2',
                    name: 'ConfirmOnlyTool',
                    input: '{"action": "delete database"}',
                    state: 'asking',
                },
            ],
        });

        // Verify agent state
        expect(await agent.toJSON()).toMatchObject({
            reply_id: expect.any(String),
            confirmedToolCallIds: [],
            curIter: 0,
        });

        // Provide user confirmation for both tools
        for await (const event of agent.replyStream({
            event: {
                id: 'xxx',
                created_at: new Date().toISOString(),
                type: EventType.USER_CONFIRM_RESULT,
                reply_id: agent.replyId,
                confirm_results: [
                    {
                        confirmed: true,
                        tool_call: {
                            type: 'tool_call',
                            id: '1',
                            name: 'ExternalAndConfirmTool',
                            input: '{"command": "rm -rf /"}',
                            state: 'pending',
                        },
                    },
                    {
                        confirmed: true,
                        tool_call: {
                            type: 'tool_call',
                            id: '2',
                            name: 'ConfirmOnlyTool',
                            input: '{"action": "delete database"}',
                            state: 'pending',
                        },
                    },
                ],
            },
        })) {
            lastEvent = event;
        }

        // After user confirmation, the first tool requires external execution
        expect(lastEvent).toMatchObject({
            type: EventType.REQUIRE_EXTERNAL_EXECUTION,
            reply_id: expect.any(String),
            tool_calls: [
                {
                    type: 'tool_call',
                    id: '1',
                    name: 'ExternalAndConfirmTool',
                    input: '{"command": "rm -rf /"}',
                    state: 'allowed',
                },
            ],
        });

        // Verify agent state after user confirmation
        expect(await agent.toJSON()).toMatchObject({
            reply_id: expect.any(String),
            confirmedToolCallIds: ['1', '2'],
            curIter: 0,
        });

        // Verify the current agent context
        expect(agent.context.map(msg => msg.content)).toEqual([
            [
                {
                    id: '1',
                    input: '{"command": "rm -rf /"}',
                    name: 'ExternalAndConfirmTool',
                    type: 'tool_call',
                    state: 'allowed',
                },
                {
                    id: '2',
                    input: '{"action": "delete database"}',
                    name: 'ConfirmOnlyTool',
                    type: 'tool_call',
                    state: 'allowed',
                },
            ],
        ]);

        // Update mock content to return final text response
        model.mockContent = [{ type: 'text', text: 'All operations completed', id: 'abc' }];

        // Provide external execution result for the first tool
        for await (const event of agent.replyStream({
            event: {
                id: 'xxx',
                created_at: new Date().toISOString(),
                type: EventType.EXTERNAL_EXECUTION_RESULT,
                reply_id: agent.replyId,
                execution_results: [
                    {
                        type: 'tool_result',
                        id: '1',
                        name: 'ExternalAndConfirmTool',
                        output: [
                            {
                                id: expect.any(String),
                                type: 'text',
                                text: 'External command executed',
                            },
                        ],
                        state: 'success',
                    },
                ],
            },
        })) {
            lastEvent = event;
        }

        // After external execution, the second tool should execute directly
        // because it was already confirmed in the previous step
        expect(lastEvent).toMatchObject({
            id: expect.any(String),
            type: EventType.REPLY_END,
            created_at: expect.any(String),
            reply_id: agent.replyId,
        });

        // Verify the final agent context includes all tool calls, their results, and the final text
        expect(agent.context.map(msg => msg.content)).toEqual([
            [
                {
                    id: '1',
                    input: '{"command": "rm -rf /"}',
                    name: 'ExternalAndConfirmTool',
                    type: 'tool_call',
                    state: 'allowed',
                },
                {
                    id: '2',
                    input: '{"action": "delete database"}',
                    name: 'ConfirmOnlyTool',
                    type: 'tool_call',
                    state: 'allowed',
                },
                {
                    id: '1',
                    name: 'ExternalAndConfirmTool',
                    output: [
                        {
                            id: expect.any(String),
                            text: 'External command executed',
                            type: 'text',
                        },
                    ],
                    type: 'tool_result',
                    state: 'success',
                },
                {
                    id: '2',
                    name: 'ConfirmOnlyTool',
                    output: [
                        {
                            id: expect.any(String),
                            text: 'Executed action: delete database',
                            type: 'text',
                        },
                    ],
                    type: 'tool_result',
                    state: 'success',
                },
                {
                    id: expect.any(String),
                    type: 'text',
                    text: 'All operations completed',
                },
            ],
        ]);
    });
});
