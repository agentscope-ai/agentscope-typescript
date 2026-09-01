/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    AgenticMemoryMiddleware,
    AgenticMemoryParameters,
    DEFAULT_MEMORY_INSTRUCTIONS,
} from './agentic-memory';
import type { Agent } from '../agent';
import { UserMsg, type Msg } from '../message';
import { StructuredResponse, type ChatModelBase } from '../model';

describe('AgenticMemoryMiddleware Python parity', () => {
    let workdir: string;

    beforeEach(async () => {
        workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-memory-'));
    });

    afterEach(async () => {
        await fs.rm(workdir, { recursive: true, force: true });
    });

    test('parameters preserve Python defaults, aliases, and frozen values', () => {
        const defaults = new AgenticMemoryParameters();
        const aliased = new AgenticMemoryParameters({
            memory_max_tokens: 12,
            retrieval_async: false,
            retrieval_max_tokens_per_md: 13,
            retrieval_max_files: 14,
            retrieval_max_tokens_per_frontmatter: 15,
        });

        expect(defaults.toJSON()).toEqual({
            memory_max_tokens: 4_000,
            memory_instructions: DEFAULT_MEMORY_INSTRUCTIONS,
            retrieval_async: true,
            retrieval_model: null,
            retrieval_max_tokens_per_md: 2_000,
            retrieval_max_files: 200,
            retrieval_max_tokens_per_frontmatter: 256,
            retrieval_instructions: expect.any(String),
        });
        expect(aliased.toJSON()).toEqual({
            memory_max_tokens: 12,
            memory_instructions: DEFAULT_MEMORY_INSTRUCTIONS,
            retrieval_async: false,
            retrieval_model: null,
            retrieval_max_tokens_per_md: 13,
            retrieval_max_files: 14,
            retrieval_max_tokens_per_frontmatter: 15,
            retrieval_instructions: expect.any(String),
        });
        expect(Object.isFrozen(defaults)).toBe(true);
    });

    test('truncateIfNeeded follows the shared token heuristic', () => {
        expect(AgenticMemoryMiddleware.truncateIfNeeded('short', 100)).toBe('short');
        expect(AgenticMemoryMiddleware.truncateIfNeeded('anything', 0)).toBe('');
        const truncated = AgenticMemoryMiddleware.truncateIfNeeded('0123456789'.repeat(80), 10);
        expect(truncated.length).toBeGreaterThan(0);
        expect(truncated.length).toBeLessThan(800);
    });

    test('system prompt creates layout and injects an empty MEMORY.md snapshot', async () => {
        const middleware = new AgenticMemoryMiddleware({ workdir });
        const prompt = await middleware.onSystemPrompt({} as Agent, 'You are helpful.');
        const memoryDir = path.join(workdir, 'Memory');

        await expect(fs.stat(memoryDir)).resolves.toEqual(
            expect.objectContaining({ isDirectory: expect.any(Function) })
        );
        await expect(fs.readFile(path.join(memoryDir, 'MEMORY.md'), 'utf8')).resolves.toBe('');
        expect(prompt).toContain(memoryDir);
        expect(prompt).not.toContain('{memory_dir}');
        expect(prompt).toContain('## MEMORY.md');
        expect(prompt).toContain('Your MEMORY.md is currently empty');
    });

    test('system prompt includes the Python truncation reminder and read offset', async () => {
        const memoryDir = path.join(workdir, 'Memory');
        await fs.mkdir(memoryDir, { recursive: true });
        await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), '0123456789'.repeat(80));
        const middleware = new AgenticMemoryMiddleware({
            workdir,
            parameters: { memory_max_tokens: 10, retrieval_async: false },
        });

        const prompt = await middleware.onSystemPrompt({} as Agent, 'base');

        expect(prompt).toContain('<<<TRUNCATED>>>');
        expect(prompt).toContain('Use the `Read` tool with offset');
        expect(prompt).toContain(path.join(memoryDir, 'MEMORY.md'));
    });

    test('retrieval injects one selected memory and filters hallucinated filenames', async () => {
        await writeMemory(
            workdir,
            'user_profile.md',
            'User profile details',
            'user',
            'The user prefers concise Chinese answers.'
        );
        const calls: Msg[][] = [];
        const model = modelWithSelection(['user_profile.md', 'missing.md'], calls);
        const { agent, appended } = fakeAgent(model);
        const middleware = new AgenticMemoryMiddleware({ workdir });
        const reply = middleware.onReply(
            agent,
            { inputs: UserMsg({ name: 'user', content: 'what do you remember?' }) },
            suspendedDownstream
        );

        await reply.next();
        await pollReasoning(middleware, agent, appended);
        await reply.return();

        expect(calls).toHaveLength(1);
        expect(calls[0].map(message => message.role)).toEqual(['system', 'user']);
        expect(calls[0][1].content[0]).toEqual(
            expect.objectContaining({
                type: 'text',
                text: expect.stringContaining(
                    'Query: user: what do you remember?\n\nAvailable memories:'
                ),
            })
        );
        expect(appended).toHaveLength(1);
        expect(appended[0]).toEqual({
            name: 'assistant',
            blocks: [
                expect.objectContaining({
                    type: 'hint',
                    hint: expect.stringContaining('The user prefers concise Chinese answers.'),
                }),
            ],
        });
        expect(String(appended[0].blocks[0].hint)).not.toContain('missing.md');
    });

    test('empty selection does not inject a hint', async () => {
        await writeMemory(workdir, 'available.md', 'Available', 'project', 'Not selected.');
        const model = modelWithSelection([], []);
        const { agent, appended } = fakeAgent(model);
        const middleware = new AgenticMemoryMiddleware({ workdir });
        const reply = middleware.onReply(
            agent,
            { inputs: UserMsg({ name: 'user', content: 'ignore memories' }) },
            suspendedDownstream
        );

        await reply.next();
        await pollReasoning(middleware, agent, appended, false);
        await reply.return();

        expect(appended).toEqual([]);
    });

    test('index-only layout skips structured retrieval entirely', async () => {
        const calls: Msg[][] = [];
        const model = modelWithSelection(['missing.md'], calls);
        const { agent, appended } = fakeAgent(model);
        const middleware = new AgenticMemoryMiddleware({ workdir });
        const reply = middleware.onReply(
            agent,
            { inputs: UserMsg({ name: 'user', content: 'hello' }) },
            suspendedDownstream
        );

        await reply.next();
        await pollReasoning(middleware, agent, appended, false);
        await reply.return();

        expect(calls).toEqual([]);
        await expect(fs.readFile(path.join(workdir, 'Memory', 'MEMORY.md'), 'utf8')).resolves.toBe(
            ''
        );
        expect(appended).toEqual([]);
    });

    test('retrieval_async false never invokes the retrieval model', async () => {
        await writeMemory(workdir, 'available.md', 'Available', 'project', 'Never loaded.');
        const calls: Msg[][] = [];
        const model = modelWithSelection(['available.md'], calls);
        const { agent, appended } = fakeAgent(model);
        const middleware = new AgenticMemoryMiddleware({
            workdir,
            parameters: { retrieval_async: false },
        });
        const reply = middleware.onReply(
            agent,
            { inputs: UserMsg({ name: 'user', content: 'remember?' }) },
            suspendedDownstream
        );

        await reply.next();
        await pollReasoning(middleware, agent, appended, false);
        await reply.return();

        expect(calls).toEqual([]);
        expect(appended).toEqual([]);
    });

    test('frontmatter parser only accepts a leading scalar block', () => {
        expect(
            AgenticMemoryMiddleware.parseFrontmatterFields(
                '---\nname: profile\ndescription: Recall this\ntype: user\n---\nbody'
            )
        ).toEqual({
            name: 'profile',
            description: 'Recall this',
            type: 'user',
        });
        expect(
            AgenticMemoryMiddleware.parseFrontmatterFields(
                'prefix\n---\ndescription: ignored\n---\n'
            )
        ).toEqual({});
    });

    test('manifest formats type, local date, description, and unknown mtime', () => {
        const local = new Date(2026, 8, 1, 12).getTime() / 1_000;
        expect(
            AgenticMemoryMiddleware.formatManifest([
                {
                    filename: 'profile.md',
                    path: '/Memory/profile.md',
                    description: 'Recall this',
                    type: 'user',
                    mtime: local,
                },
                {
                    filename: 'plain.md',
                    path: '/Memory/plain.md',
                    description: null,
                    type: null,
                    mtime: null,
                },
            ])
        ).toBe('- [user] profile.md (2026-09-01): Recall this\n- plain.md (unknown)');
    });
});

async function writeMemory(
    workdir: string,
    filename: string,
    description: string,
    type: string,
    body: string
): Promise<void> {
    const memoryDir = path.join(workdir, 'Memory');
    await fs.mkdir(path.dirname(path.join(memoryDir, filename)), { recursive: true });
    await fs.writeFile(
        path.join(memoryDir, filename),
        `---\nname: ${filename}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`
    );
}

function modelWithSelection(selected: string[], calls: Msg[][]): ChatModelBase {
    return {
        generateStructuredOutput: jest.fn(async ({ messages }: { messages: Msg[] }) => {
            calls.push(messages);
            return new StructuredResponse({ content: { selected_files: selected } });
        }),
    } as unknown as ChatModelBase;
}

function fakeAgent(model: ChatModelBase): {
    agent: Agent;
    appended: Array<{ name: string; blocks: Array<{ hint?: unknown }> }>;
} {
    const appended: Array<{ name: string; blocks: Array<{ hint?: unknown }> }> = [];
    const agent = {
        name: 'assistant',
        model,
        state: {
            appendContext: (value: { name: string; blocks: Array<{ hint?: unknown }> }) => {
                appended.push(value);
            },
        },
    } as unknown as Agent;
    return { agent, appended };
}

async function* suspendedDownstream(): AsyncGenerator<Msg, void> {
    yield UserMsg({ name: 'downstream', content: 'suspended' });
}

async function pollReasoning(
    middleware: AgenticMemoryMiddleware,
    agent: Agent,
    appended: unknown[],
    expectHint = true
): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const stream = middleware.onReasoning(agent, {}, async function* () {});
        await stream.next();
        if (appended.length > 0) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    if (expectHint) throw new Error('Retrieval did not produce a hint in time.');
}
