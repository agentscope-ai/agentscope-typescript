import * as fs from 'fs';
import * as path from 'path';

import { z } from 'zod';

import { createToolResponse } from './response';
import { Toolkit } from './toolkit';

/**
 * A sample test tool function.
 * @param input
 * @param input.a
 * @param input.b
 * @returns ToolResponse
 */
function testFunction(input: { a: string; b: number }) {
    return createToolResponse({
        content: [
            { type: 'text', text: `Received a=${input.a}, b=${input.b}`, id: crypto.randomUUID() },
        ],
        state: 'success',
    });
}

describe('Toolkit', () => {
    test('Register and execute tool function with ZodObject schema', async () => {
        const toolkit = new Toolkit();
        toolkit.registerToolFunction({
            call: testFunction,
            name: 'test_function',
            description: 'A test function',
            inputSchema: z.object({
                a: z.string().max(200).describe('The first parameter'),
                b: z
                    .number()
                    .max(10)
                    .min(0)
                    .describe('The second parameter, a number between 0 and 10'),
            }),
            requireUserConfirm: false,
        });

        const schemas = toolkit.getJSONSchemas();
        expect(schemas).toEqual([
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
                type: 'function',
                function: {
                    name: 'test_function',
                    description: 'A test function',
                    parameters: {
                        additionalProperties: false,
                        type: 'object',
                        properties: {
                            a: {
                                type: 'string',
                                maxLength: 200,
                                description: 'The first parameter',
                            },
                            b: {
                                type: 'number',
                                maximum: 10,
                                minimum: 0,
                                description: 'The second parameter, a number between 0 and 10',
                            },
                        },
                        required: ['a', 'b'],
                    },
                },
            },
        ]);

        const gen = toolkit.callToolFunction({
            type: 'tool_call',
            name: 'test_function',
            input: '{"a":"hello","b":5}',
            state: 'pending',
            id: '1',
        });

        for await (const chunk of gen) {
            expect(chunk.content).toEqual([
                { id: expect.any(String), type: 'text', text: 'Received a=hello, b=5' },
            ]);
            expect(chunk.isLast).toBe(true);
        }
    });

    test('Register and execute tool function with ToolInputSchema', async () => {
        const toolkit = new Toolkit();
        toolkit.registerToolFunction({
            call: testFunction,
            name: 'test_function',
            description: 'A test function',
            inputSchema: {
                type: 'object',
                properties: {
                    a: { type: 'string', maxLength: 200 },
                    b: { type: 'number', maximum: 10, minimum: 0 },
                },
                required: ['a', 'b'],
            },
            requireUserConfirm: false,
        });

        const schemas = toolkit.getJSONSchemas();
        expect(schemas).toEqual([
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
                type: 'function',
                function: {
                    name: 'test_function',
                    description: 'A test function',
                    parameters: {
                        type: 'object',
                        properties: {
                            a: { type: 'string', maxLength: 200 },
                            b: { type: 'number', maximum: 10, minimum: 0 },
                        },
                        required: ['a', 'b'],
                    },
                },
            },
        ]);

        const gen = toolkit.callToolFunction({
            type: 'tool_call',
            name: 'test_function',
            input: '{"a":"hello","b":5}',
            state: 'pending',
            id: '1b',
        });

        for await (const chunk of gen) {
            expect(chunk.content).toEqual([
                { id: expect.any(String), type: 'text', text: 'Received a=hello, b=5' },
            ]);
            expect(chunk.isLast).toBe(true);
        }
    });

    test('None-parameter tool function', async () => {
        const toolkit = new Toolkit();
        toolkit.registerToolFunction({
            call: () =>
                createToolResponse({
                    content: [
                        { type: 'text', text: 'No parameters here', id: crypto.randomUUID() },
                    ],
                    state: 'success',
                }),
            name: 'no_param_function',
            description: 'A function with no parameters',
            inputSchema: z.object({}),
            requireUserConfirm: false,
        });

        const schemas = toolkit.getJSONSchemas();
        expect(schemas).toEqual([
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
                type: 'function',
                function: {
                    name: 'no_param_function',
                    description: 'A function with no parameters',
                    parameters: {
                        additionalProperties: false,
                        type: 'object',
                        properties: {},
                    },
                },
            },
        ]);

        const res = await toolkit.callToolFunction({
            type: 'tool_call',
            name: 'no_param_function',
            id: '2',
            input: '{}',
            state: 'pending',
        });

        for await (const chunk of res) {
            expect(chunk.content).toEqual([
                { id: expect.any(String), type: 'text', text: 'No parameters here' },
            ]);
        }
    });

    test('Sync generator tool function', async () => {
        const toolkit = new Toolkit();
        toolkit.registerToolFunction({
            call: function* (input: { count: number }) {
                for (let i = 0; i < input.count; i++) {
                    yield createToolResponse({
                        content: [{ type: 'text', text: `Count: ${i}`, id: crypto.randomUUID() }],
                        stream: true,
                        isLast: i === input.count - 1,
                        state: 'success',
                    });
                }
            },
            name: 'count_function',
            description: 'A function that counts up to a number',
            inputSchema: z.object({
                count: z.number().min(1).max(5).describe('The number to count up to'),
            }),
        });

        const gen = toolkit.callToolFunction({
            type: 'tool_call',
            name: 'count_function',
            id: '3',
            input: '{"count":3}',
            state: 'pending',
        });

        // Verify intermediate chunks
        const chunks = [];
        let finalRes;
        while (true) {
            const next = await gen.next();
            if (next.done) {
                finalRes = next.value;
                break;
            }
            chunks.push(next.value);
        }

        expect(chunks).toHaveLength(3);
        expect(chunks[0].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Count: 0' },
        ]);
        expect(chunks[0].isLast).toBe(false);
        expect(chunks[1].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Count: 1' },
        ]);
        expect(chunks[1].isLast).toBe(false);
        expect(chunks[2].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Count: 2' },
        ]);
        expect(chunks[2].isLast).toBe(true);

        // Verify final accumulated result
        expect(finalRes!.content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Count: 0Count: 1Count: 2' },
        ]);
        expect(finalRes!.isLast).toBe(true);
    });

    test('Async generator tool function', async () => {
        const toolkit = new Toolkit();
        toolkit.registerToolFunction({
            call: async function* (input: { count: number }) {
                for (let i = 0; i < input.count; i++) {
                    yield createToolResponse({
                        content: [
                            { type: 'text', text: `Async Count: ${i}`, id: crypto.randomUUID() },
                        ],
                        stream: true,
                        state: 'success',
                        isLast: i === input.count - 1,
                    });
                }
            },
            name: 'async_count_function',
            description: 'An async function that counts up to a number',
            inputSchema: z.object({
                count: z.number().min(1).max(5).describe('The number to count up to'),
            }),
        });

        const gen = toolkit.callToolFunction({
            type: 'tool_call',
            name: 'async_count_function',
            id: '4',
            input: '{"count":2}',
            state: 'pending',
        });

        // Verify intermediate chunks
        const chunks = [];
        let finalRes;
        while (true) {
            const next = await gen.next();
            if (next.done) {
                finalRes = next.value;
                break;
            }
            chunks.push(next.value);
        }

        expect(chunks).toHaveLength(2);
        expect(chunks[0].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Async Count: 0' },
        ]);
        expect(chunks[0].isLast).toBe(false);
        expect(chunks[1].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Async Count: 1' },
        ]);
        expect(chunks[1].isLast).toBe(true);

        // Verify final accumulated result
        expect(finalRes!.content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Async Count: 0Async Count: 1' },
        ]);
        expect(finalRes!.isLast).toBe(true);
    });

    test('Sync generator tool function returning string', async () => {
        const toolkit = new Toolkit();
        toolkit.registerToolFunction({
            call: function* (input: { count: number }) {
                for (let i = 0; i < input.count; i++) {
                    yield `Chunk: ${i}`;
                }
            },
            name: 'string_count_function',
            description: 'A function that yields strings',
            inputSchema: z.object({
                count: z.number().min(1).max(5).describe('The number to count up to'),
            }),
        });

        const gen = toolkit.callToolFunction({
            type: 'tool_call',
            name: 'string_count_function',
            id: '8',
            input: '{"count":3}',
            state: 'pending',
        });

        const chunks = [];
        let finalRes;
        while (true) {
            const next = await gen.next();
            if (next.done) {
                finalRes = next.value;
                break;
            }
            chunks.push(next.value);
        }

        expect(chunks).toHaveLength(3);
        expect(chunks[0].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Chunk: 0' },
        ]);
        expect(chunks[0].isLast).toBe(false);
        expect(chunks[1].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Chunk: 1' },
        ]);
        expect(chunks[1].isLast).toBe(false);
        expect(chunks[2].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Chunk: 2' },
        ]);
        expect(chunks[2].isLast).toBe(true);

        expect(finalRes!.content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Chunk: 0Chunk: 1Chunk: 2' },
        ]);
        expect(finalRes!.isLast).toBe(true);
    });

    test('Async generator tool function returning string', async () => {
        const toolkit = new Toolkit();
        toolkit.registerToolFunction({
            call: async function* (input: { count: number }) {
                for (let i = 0; i < input.count; i++) {
                    yield `Async Chunk: ${i}`;
                }
            },
            name: 'async_string_count_function',
            description: 'An async function that yields strings',
            inputSchema: z.object({
                count: z.number().min(1).max(5).describe('The number to count up to'),
            }),
        });

        const gen = toolkit.callToolFunction({
            type: 'tool_call',
            name: 'async_string_count_function',
            id: '9',
            input: '{"count":2}',
            state: 'pending',
        });

        const chunks = [];
        let finalRes;
        while (true) {
            const next = await gen.next();
            if (next.done) {
                finalRes = next.value;
                break;
            }
            chunks.push(next.value);
        }

        expect(chunks).toHaveLength(2);
        expect(chunks[0].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Async Chunk: 0' },
        ]);
        expect(chunks[0].isLast).toBe(false);
        expect(chunks[1].content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Async Chunk: 1' },
        ]);
        expect(chunks[1].isLast).toBe(true);

        expect(finalRes!.content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Async Chunk: 0Async Chunk: 1' },
        ]);
        expect(finalRes!.isLast).toBe(true);
    });

    test('Error conditions', async () => {
        const toolkit = new Toolkit();

        // Unregistered function
        const res = await toolkit.callToolFunction({
            type: 'tool_call',
            name: 'non_existent_function',
            id: '5',
            input: '{}',
            state: 'pending',
        });

        for await (const chunk of res) {
            expect(chunk.content).toEqual([
                {
                    id: expect.any(String),
                    type: 'text',
                    text: 'FunctionNotFoundError: Cannot find the function named non_existent_function',
                },
            ]);
        }

        // Wrong input with ZodObject schema
        toolkit.registerToolFunction({
            call: testFunction,
            name: 'test_function',
            description: 'A test function',
            inputSchema: z.object({
                a: z.string().max(200),
                b: z.number().max(10).min(0),
            }),
        });

        const res2 = await toolkit.callToolFunction({
            type: 'tool_call',
            name: 'test_function',
            id: '6',
            input: '{"a":"hello","b":20}',
            state: 'pending',
        });

        for await (const chunk of res2) {
            expect(chunk.content[0]).toEqual({
                id: expect.any(String),
                type: 'text',
                text: 'InvalidArgumentError: [\n  {\n    "origin": "number",\n    "code": "too_big",\n    "maximum": 10,\n    "inclusive": true,\n    "path": [\n      "b"\n    ],\n    "message": "Too big: expected number to be <=10"\n  }\n]',
            });
        }

        // Wrong input with ToolInputSchema (non-ZodObject)
        const toolkit2 = new Toolkit();
        toolkit2.registerToolFunction({
            call: testFunction,
            name: 'test_function',
            description: 'A test function',
            inputSchema: {
                type: 'object',
                properties: {
                    a: { type: 'string', maxLength: 200 },
                    b: { type: 'number', maximum: 10, minimum: 0 },
                },
                required: ['a', 'b'],
            },
        });

        const res3 = toolkit2.callToolFunction({
            type: 'tool_call',
            name: 'test_function',
            id: '7',
            input: '{"a":"hello","b":20}',
            state: 'pending',
        });

        for await (const chunk of res3) {
            expect(chunk.content[0].type).toBe('text');
            expect((chunk.content[0] as { type: 'text'; text: string }).text).toMatch(
                /InvalidArgumentError/
            );
        }
    });

    test('Skill tool with SKILL.md file', async () => {
        // Setup: Create a temporary skill directory and SKILL.md file
        const testSkillDir = path.join(__dirname, '__test_skill__');
        const skillMdPath = path.join(testSkillDir, 'SKILL.md');

        // Create the skill directory
        if (!fs.existsSync(testSkillDir)) {
            fs.mkdirSync(testSkillDir, { recursive: true });
        }

        // Write SKILL.md with YAML front matter
        const skillContent = `---
name: test_skill
description: A test skill for unit testing
---

# Test Skill

This is a test skill used for unit testing the Skill tool functionality.

## Usage

This skill demonstrates how to use the Skill tool to retrieve skill content.`;

        fs.writeFileSync(skillMdPath, skillContent, 'utf-8');

        try {
            // Initialize toolkit with builtInSkillTool enabled and register the test skill
            const toolkit = new Toolkit({
                builtInSkillTool: true,
                skills: [testSkillDir],
            });

            // Verify that the Skill tool is registered
            const schemas = toolkit.getJSONSchemas();
            const skillTool = schemas.find(schema => schema.function.name === 'Skill');
            expect(skillTool).toBeDefined();
            expect(skillTool?.function.description).toContain(
                'Retrieves the full content of a skill'
            );

            // Call the Skill tool with the test skill name
            const gen = toolkit.callToolFunction({
                type: 'tool_call',
                name: 'Skill',
                input: '{"name":"test_skill"}',
                state: 'pending',
                id: 'skill_test_1',
            });

            // Verify the response
            let finalRes;
            for await (const chunk of gen) {
                finalRes = chunk;
            }

            expect(finalRes).toBeDefined();
            expect(finalRes!.state).toBe('success');
            expect(finalRes!.content).toHaveLength(1);
            expect(finalRes!.content[0].type).toBe('text');
            expect((finalRes!.content[0] as { type: 'text'; text: string }).text).toContain(
                'name: test_skill'
            );
            expect((finalRes!.content[0] as { type: 'text'; text: string }).text).toContain(
                'description: A test skill for unit testing'
            );
            expect((finalRes!.content[0] as { type: 'text'; text: string }).text).toContain(
                'This is a test skill used for unit testing'
            );

            // Test error case: non-existent skill
            const errorGen = toolkit.callToolFunction({
                type: 'tool_call',
                name: 'Skill',
                input: '{"name":"non_existent_skill"}',
                state: 'pending',
                id: 'skill_test_2',
            });

            let errorRes;
            for await (const chunk of errorGen) {
                errorRes = chunk;
            }

            expect(errorRes).toBeDefined();
            expect(errorRes!.state).toBe('error');
            expect((errorRes!.content[0] as { type: 'text'; text: string }).text).toContain(
                'SkillNotFoundError'
            );
        } finally {
            // Cleanup: Remove the test skill directory
            if (fs.existsSync(skillMdPath)) {
                fs.unlinkSync(skillMdPath);
            }
            if (fs.existsSync(testSkillDir)) {
                fs.rmdirSync(testSkillDir);
            }
        }
    });
});
