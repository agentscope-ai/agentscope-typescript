/* eslint-disable jsdoc/require-jsdoc */

import {
    registerChatModelResolver,
    type CredentialBase,
    type CredentialClass,
    type CredentialSchema,
} from './base';
import {
    AnthropicCredential,
    DashScopeCredential,
    DeepSeekCredential,
    GeminiCredential,
    MoonshotCredential,
    OllamaCredential,
    OpenAICredential,
    XAICredential,
} from './providers';

/** Extensible discriminated credential deserializer and schema registry. */
export class CredentialFactory {
    private static readonly classes: CredentialClass[] = [
        AnthropicCredential,
        DashScopeCredential,
        DeepSeekCredential,
        GeminiCredential,
        MoonshotCredential,
        OllamaCredential,
        OpenAICredential,
        XAICredential,
    ];

    static registerCredential(credentialClass: CredentialClass): void {
        if (this.classes.includes(credentialClass)) return;
        this.classes.push(credentialClass);
    }

    static fromDict(data: Record<string, unknown>): CredentialBase {
        if (typeof data.type !== 'string') {
            throw new Error("Credential data must contain a string 'type' discriminator.");
        }
        const credentialClass = this.getCredentialClass(data.type);
        if (!credentialClass) throw new Error(`Unknown credential type '${data.type}'.`);
        return credentialClass.fromDict(data);
    }

    static getCredentialClass(provider: string): CredentialClass | null {
        return this.classes.find(item => item.credentialType === provider) ?? null;
    }

    static listSchemas(): CredentialSchema[] {
        return this.classes.map(item => item.schema);
    }
}

registerChatModelResolver(async provider => {
    if (provider === 'anthropic')
        return (await import('../model/anthropic-model')).AnthropicChatModel;
    if (provider === 'dashscope')
        return (await import('../model/dashscope-model')).DashScopeChatModel;
    if (provider === 'deepseek') return (await import('../model/deepseek-model')).DeepSeekChatModel;
    if (provider === 'gemini') return (await import('../model/gemini-model')).GeminiChatModel;
    if (provider === 'moonshot') return (await import('../model/moonshot-model')).MoonshotChatModel;
    if (provider === 'ollama') return (await import('../model/ollama-model')).OllamaChatModel;
    if (provider === 'openai_chat') return (await import('../model/openai-model')).OpenAIChatModel;
    if (provider === 'xai') return (await import('../model/xai-model')).XAIChatModel;
    throw new Error(`No chat model class is registered for '${provider}'.`);
});
