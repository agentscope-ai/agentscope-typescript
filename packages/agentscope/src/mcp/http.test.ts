import { HTTPMCPClient } from './http';
import { Toolkit } from '../tool';

describe('HTTPStatefulMCPClient', () => {
    test('Create AMAP MCP client, list and execute tools', async () => {
        const client = new HTTPMCPClient({
            name: 'amap-map-service',
            transportType: 'streamable-http',
            url: 'https://mcp.amap.com/mcp?key=' + process.env.GAODE_API_KEY || '',
            stateful: true,
        });
        await client.connect();

        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);
        const func = await client.getCallableFunction({ name: 'maps_geo' });
        const res = await func.call({ address: 'Tiananmen', city: 'Beijing' });
        expect(res.content.length).toBeGreaterThan(0);
        await client.close();

        // Try to reconnect and list tools again
        await client.connect();
        const tools2 = await client.listTools();
        expect(tools2.length).toBeGreaterThan(0);

        await client.close();
    }, 10000);

    test('Test toolkit works with HTTPStatefulMCPClient', async () => {
        const client = new HTTPMCPClient({
            name: 'amap-map-service',
            transportType: 'streamable-http',
            url: 'https://mcp.amap.com/mcp?key=' + process.env.GAODE_API_KEY || '',
            stateful: true,
        });
        await client.connect();

        const toolkit = new Toolkit();
        await toolkit.registerMCPClient({ client, enabledTools: ['maps_geo'] });

        const schema = toolkit.getJSONSchemas();
        expect(schema).toEqual([
            {
                function: {
                    description:
                        'Retrieves the full content of a skill by reading its SKILL.md file. Skills are packages of domain expertise that extend agent capabilities. Use this tool to access detailed instructions, examples, and guidelines for a specific skill.\n\nUsage:\n- Provide the skill name as the input parameter\n- The tool will return the complete SKILL.md file content for that skill\n- If the skill is not found, an error message with available skills will be returned\n- Available skills are listed in the skills-system section of the agent prompt',
                    name: 'Skill',
                    parameters: {
                        additionalProperties: false,
                        properties: {
                            name: {
                                description: 'The name of the skill',
                                type: 'string',
                            },
                        },
                        required: ['name'],
                        type: 'object',
                    },
                },
                type: 'function',
            },
            {
                function: {
                    description:
                        '将详细的结构化地址转换为经纬度坐标。支持对地标性名胜景区、建筑物名称解析为经纬度坐标',
                    name: 'maps_geo',
                    parameters: {
                        properties: {
                            address: {
                                description: '待解析的结构化地址信息',
                                type: 'string',
                            },
                            city: {
                                description: '指定查询的城市',
                                type: 'string',
                            },
                        },
                        required: ['address'],
                        type: 'object',
                    },
                },
                type: 'function',
            },
        ]);

        const res = toolkit.callToolFunction({
            id: '123',
            name: 'maps_geo',
            type: 'tool_call',
            input: `{"address": "Tiananmen", "city": "Beijing"}`,
        });
        for await (const item of res) {
            console.log(item);
        }

        await client.close();
    }, 10000);
});

describe('HTTPStatelessMCPClient', () => {
    test('Create stateless AMAP MCP client, list and execute tools without explicit connect/close', async () => {
        const client = new HTTPMCPClient({
            name: 'amap-map-service',
            transportType: 'streamable-http',
            url: 'https://mcp.amap.com/mcp?key=' + process.env.GAODE_API_KEY || '',
            stateful: false,
        });

        // connect() and close() are no-ops for stateless clients
        await client.connect();

        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);

        const func = await client.getCallableFunction({ name: 'maps_geo' });
        const res = await func.call({ address: 'Tiananmen', city: 'Beijing' });
        expect(res.content.length).toBeGreaterThan(0);

        await client.close();
    }, 10000);

    test('Test toolkit works with HTTPStatelessMCPClient', async () => {
        const client = new HTTPMCPClient({
            name: 'amap-map-service',
            transportType: 'streamable-http',
            url: 'https://mcp.amap.com/mcp?key=' + process.env.GAODE_API_KEY || '',
            stateful: false,
        });

        const toolkit = new Toolkit();
        await toolkit.registerMCPClient({ client, enabledTools: ['maps_geo'] });

        const schema = toolkit.getJSONSchemas();
        expect(schema).toEqual([
            {
                function: {
                    description:
                        'Retrieves the full content of a skill by reading its SKILL.md file. Skills are packages of domain expertise that extend agent capabilities. Use this tool to access detailed instructions, examples, and guidelines for a specific skill.\n\nUsage:\n- Provide the skill name as the input parameter\n- The tool will return the complete SKILL.md file content for that skill\n- If the skill is not found, an error message with available skills will be returned\n- Available skills are listed in the skills-system section of the agent prompt',
                    name: 'Skill',
                    parameters: {
                        additionalProperties: false,
                        properties: {
                            name: {
                                description: 'The name of the skill',
                                type: 'string',
                            },
                        },
                        required: ['name'],
                        type: 'object',
                    },
                },
                type: 'function',
            },
            {
                function: {
                    description:
                        '将详细的结构化地址转换为经纬度坐标。支持对地标性名胜景区、建筑物名称解析为经纬度坐标',
                    name: 'maps_geo',
                    parameters: {
                        properties: {
                            address: {
                                description: '待解析的结构化地址信息',
                                type: 'string',
                            },
                            city: {
                                description: '指定查询的城市',
                                type: 'string',
                            },
                        },
                        required: ['address'],
                        type: 'object',
                    },
                },
                type: 'function',
            },
        ]);

        const res = toolkit.callToolFunction({
            id: '123',
            name: 'maps_geo',
            type: 'tool_call',
            input: `{"address": "Tiananmen", "city": "Beijing"}`,
        });
        for await (const item of res) {
            console.log(item);
        }
    }, 10000);
});
