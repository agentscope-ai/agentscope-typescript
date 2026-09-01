/* eslint-disable jsdoc/require-jsdoc */

import { ContextConfig, ReActConfig } from '@agentscope-ai/agentscope/agent';
import { OllamaCredential } from '@agentscope-ai/agentscope/credential';
import { UserMsg } from '@agentscope-ai/agentscope/message';

import {
    AgentRecord,
    AgentRecordSchema,
    ChannelRecord,
    ChannelRecordSchema,
    KnowledgeBaseRecord,
    KnowledgeBaseRecordSchema,
    KnowledgeDocumentRecord,
    KnowledgeDocumentRecordSchema,
    MCPRecord,
    MCPRecordSchema,
    ScheduleRecord,
    ScheduleRecordSchema,
    SessionConfig,
    SessionConfigSchema,
    SkillRecordSchema,
    StorageBase,
    StorageConflictError,
    TeamRecordSchema,
} from '../src/storage';

function snakeCaseConfig(value: object): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).map(([key, field]) => [
            key.replace(/[A-Z]/g, character => `_${character.toLowerCase()}`),
            field,
        ])
    );
}

function agentRecord(userId: string, id: string, source: 'user' | 'team' = 'user'): AgentRecord {
    return AgentRecordSchema.parse({
        id,
        user_id: userId,
        source,
        data: {
            id: `data-${id}`,
            name: id,
            context_config: snakeCaseConfig(new ContextConfig()),
            react_config: snakeCaseConfig(new ReActConfig()),
        },
    });
}

function sessionConfig(workspaceId = 'workspace-1'): SessionConfig {
    return SessionConfigSchema.parse({
        workspace_id: workspaceId,
        name: 'session',
        chat_model_config: {
            type: 'openai_credential',
            credential_id: 'credential-1',
            model: 'gpt-4o',
            parameters: {},
        },
    });
}

function scheduleRecord(userId: string, agentId: string, id: string): ScheduleRecord {
    return ScheduleRecordSchema.parse({
        id,
        user_id: userId,
        agent_id: agentId,
        data: {
            name: 'daily',
            cron_expression: '0 9 * * *',
            chat_model_config: {
                type: 'openai_credential',
                credential_id: 'credential-1',
                model: 'gpt-4o',
                parameters: {},
            },
        },
    });
}

function mcpRecord(userId: string, id: string, name = 'deepwiki'): MCPRecord {
    return MCPRecordSchema.parse({
        id,
        user_id: userId,
        client: {
            name,
            is_stateful: false,
            mcp_config: { type: 'http_mcp', url: 'https://mcp.deepwiki.com/mcp' },
        },
        hub_id: 'static',
        card_id: 'deepwiki',
        version: '1.0.0',
    });
}

function channelRecord(id: string, userId = 'user-1'): ChannelRecord {
    return ChannelRecordSchema.parse({
        id,
        channel_type: 'feishu',
        user_id: userId,
        credentials: { app_id: id, app_secret: 'secret' },
        routing: { bindings: [{ match_value: '*', agent_id: 'agent-1' }] },
        session: {
            chat_model_config: {
                type: 'openai_credential',
                credential_id: 'credential-1',
                model: 'gpt-4o',
                parameters: {},
            },
        },
    });
}

function knowledgeBaseRecord(userId: string, id: string): KnowledgeBaseRecord {
    return KnowledgeBaseRecordSchema.parse({
        id,
        user_id: userId,
        data: {
            name: 'knowledge',
            embedding_model_config: {
                type: 'openai_credential',
                credential_id: 'credential-1',
                model: 'text-embedding-3-small',
                dimensions: 8,
            },
            collection_name: 'kb_collection',
        },
    });
}

function knowledgeDocumentRecord(
    userId: string,
    knowledgeBaseId: string,
    id: string,
    createdAt?: string
): KnowledgeDocumentRecord {
    return KnowledgeDocumentRecordSchema.parse({
        id,
        user_id: userId,
        knowledge_base_id: knowledgeBaseId,
        created_at: createdAt,
        data: {
            filename: `${id}.txt`,
            size: 42,
            blob_uri: `local://${id}.txt`,
        },
    });
}

export interface StorageContractFactory {
    create(): Promise<StorageBase>;
    destroy(storage: StorageBase): Promise<void>;
}

/**
 * Register the shared behavioral contract for a storage adapter.
 * @param name
 * @param factory
 */
export function runStorageContract(name: string, factory: StorageContractFactory): void {
    describe(`${name} Storage contract`, () => {
        let storage: StorageBase;

        beforeEach(async () => {
            storage = await factory.create();
        });

        afterEach(async () => {
            await factory.destroy(storage);
        });

        test('round-trips credentials, generates names, and isolates owners', async () => {
            const first = new OllamaCredential({ id: 'credential-1', host: 'http://old:11434' });
            const second = new OllamaCredential({ id: 'credential-2', host: 'http://two:11434' });
            await storage.upsertCredential('user-1', first);
            await storage.upsertCredential('user-1', second);

            expect(await storage.listCredentials('user-2')).toEqual([]);
            expect((await storage.listCredentials('user-1')).map(item => item.data.name)).toEqual([
                'Ollama',
                'Ollama (2)',
            ]);

            const before = await storage.getCredential('user-1', 'credential-1');
            await storage.upsertCredential(
                'user-1',
                new OllamaCredential({ id: 'credential-1', host: 'http://new:11434' })
            );
            const after = await storage.getCredential('user-1', 'credential-1');
            expect(after).toEqual({
                ...before,
                updated_at: expect.any(String),
                data: {
                    ...before!.data,
                    host: 'http://new:11434',
                },
            });
            await expect(
                storage.upsertCredential(
                    'user-2',
                    new OllamaCredential({ id: 'credential-1', host: 'http://attack:11434' })
                )
            ).rejects.toBeInstanceOf(StorageConflictError);
            expect(await storage.deleteCredential('user-1', 'credential-1')).toBe(true);
            expect(await storage.deleteCredential('user-1', 'credential-1')).toBe(false);
        });

        test('enforces per-user MCP and skill names while supporting rename', async () => {
            const mcp = mcpRecord('user-1', 'mcp-1');
            await storage.upsertMCP('user-1', mcp);
            await expect(
                storage.upsertMCP('user-1', mcpRecord('user-1', 'mcp-2'))
            ).rejects.toBeInstanceOf(StorageConflictError);
            await storage.upsertMCP('user-2', mcpRecord('user-2', 'mcp-2'));
            mcp.client.name = 'renamed';
            await storage.upsertMCP('user-1', mcp);
            expect(await storage.getMCPByName('user-1', 'deepwiki')).toBeNull();
            expect(await storage.getMCPByName('user-1', 'renamed')).toEqual(
                expect.objectContaining({ id: 'mcp-1', hub_id: 'static' })
            );

            const skill = SkillRecordSchema.parse({
                id: 'skill-1',
                user_id: 'user-1',
                name: 'shared',
                markdown: '# Shared',
            });
            await storage.upsertSkill('user-1', skill);
            await expect(
                storage.upsertSkill(
                    'user-1',
                    SkillRecordSchema.parse({
                        id: 'skill-2',
                        user_id: 'user-1',
                        name: 'shared',
                    })
                )
            ).rejects.toBeInstanceOf(StorageConflictError);
            expect(await storage.getSkillByName('user-1', 'shared')).toEqual(
                expect.objectContaining({ id: 'skill-1', markdown: '# Shared' })
            );
        });

        test('updates sessions in place and indexes schedule and channel origins', async () => {
            await storage.upsertAgent('user-1', agentRecord('user-1', 'agent-1'));
            const createdAt = '2025-01-01T00:00:00.000Z';
            const updatedAt = '2025-01-01T00:01:00.000Z';
            const created = await storage.upsertSession({
                userId: 'user-1',
                agentId: 'agent-1',
                config: sessionConfig(),
                sessionId: 'session-1',
                source: 'schedule',
                sourceScheduleId: 'schedule-1',
                sourceChannelId: 'channel-1',
                createdAt,
                updatedAt: createdAt,
            });
            expect(created).toEqual({
                ...created,
                created_at: createdAt,
                updated_at: createdAt,
            });
            const updated = await storage.upsertSession({
                userId: 'user-1',
                agentId: 'agent-1',
                config: sessionConfig('workspace-2'),
                sessionId: created.id,
                updatedAt,
            });
            expect(updated).toEqual({
                ...created,
                updated_at: updatedAt,
                config: { ...created.config, workspace_id: 'workspace-2' },
            });
            expect((await storage.listSessionsBySchedule('user-1', 'schedule-1'))[0].id).toBe(
                created.id
            );
            expect((await storage.listSessionsByChannel('user-1', 'channel-1'))[0].id).toBe(
                created.id
            );
            await storage.setSessionTeamId('user-1', created.id, 'team-1');
            expect((await storage.getSession('user-1', 'agent-1', created.id))!.team_id).toBe(
                'team-1'
            );
            await expect(
                storage.updateSessionState('user-1', 'agent-1', 'missing', created.state)
            ).rejects.toThrow('not found');
        });

        test('filters team-created agents and cascades schedule sessions', async () => {
            await storage.upsertAgent('user-1', agentRecord('user-1', 'agent-1'));
            await storage.upsertAgent('user-1', agentRecord('user-1', 'worker-1', 'team'));
            expect((await storage.listAgents('user-1')).map(item => item.id)).toEqual(['agent-1']);

            const schedule = scheduleRecord('user-1', 'agent-1', 'schedule-1');
            await storage.upsertSchedule('user-1', schedule);
            await storage.upsertSession({
                userId: 'user-1',
                agentId: 'agent-1',
                config: sessionConfig(),
                source: 'schedule',
                sourceScheduleId: schedule.id,
            });
            expect(await storage.deleteSchedule('user-1', schedule.id)).toBe(true);
            expect(await storage.listSessionsBySchedule('user-1', schedule.id)).toEqual([]);
        });

        test('applies role-aware team cascade and preserves invited agents', async () => {
            for (const [id, source] of [
                ['leader', 'user'],
                ['created', 'team'],
                ['invited', 'user'],
            ] as const) {
                await storage.upsertAgent('user-1', agentRecord('user-1', id, source));
            }
            const leader = await storage.upsertSession({
                userId: 'user-1',
                agentId: 'leader',
                config: sessionConfig(),
                sessionId: 'leader-session',
            });
            const created = await storage.upsertSession({
                userId: 'user-1',
                agentId: 'created',
                config: sessionConfig(),
                sessionId: 'created-session',
            });
            const invited = await storage.upsertSession({
                userId: 'user-1',
                agentId: 'invited',
                config: sessionConfig(),
                sessionId: 'invited-session',
            });
            await storage.upsertSession({
                userId: 'user-1',
                agentId: 'invited',
                config: sessionConfig(),
                sessionId: 'surviving-session',
            });
            const team = TeamRecordSchema.parse({
                id: 'team-1',
                user_id: 'user-1',
                session_id: leader.id,
                leader_agent_id: 'leader',
                data: {
                    name: 'team',
                    members: [
                        {
                            owner_id: 'user-1',
                            agent_id: 'created',
                            session_id: created.id,
                            role: 'created',
                        },
                        {
                            owner_id: 'user-1',
                            agent_id: 'invited',
                            session_id: invited.id,
                            role: 'invited',
                        },
                    ],
                },
            });
            await storage.upsertTeam('user-1', team);
            for (const sessionId of [leader.id, created.id, invited.id]) {
                await storage.setSessionTeamId('user-1', sessionId, team.id);
            }

            expect(await storage.deleteTeam('user-1', team.id)).toBe(true);
            expect(await storage.getAgent('user-1', 'created')).toBeNull();
            expect(await storage.getAgent('user-1', 'invited')).not.toBeNull();
            expect(await storage.getSession('user-1', 'invited', invited.id)).toBeNull();
            expect(
                await storage.getSession('user-1', 'invited', 'surviving-session')
            ).not.toBeNull();
            expect((await storage.getSession('user-1', 'leader', leader.id))!.team_id).toBeNull();
        });

        test('paginates messages chronologically and replaces a repeated id', async () => {
            const messages = Array.from({ length: 5 }, (_, index) =>
                UserMsg({ id: `message-${index}`, name: 'user', content: `message ${index}` })
            );
            for (const message of messages) {
                await storage.upsertMessage('user-1', 'session-1', message);
            }
            await storage.upsertMessage(
                'user-1',
                'session-1',
                UserMsg({ id: 'message-1', name: 'user', content: 'replaced' })
            );
            expect(await storage.listMessages('user-1', 'session-1', { limit: 2 })).toEqual({
                messages: messages.slice(3),
                hasMore: true,
            });
            const older = await storage.listMessages('user-1', 'session-1', {
                limit: 2,
                before: 'message-3',
            });
            expect(older.messages.map(message => message.id)).toEqual(['message-1', 'message-2']);
            expect(older.messages[0].content[0]).toEqual(
                expect.objectContaining({ type: 'text', text: 'replaced' })
            );
            expect(older.hasMore).toBe(true);
            expect(
                await storage.listMessages('user-1', 'session-1', { before: 'missing' })
            ).toEqual({ messages: [], hasMore: false });
        });

        test('enforces globally unique channel bots and releases old bindings', async () => {
            const channel = channelRecord('channel-1');
            await storage.upsertChannel(channel, 'bot-1');
            await expect(
                storage.upsertChannel(channelRecord('channel-2', 'user-2'), 'bot-1')
            ).rejects.toBeInstanceOf(StorageConflictError);
            await storage.upsertChannel(channel, 'bot-2');
            expect(await storage.getChannelIdByPlatformBotId('bot-1')).toBeNull();
            expect(await storage.getChannelIdByPlatformBotId('bot-2')).toBe('channel-1');
            expect((await storage.listAllChannels()).map(item => item.id)).toEqual(['channel-1']);
            expect(await storage.deleteChannel('channel-1', 'bot-2')).toBe(true);
        });

        test('cascades knowledge documents and implements lease CAS and sweep filters', async () => {
            const knowledgeBase = knowledgeBaseRecord('user-1', 'kb-1');
            await storage.upsertKnowledgeBase('user-1', knowledgeBase);
            const old = new Date('2026-01-01T00:00:00.000Z');
            const document = knowledgeDocumentRecord(
                'user-1',
                knowledgeBase.id,
                'document-1',
                old.toISOString()
            );
            await storage.upsertKnowledgeDocument('user-1', document);

            expect(
                await storage.acquireKnowledgeDocumentLease({
                    userId: 'user-1',
                    knowledgeBaseId: knowledgeBase.id,
                    documentId: document.id,
                    processingNode: 'worker-a',
                    leaseTtlMs: 1_000,
                    now: old,
                })
            ).toBe(true);
            expect(
                await storage.acquireKnowledgeDocumentLease({
                    userId: 'user-1',
                    knowledgeBaseId: knowledgeBase.id,
                    documentId: document.id,
                    processingNode: 'worker-b',
                    leaseTtlMs: 1_000,
                    now: old,
                })
            ).toBe(false);
            expect(
                (
                    await storage.listKnowledgeDocumentsWithExpiredLease(
                        new Date('2026-01-01T00:00:02Z')
                    )
                ).map(item => item.id)
            ).toEqual([document.id]);
            expect(
                (
                    await storage.listKnowledgeDocumentsPendingSince(
                        new Date('2026-02-01T00:00:00Z')
                    )
                ).map(item => item.id)
            ).toEqual([document.id]);
            expect(
                await storage.renewKnowledgeDocumentLease({
                    userId: 'user-1',
                    knowledgeBaseId: knowledgeBase.id,
                    documentId: document.id,
                    processingNode: 'worker-b',
                    leaseTtlMs: 1_000,
                    now: old,
                })
            ).toBe(false);
            await storage.releaseKnowledgeDocumentLease({
                userId: 'user-1',
                knowledgeBaseId: knowledgeBase.id,
                documentId: document.id,
                processingNode: 'worker-a',
            });
            await storage.updateKnowledgeDocumentStatus(
                'user-1',
                knowledgeBase.id,
                document.id,
                'ready',
                { chunkCount: 3 }
            );
            expect(
                await storage.getKnowledgeDocument('user-1', knowledgeBase.id, document.id)
            ).toEqual(
                expect.objectContaining({
                    processing_node: null,
                    lease_expires_at: null,
                    status: 'ready',
                    data: expect.objectContaining({ chunk_count: 3 }),
                })
            );
            expect(await storage.deleteKnowledgeBase('user-1', knowledgeBase.id)).toBe(true);
            expect(await storage.listKnowledgeDocuments('user-1', knowledgeBase.id)).toEqual([]);
        });

        test('preserves creation timestamps across record updates', async () => {
            const agent = agentRecord('user-1', 'agent-1');
            await storage.upsertAgent('user-1', agent);
            const before = await storage.getAgent('user-1', agent.id);
            agent.data.name = 'updated';
            await storage.upsertAgent('user-1', agent);
            const after = await storage.getAgent('user-1', agent.id);
            expect(after).toEqual({
                ...before,
                updated_at: expect.any(String),
                data: { ...before!.data, name: 'updated' },
            });
            expect(after!.created_at).toBe(before!.created_at);
            expect(await storage.getAgent('user-1', 'missing')).toBeNull();
        });

        test('round-trips session defaults and isolates agent session indexes', async () => {
            const first = await storage.upsertSession({
                userId: 'user-1',
                agentId: 'agent-1',
                config: sessionConfig(),
                sessionId: 'session-1',
            });
            await storage.upsertSession({
                userId: 'user-2',
                agentId: 'agent-1',
                config: sessionConfig(),
                sessionId: 'session-2',
            });
            expect(first).toEqual(
                expect.objectContaining({
                    id: 'session-1',
                    source: 'user',
                    team_id: null,
                    source_schedule_id: null,
                    source_channel_id: null,
                })
            );
            expect((await storage.listSessions('user-1', 'agent-1')).map(item => item.id)).toEqual([
                'session-1',
            ]);
            expect(await storage.listSessionsBySchedule('user-1', 'missing')).toEqual([]);
            expect(await storage.listSessionsByChannel('user-1', 'missing')).toEqual([]);
        });

        test('cascades direct agent deletion through sessions and schedules', async () => {
            await storage.upsertAgent('user-1', agentRecord('user-1', 'agent-1'));
            await storage.upsertSession({
                userId: 'user-1',
                agentId: 'agent-1',
                config: sessionConfig(),
                sessionId: 'session-1',
            });
            await storage.upsertSchedule(
                'user-1',
                scheduleRecord('user-1', 'agent-1', 'schedule-1')
            );
            expect(await storage.deleteAgent('user-1', 'agent-1')).toBe(true);
            expect(await storage.getAgent('user-1', 'agent-1')).toBeNull();
            expect(await storage.getSession('user-1', 'agent-1', 'session-1')).toBeNull();
            expect(await storage.getSchedule('user-1', 'schedule-1')).toBeNull();
            expect(await storage.deleteAgent('user-1', 'agent-1')).toBe(false);
        });

        test('keeps message sessions isolated and accepts maximum-width ids', async () => {
            const id = 'm'.repeat(255);
            const message = UserMsg({ id, name: 'user', content: 'wide identifier' });
            expect(await storage.listMessages('user-1', 'empty')).toEqual({
                messages: [],
                hasMore: false,
            });
            await storage.upsertMessage('user-1', 'session-1', message);
            expect(await storage.getMessage('user-1', 'session-2', id)).toBeNull();
            expect(await storage.getMessage('user-2', 'session-1', id)).toBeNull();
            expect(await storage.getMessage('user-1', 'session-1', id)).toEqual(message);
            expect(await storage.listMessages('user-1', 'session-1', { limit: 0 })).toEqual({
                messages: [],
                hasMore: true,
            });
        });

        test('frees MCP and skill names after deletion and keeps libraries independent', async () => {
            await storage.upsertMCP('user-1', mcpRecord('user-1', 'mcp-1', 'shared'));
            await storage.upsertSkill(
                'user-1',
                SkillRecordSchema.parse({
                    id: 'skill-1',
                    user_id: 'user-1',
                    name: 'shared',
                })
            );
            expect(await storage.deleteMCP('user-1', 'mcp-1')).toBe(true);
            expect(await storage.deleteSkill('user-1', 'skill-1')).toBe(true);
            expect(await storage.getMCPByName('user-1', 'shared')).toBeNull();
            expect(await storage.getSkillByName('user-1', 'shared')).toBeNull();
            await storage.upsertMCP('user-1', mcpRecord('user-1', 'mcp-2', 'shared'));
            await storage.upsertSkill(
                'user-1',
                SkillRecordSchema.parse({
                    id: 'skill-2',
                    user_id: 'user-1',
                    name: 'shared',
                })
            );
            expect(await storage.deleteMCP('user-1', 'missing')).toBe(false);
            expect(await storage.deleteSkill('user-1', 'missing')).toBe(false);
        });

        test('lists schedules and channels globally without losing owner isolation', async () => {
            await storage.upsertSchedule(
                'user-1',
                scheduleRecord('user-1', 'agent-1', 'schedule-1')
            );
            await storage.upsertSchedule(
                'user-2',
                scheduleRecord('user-2', 'agent-2', 'schedule-2')
            );
            await storage.upsertChannel(channelRecord('channel-1', 'user-1'), 'bot-1');
            await storage.upsertChannel(channelRecord('channel-2', 'user-2'), 'bot-2');
            expect((await storage.listSchedules('user-1')).map(item => item.id)).toEqual([
                'schedule-1',
            ]);
            expect(new Set((await storage.listAllSchedules()).map(item => item.id))).toEqual(
                new Set(['schedule-1', 'schedule-2'])
            );
            expect((await storage.listChannels('user-1')).map(item => item.id)).toEqual([
                'channel-1',
            ]);
            expect(new Set((await storage.listAllChannels()).map(item => item.id))).toEqual(
                new Set(['channel-1', 'channel-2'])
            );
        });

        test('rejects mismatched knowledge owners and preserves creation on overwrite', async () => {
            const knowledgeBase = knowledgeBaseRecord('user-1', 'kb-1');
            await storage.upsertKnowledgeBase('user-1', knowledgeBase);
            const before = await storage.getKnowledgeBase('user-1', knowledgeBase.id);
            knowledgeBase.data.name = 'updated';
            await storage.upsertKnowledgeBase('user-1', knowledgeBase);
            const after = await storage.getKnowledgeBase('user-1', knowledgeBase.id);
            expect(after!.created_at).toBe(before!.created_at);
            expect(after!.data.name).toBe('updated');
            await expect(
                storage.upsertKnowledgeBase('user-2', knowledgeBase)
            ).rejects.toBeInstanceOf(StorageConflictError);
            await expect(
                storage.upsertKnowledgeDocument(
                    'user-1',
                    knowledgeDocumentRecord('user-1', 'missing', 'document-1')
                )
            ).rejects.toBeInstanceOf(StorageConflictError);
        });

        test('dissolves a team with its leader while preserving direct worker session semantics', async () => {
            await storage.upsertAgent('user-1', agentRecord('user-1', 'leader'));
            await storage.upsertAgent('user-1', agentRecord('user-1', 'worker', 'team'));
            const leader = await storage.upsertSession({
                userId: 'user-1',
                agentId: 'leader',
                config: sessionConfig(),
                sessionId: 'leader-session',
            });
            const worker = await storage.upsertSession({
                userId: 'user-1',
                agentId: 'worker',
                config: sessionConfig(),
                sessionId: 'worker-session',
            });
            const team = TeamRecordSchema.parse({
                id: 'team-1',
                user_id: 'user-1',
                session_id: leader.id,
                leader_agent_id: 'leader',
                data: {
                    name: 'team',
                    members: [
                        {
                            owner_id: 'user-1',
                            agent_id: 'worker',
                            session_id: worker.id,
                            role: 'created',
                        },
                    ],
                },
            });
            await storage.upsertTeam('user-1', team);
            await storage.setSessionTeamId('user-1', leader.id, team.id);
            await storage.setSessionTeamId('user-1', worker.id, team.id);
            expect(await storage.deleteSession('user-1', 'worker', worker.id)).toBe(true);
            expect(await storage.getTeam('user-1', team.id)).not.toBeNull();
            expect(await storage.deleteSession('user-1', 'leader', leader.id)).toBe(true);
            expect(await storage.getTeam('user-1', team.id)).toBeNull();
            expect(await storage.getAgent('user-1', 'worker')).toBeNull();
        });
    });
}
