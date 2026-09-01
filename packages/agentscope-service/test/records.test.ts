import {
    AgentRecordSchema,
    ChannelRecordSchema,
    defaultContextConfigData,
    defaultReActConfigData,
    KnowledgeBaseRecordSchema,
    KnowledgeDocumentRecordSchema,
} from '../src/storage';

describe('service record schemas', () => {
    test('serializes every current Python context default', () => {
        expect(defaultContextConfigData()).toMatchObject({
            trigger_ratio: 0.8,
            reserve_ratio: 0.1,
            context_buffer_ratio: 0.2,
            tool_result_limit: 50000,
            compression_fallback_to_truncation: true,
            compression_tool_enabled: false,
            max_image_num: 5,
        });
    });

    test('fills legacy agent defaults and validates invitation descriptions', () => {
        const record = AgentRecordSchema.parse({
            user_id: 'user-1',
            data: {
                name: 'Friday',
                context_config: {},
                react_config: {},
            },
        });
        expect(record).toEqual({
            id: expect.any(String),
            created_at: expect.any(String),
            updated_at: expect.any(String),
            user_id: 'user-1',
            source: 'user',
            data: {
                id: expect.any(String),
                name: 'Friday',
                system_prompt: "You're a helpful assistant.",
                context_config: defaultContextConfigData(),
                react_config: defaultReActConfigData(),
                invite_config: { invitable: false, invite_description: null },
            },
        });
        expect(() =>
            AgentRecordSchema.parse({
                user_id: 'user-1',
                data: {
                    name: 'Friday',
                    context_config: {},
                    react_config: {},
                    invite_config: { invitable: true, invite_description: '  ' },
                },
            })
        ).toThrow('invite_description');
    });

    test('requires one final channel catch-all and rejects duplicate rules', () => {
        const base = {
            channel_type: 'feishu',
            user_id: 'user-1',
            session: { chat_model_config: {} },
        };
        expect(() =>
            ChannelRecordSchema.parse({
                ...base,
                routing: {
                    bindings: [
                        { match_value: '*', agent_id: 'a' },
                        { match_value: 'chat-1', agent_id: 'b' },
                    ],
                },
            })
        ).toThrow('last');
        expect(() =>
            ChannelRecordSchema.parse({
                ...base,
                routing: {
                    bindings: [
                        { match_value: 'chat-1', agent_id: 'a' },
                        { match_value: 'chat-1', agent_id: 'b' },
                        { match_value: '*', agent_id: 'c' },
                    ],
                },
            })
        ).toThrow('Duplicate');
    });

    test('migrates legacy knowledge-base and document payloads', () => {
        const knowledgeBase = KnowledgeBaseRecordSchema.parse({
            user_id: 'user-1',
            name: 'legacy',
            embedding_model_config: {
                type: 'openai_credential',
                credential_id: 'credential-1',
                model: 'embedding',
                dimensions: 8,
            },
            collection_name: 'legacy_collection',
        });
        expect(knowledgeBase.data).toEqual({
            name: 'legacy',
            description: '',
            embedding_model_config: {
                type: 'openai_credential',
                credential_id: 'credential-1',
                model: 'embedding',
                dimensions: 8,
                parameters: {},
            },
            chunker_config: null,
            collection_name: 'legacy_collection',
        });

        const document = KnowledgeDocumentRecordSchema.parse({
            user_id: 'user-1',
            knowledge_base_id: knowledgeBase.id,
            data: {
                filename: 'legacy.txt',
                size: 1,
                blob_uri: 'local://legacy.txt',
                status: 'ready',
                lease_expires_at: null,
            },
        });
        expect(document).toEqual(
            expect.objectContaining({
                status: 'ready',
                lease_expires_at: null,
                data: {
                    filename: 'legacy.txt',
                    size: 1,
                    content_type: null,
                    blob_uri: 'local://legacy.txt',
                    error: null,
                    chunk_count: 0,
                },
            })
        );
    });
});
