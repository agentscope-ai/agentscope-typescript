/* eslint-disable jsdoc/require-jsdoc */

import { readFileSync } from 'fs';
import path from 'path';

import { CredentialBase, CredentialOptions, credentialJSON } from './base';
import { CredentialFactory } from './factory';
import {
    DashScopeCredential,
    GeminiCredential,
    OllamaCredential,
    OpenAICredential,
} from './providers';
import { GeminiChatModel } from '../model/gemini-model';

describe('CredentialFactory', () => {
    test('matches every Python credential JSON schema', () => {
        const fixturePath = path.join(
            __dirname,
            '../../test/parity/fixtures/credential-schemas.python.json'
        );
        const expected = JSON.parse(readFileSync(fixturePath, 'utf8'));
        expect(CredentialFactory.listSchemas()).toEqual(expected);
    });

    test('deserializes snake-case storage data and round-trips it', () => {
        const credential = CredentialFactory.fromDict({
            id: 'credential-1',
            name: 'Production',
            type: 'openai_credential',
            api_key: 'secret',
            organization: 'org-1',
            base_url: 'https://example.com/v1',
        });
        expect(credential).toBeInstanceOf(OpenAICredential);
        expect(credential.toJSON()).toEqual({
            id: 'credential-1',
            name: 'Production',
            type: 'openai_credential',
            api_key: 'secret',
            organization: 'org-1',
            base_url: 'https://example.com/v1',
        });
    });

    test('applies provider defaults and exposes related model cards', () => {
        const dashscope = new DashScopeCredential({ apiKey: 'secret', id: 'dash' });
        expect(dashscope.baseUrl).toBe(DashScopeCredential.defaultBaseUrl);
        expect(dashscope.listModels()).toHaveLength(15);
        expect(dashscope.listEmbeddingModels()).toHaveLength(7);
        expect(dashscope.listTTSModels()).toHaveLength(4);

        const ollama = new OllamaCredential({ id: 'ollama' });
        expect(ollama.toJSON()).toEqual({
            id: 'ollama',
            name: '',
            type: 'ollama_credential',
            host: null,
        });
        expect(ollama.listTTSModels()).toEqual([]);
    });

    test('resolves the Python-compatible chat model class lazily', async () => {
        const credential = new GeminiCredential({ apiKey: 'secret' });
        expect(await credential.getChatModelClass()).toBe(GeminiChatModel);
    });

    test('validates discriminators and required API keys', () => {
        expect(() => CredentialFactory.fromDict({})).toThrow("string 'type'");
        expect(() => CredentialFactory.fromDict({ type: 'missing' })).toThrow(
            "Unknown credential type 'missing'"
        );
        expect(() => CredentialFactory.fromDict({ type: 'openai_credential' })).toThrow(
            "field 'api_key' is required"
        );
    });

    test('registers a custom credential class once', () => {
        class CustomCredential extends CredentialBase {
            static readonly credentialType = 'custom_credential';
            static readonly schema = { title: 'Custom' };
            readonly type = CustomCredential.credentialType;
            readonly chatProvider = 'custom';

            constructor(options: CredentialOptions = {}) {
                super(options);
            }

            static fromDict(data: Record<string, unknown>): CustomCredential {
                return new CustomCredential({
                    id: typeof data.id === 'string' ? data.id : undefined,
                    name: typeof data.name === 'string' ? data.name : undefined,
                });
            }

            toJSON(): Record<string, unknown> {
                return credentialJSON(this, {});
            }
        }

        const before = CredentialFactory.listSchemas().length;
        CredentialFactory.registerCredential(CustomCredential);
        CredentialFactory.registerCredential(CustomCredential);
        expect(CredentialFactory.listSchemas()).toHaveLength(before + 1);
        expect(CredentialFactory.getCredentialClass('custom_credential')).toBe(CustomCredential);
    });
});
