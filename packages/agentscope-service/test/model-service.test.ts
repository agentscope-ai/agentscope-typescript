import { OpenAICredential, OllamaCredential } from '@agentscope-ai/agentscope/credential';

import { DenyAllResourceAccessPolicy } from '../src/access';
import {
    buildEmbeddingModel,
    getEmbeddingModel,
    getModel,
    getTTSModel,
    ModelServiceError,
    ResourceAccessService,
} from '../src/service';
import { EmbeddingModelConfigSchema, InMemoryStorage } from '../src/storage';

describe('model services', () => {
    let storage: InMemoryStorage;
    let access: ResourceAccessService;

    beforeEach(async () => {
        storage = new InMemoryStorage();
        await storage.upsertCredential(
            'user',
            new OpenAICredential({
                id: 'openai',
                apiKey: 'secret',
                name: 'OpenAI',
            })
        );
        await storage.upsertCredential(
            'user',
            new OllamaCredential({ id: 'ollama', name: 'Ollama' })
        );
        access = new ResourceAccessService(storage, new DenyAllResourceAccessPolicy());
    });

    test('constructs chat models and maps Python parameter names', async () => {
        const model = await getModel(
            'user',
            {
                type: 'openai_credential',
                credential_id: 'openai',
                model: 'gpt-4o',
                parameters: { max_tokens: 123, reasoning_effort: 'high' },
            },
            access
        );
        expect(model.constructor.name).toBe('OpenAIChatModel');
        expect(model.parameters).toMatchObject({ maxTokens: 123, reasoningEffort: 'high' });
        expect(model.formatter?.inputTypes).toEqual(expect.arrayContaining(['text/plain']));
    });

    test('uses model-card context size when building embedding models', async () => {
        const config = EmbeddingModelConfigSchema.parse({
            type: 'openai_credential',
            credential_id: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
            parameters: { max_retries: 5 },
        });
        const model = await getEmbeddingModel('user', config, access);
        expect(model).toMatchObject({
            model: 'text-embedding-3-small',
            dimensions: 1536,
            contextSize: 8191,
            parameters: { maxRetries: 5 },
        });
    });

    test('rejects credentials whose provider has no embedding model', async () => {
        const record = await storage.getCredential('user', 'ollama');
        await expect(
            buildEmbeddingModel(record!, {
                type: 'unsupported_credential',
                credential_id: 'ollama',
                model: 'embed',
                dimensions: 8,
                parameters: {},
            })
        ).rejects.toEqual(new ModelServiceError("Provider 'unsupported_credential' not found."));
    });

    test('selects a TTS implementation by model card', async () => {
        const model = await getTTSModel(
            'user',
            {
                type: 'openai_credential',
                credential_id: 'openai',
                model: 'tts-1',
                parameters: { response_format: 'wav', voice: 'alloy' },
            },
            access
        );
        expect(model.constructor.name).toBe('OpenAITTSModel');
        expect(model.parameters).toMatchObject({ responseFormat: 'wav', voice: 'alloy' });
    });

    test('reports unsupported TTS providers with the Python-compatible detail', async () => {
        await expect(
            getTTSModel(
                'user',
                {
                    type: 'ollama_credential',
                    credential_id: 'ollama',
                    model: 'tts',
                    parameters: {},
                },
                access
            )
        ).rejects.toEqual(
            new ModelServiceError("Provider 'ollama_credential' does not support TTS models.")
        );
    });
});
