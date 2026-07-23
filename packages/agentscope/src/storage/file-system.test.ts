import fs from 'fs';
import path from 'path';

import { LocalFileStorage } from './file-system';
import { createMsg } from '../message';

describe('LocalFileStorage', () => {
    const testDir = path.join(__dirname, '.test-storage');
    const createdAt = '2024-01-01T00:00:00.000Z';
    let storage: LocalFileStorage;

    beforeEach(() => {
        // Clean up test directory before each test
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        storage = new LocalFileStorage({ pathSegments: [testDir, 'test-user', 'test-session'] });
    });

    afterEach(() => {
        // Clean up test directory after each test
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('Basic save and load', () => {
        it('should save and load agent state correctly', async () => {
            const context = [
                createMsg({
                    name: 'user',
                    content: [{ type: 'text', text: 'Hello', id: 'text-1', created_at: createdAt }],
                    role: 'user',
                }),
                createMsg({
                    name: 'assistant',
                    content: [
                        { type: 'text', text: 'Hi there!', id: 'text-2', created_at: createdAt },
                    ],
                    role: 'assistant',
                }),
            ];

            const metadata = {
                replyId: 'reply-123',
                curIter: 1,
                curSummary: '',
            };

            // Save state
            await storage.saveAgentState({
                agentId: 'agent-1',
                context,
                metadata,
            });

            // Load state
            const loaded = await storage.loadAgentState({ agentId: 'agent-1' });

            expect(loaded.context).toHaveLength(2);
            expect(loaded.context[0].content[0]).toEqual({
                type: 'text',
                text: 'Hello',
                id: 'text-1',
                created_at: createdAt,
            });
            expect(loaded.context[1].content[0]).toEqual({
                type: 'text',
                text: 'Hi there!',
                id: 'text-2',
                created_at: createdAt,
            });
            expect(loaded.metadata.replyId).toBe('reply-123');
            expect(loaded.metadata.curIter).toBe(1);
        });

        it('should return empty state when loading non-existent agent', async () => {
            const loaded = await storage.loadAgentState({ agentId: 'non-existent' });

            expect(loaded.context).toEqual([]);
            expect(loaded.metadata).toEqual({});
        });

        it('should handle incremental context updates', async () => {
            const msg1 = createMsg({
                name: 'user',
                content: [{ type: 'text', text: 'Message 1', id: 'text-3', created_at: createdAt }],
                role: 'user',
            });
            const msg2 = createMsg({
                name: 'assistant',
                content: [
                    { type: 'text', text: 'Response 1', id: 'text-4', created_at: createdAt },
                ],
                role: 'assistant',
            });
            const msg3 = createMsg({
                name: 'user',
                content: [{ type: 'text', text: 'Message 2', id: 'text-5', created_at: createdAt }],
                role: 'user',
            });

            // First save
            await storage.saveAgentState({
                agentId: 'agent-1',
                context: [msg1, msg2],
                metadata: { replyId: 'reply-1' },
            });

            // Second save with additional message
            await storage.saveAgentState({
                agentId: 'agent-1',
                context: [msg1, msg2, msg3],
                metadata: { replyId: 'reply-2' },
            });

            // Load and verify all messages are present
            const loaded = await storage.loadAgentState({ agentId: 'agent-1' });
            expect(loaded.context).toHaveLength(3);
            expect(loaded.context[2].content[0]).toEqual({
                type: 'text',
                text: 'Message 2',
                id: 'text-5',
                created_at: createdAt,
            });
        });
    });

    describe('Compression support', () => {
        it('should store full history but load only from compression boundary', async () => {
            // Create 10 messages
            const allMessages = Array.from({ length: 10 }, (_, i) =>
                createMsg({
                    name: i % 2 === 0 ? 'user' : 'assistant',
                    content: [
                        {
                            type: 'text',
                            text: `Message ${i + 1}`,
                            id: `text-${i + 6}`,
                            created_at: createdAt,
                        },
                    ],
                    role: i % 2 === 0 ? 'user' : 'assistant',
                })
            );

            // First save: all 10 messages
            await storage.saveAgentState({
                agentId: 'agent-1',
                context: allMessages,
                metadata: {
                    replyId: 'reply-1',
                    curIter: 5,
                    curSummary: '',
                },
            });

            // Verify all messages are saved to file
            const contextFile = path.join(
                testDir,
                'test-user',
                'test-session',
                'agent-1',
                'context.jsonl'
            );
            const fileContent = fs.readFileSync(contextFile, 'utf-8');
            const savedMessages = fileContent.trim().split('\n');
            expect(savedMessages).toHaveLength(10);

            // Simulate compression: agent only keeps last 3 messages
            const compressedContext = allMessages.slice(7); // Messages 8, 9, 10

            // Second save: only 3 messages (after compression)
            await storage.saveAgentState({
                agentId: 'agent-1',
                context: compressedContext,
                metadata: {
                    replyId: 'reply-2',
                    curIter: 6,
                    curSummary: '<system-info>Summary of messages 1-7</system-info>',
                },
            });

            // Verify file still contains all 10 messages (full history preserved)
            const updatedFileContent = fs.readFileSync(contextFile, 'utf-8');
            const allSavedMessages = updatedFileContent.trim().split('\n');
            expect(allSavedMessages).toHaveLength(10);

            // Load state: should only get messages from compression boundary (last 3)
            const loaded = await storage.loadAgentState({ agentId: 'agent-1' });
            expect(loaded.context).toHaveLength(3);
            expect(loaded.context[0].content[0]).toEqual({
                type: 'text',
                text: 'Message 8',
                id: 'text-13',
                created_at: createdAt,
            });
            expect(loaded.context[1].content[0]).toEqual({
                type: 'text',
                text: 'Message 9',
                id: 'text-14',
                created_at: createdAt,
            });
            expect(loaded.context[2].content[0]).toEqual({
                type: 'text',
                text: 'Message 10',
                id: 'text-15',
                created_at: createdAt,
            });
            expect(loaded.metadata.curSummary).toBe(
                '<system-info>Summary of messages 1-7</system-info>'
            );
        });

        it('should handle multiple compression cycles', async () => {
            // First cycle: 5 messages
            const batch1 = Array.from({ length: 5 }, (_, i) =>
                createMsg({
                    name: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `Batch 1 Message ${i + 1}`,
                            id: `text-${i + 16}`,
                            created_at: createdAt,
                        },
                    ],
                    role: 'user',
                })
            );

            await storage.saveAgentState({
                agentId: 'agent-1',
                context: batch1,
                metadata: { replyId: 'reply-1' },
            });

            // First compression: keep last 2
            await storage.saveAgentState({
                agentId: 'agent-1',
                context: batch1.slice(3),
                metadata: { replyId: 'reply-2', curSummary: 'Summary 1' },
            });

            // Add more messages
            const batch2 = [
                ...batch1.slice(3),
                ...Array.from({ length: 5 }, (_, i) =>
                    createMsg({
                        name: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Batch 2 Message ${i + 1}`,
                                id: `text-${i + 21}`,
                                created_at: createdAt,
                            },
                        ],
                        role: 'user',
                    })
                ),
            ];

            await storage.saveAgentState({
                agentId: 'agent-1',
                context: batch2,
                metadata: { replyId: 'reply-3' },
            });

            // Second compression: keep last 3
            await storage.saveAgentState({
                agentId: 'agent-1',
                context: batch2.slice(-3),
                metadata: { replyId: 'reply-4', curSummary: 'Summary 2' },
            });

            // Load and verify only last 3 messages are returned
            const loaded = await storage.loadAgentState({ agentId: 'agent-1' });
            expect(loaded.context).toHaveLength(3);
            expect(loaded.context[0].content[0]).toEqual({
                type: 'text',
                text: 'Batch 2 Message 3',
                id: 'text-23',
                created_at: createdAt,
            });
            expect(loaded.metadata.curSummary).toBe('Summary 2');
        });

        it('should not expose internal storage fields to agent layer', async () => {
            const context = [
                createMsg({
                    name: 'user',
                    content: [{ type: 'text', text: 'Test', id: 'text-26', created_at: createdAt }],
                    role: 'user',
                }),
            ];

            await storage.saveAgentState({
                agentId: 'agent-1',
                context,
                metadata: { replyId: 'reply-1' },
            });

            // Check that internal field is saved in file
            const stateFile = path.join(
                testDir,
                'test-user',
                'test-session',
                'agent-1',
                'state.json'
            );
            const fileContent = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            expect(fileContent).toHaveProperty('_storage_compressionBoundaryMsgId');

            // Check that internal field is filtered out when loading
            const loaded = await storage.loadAgentState({ agentId: 'agent-1' });
            expect(loaded.metadata).not.toHaveProperty('_storage_compressionBoundaryMsgId');
            expect(loaded.metadata.replyId).toBe('reply-1');
        });
    });

    describe('Multiple agents', () => {
        it('should handle multiple agents independently', async () => {
            const agent1Context = [
                createMsg({
                    name: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Agent 1 message',
                            id: 'text-27',
                            created_at: createdAt,
                        },
                    ],
                    role: 'user',
                }),
            ];
            const agent2Context = [
                createMsg({
                    name: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Agent 2 message',
                            id: 'text-28',
                            created_at: createdAt,
                        },
                    ],
                    role: 'user',
                }),
            ];

            await storage.saveAgentState({
                agentId: 'agent-1',
                context: agent1Context,
                metadata: { replyId: 'reply-1' },
            });

            await storage.saveAgentState({
                agentId: 'agent-2',
                context: agent2Context,
                metadata: { replyId: 'reply-2' },
            });

            const loaded1 = await storage.loadAgentState({ agentId: 'agent-1' });
            const loaded2 = await storage.loadAgentState({ agentId: 'agent-2' });

            expect(loaded1.context[0].content[0]).toEqual({
                type: 'text',
                text: 'Agent 1 message',
                id: 'text-27',
                created_at: createdAt,
            });
            expect(loaded2.context[0].content[0]).toEqual({
                type: 'text',
                text: 'Agent 2 message',
                id: 'text-28',
                created_at: createdAt,
            });
            expect(loaded1.metadata.replyId).toBe('reply-1');
            expect(loaded2.metadata.replyId).toBe('reply-2');
        });
    });

    describe('Context offloading', () => {
        it('should return undefined when offloadDir is not configured', async () => {
            const msgs = [
                createMsg({
                    name: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Test message',
                            id: 'text-29',
                            created_at: createdAt,
                        },
                    ],
                    role: 'user',
                }),
            ];

            const result = await storage.offloadContext({ agentId: 'agent-1', msgs });
            expect(result).toBeUndefined();
        });

        it('should offload text messages to a date-based file', async () => {
            const offloadDir = path.join(testDir, 'offload');
            const storageWithOffload = new LocalFileStorage({
                pathSegments: [testDir, 'test-user', 'test-session'],
                offloadPathSegments: [offloadDir, 'test-user', 'test-session'],
            });

            const msgs = [
                createMsg({
                    name: 'user',
                    content: [
                        { type: 'text', text: 'Hello world', id: 'text-30', created_at: createdAt },
                    ],
                    role: 'user',
                }),
                createMsg({
                    name: 'assistant',
                    content: [
                        { type: 'text', text: 'Hi there!', id: 'text-31', created_at: createdAt },
                    ],
                    role: 'assistant',
                }),
            ];

            const offloadPath = await storageWithOffload.offloadContext({
                agentId: 'agent-1',
                msgs,
            });

            expect(offloadPath).toBeDefined();
            expect(fs.existsSync(offloadPath!)).toBe(true);

            const content = fs.readFileSync(offloadPath!, 'utf-8');
            expect(content).toContain('user: Hello world');
            expect(content).toContain('assistant: Hi there!');
        });

        it('should append to existing offload file on same day', async () => {
            const offloadDir = path.join(testDir, 'offload');
            const storageWithOffload = new LocalFileStorage({
                pathSegments: [testDir, 'test-user', 'test-session'],
                offloadPathSegments: [offloadDir, 'test-user', 'test-session'],
            });

            const msgs1 = [
                createMsg({
                    name: 'user',
                    content: [
                        { type: 'text', text: 'First batch', id: 'text-32', created_at: createdAt },
                    ],
                    role: 'user',
                }),
            ];

            const msgs2 = [
                createMsg({
                    name: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Second batch',
                            id: 'text-33',
                            created_at: createdAt,
                        },
                    ],
                    role: 'user',
                }),
            ];

            const path1 = await storageWithOffload.offloadContext({
                agentId: 'agent-1',
                msgs: msgs1,
            });
            const path2 = await storageWithOffload.offloadContext({
                agentId: 'agent-1',
                msgs: msgs2,
            });

            expect(path1).toBe(path2);

            const content = fs.readFileSync(path1!, 'utf-8');
            expect(content).toContain('First batch');
            expect(content).toContain('Second batch');
        });

        it('should handle data blocks with URL source', async () => {
            const offloadDir = path.join(testDir, 'offload');
            const storageWithOffload = new LocalFileStorage({
                pathSegments: [testDir, 'test-user', 'test-session'],
                offloadPathSegments: [offloadDir, 'test-user', 'test-session'],
            });

            const msgs = [
                createMsg({
                    name: 'user',
                    content: [
                        {
                            type: 'data',
                            id: 'data-1',
                            created_at: createdAt,
                            source: {
                                type: 'url',
                                url: 'https://example.com/image.png',
                                media_type: 'image/png',
                            },
                        },
                    ],
                    role: 'user',
                }),
            ];

            const offloadPath = await storageWithOffload.offloadContext({
                agentId: 'agent-1',
                msgs,
            });

            const content = fs.readFileSync(offloadPath!, 'utf-8');
            expect(content).toContain(
                '<data src={https://example.com/image.png} type={image/png} />'
            );
        });

        it('should handle data blocks with base64 source', async () => {
            const offloadDir = path.join(testDir, 'offload');
            const storageWithOffload = new LocalFileStorage({
                pathSegments: [testDir, 'test-user', 'test-session'],
                offloadPathSegments: [offloadDir, 'test-user', 'test-session'],
            });

            // Create a simple base64 encoded text
            const base64Data = Buffer.from('Hello, World!').toString('base64');

            const msgs = [
                createMsg({
                    name: 'user',
                    content: [
                        {
                            type: 'data',
                            id: 'data-2',
                            created_at: createdAt,
                            source: {
                                type: 'base64',
                                data: base64Data,
                                media_type: 'text/plain',
                            },
                        },
                    ],
                    role: 'user',
                }),
            ];

            const offloadPath = await storageWithOffload.offloadContext({
                agentId: 'agent-1',
                msgs,
            });

            const content = fs.readFileSync(offloadPath!, 'utf-8');
            expect(content).toMatch(/user: <data src=\{.*\.txt\} type=\{text\/plain\} \/>/);

            // Verify the data file was created
            const dataDir = path.join(offloadDir, 'test-user', 'test-session', 'agent-1', 'data');
            expect(fs.existsSync(dataDir)).toBe(true);

            const dataFiles = fs.readdirSync(dataDir);
            expect(dataFiles.length).toBeGreaterThan(0);
            expect(dataFiles[0]).toMatch(/text-\d+\.txt/);

            // Verify the content of the data file
            const dataFilePath = path.join(dataDir, dataFiles[0]);
            const dataContent = fs.readFileSync(dataFilePath, 'utf-8');
            expect(dataContent).toBe('Hello, World!');
        });

        it('should handle tool_call blocks', async () => {
            const offloadDir = path.join(testDir, 'offload');
            const storageWithOffload = new LocalFileStorage({
                pathSegments: [testDir, 'test-user', 'test-session'],
                offloadPathSegments: [offloadDir, 'test-user', 'test-session'],
            });

            const msgs = [
                createMsg({
                    name: 'assistant',
                    content: [
                        {
                            type: 'tool_call',
                            id: 'call-123',
                            created_at: createdAt,
                            name: 'search',
                            input: JSON.stringify({ query: 'test' }),
                            state: 'pending',
                        },
                    ],
                    role: 'assistant',
                }),
            ];

            const offloadPath = await storageWithOffload.offloadContext({
                agentId: 'agent-1',
                msgs,
            });

            const content = fs.readFileSync(offloadPath!, 'utf-8');
            expect(content).toContain('assistant: Calling tool search ...');
        });

        it('should handle mixed content types in a single message', async () => {
            const offloadDir = path.join(testDir, 'offload');
            const storageWithOffload = new LocalFileStorage({
                pathSegments: [testDir, 'test-user', 'test-session'],
                offloadPathSegments: [offloadDir, 'test-user', 'test-session'],
            });

            const msgs = [
                createMsg({
                    name: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Here is an image:',
                            id: 'text-34',
                            created_at: createdAt,
                        },
                        {
                            type: 'data',
                            id: 'data-3',
                            created_at: createdAt,
                            source: {
                                type: 'url',
                                url: 'https://example.com/image.png',
                                media_type: 'image/png',
                            },
                        },
                        {
                            type: 'text',
                            text: 'What do you see?',
                            id: 'text-35',
                            created_at: createdAt,
                        },
                    ],
                    role: 'user',
                }),
            ];

            const offloadPath = await storageWithOffload.offloadContext({
                agentId: 'agent-1',
                msgs,
            });

            const content = fs.readFileSync(offloadPath!, 'utf-8');
            expect(content).toContain('user: Here is an image:');
            expect(content).toContain(
                '<data src={https://example.com/image.png} type={image/png} />'
            );
            expect(content).toContain('user: What do you see?');
        });
    });
});
