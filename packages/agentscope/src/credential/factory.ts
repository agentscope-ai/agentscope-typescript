/* eslint-disable jsdoc/require-jsdoc */

import type { CredentialBase, CredentialClass, CredentialSchema } from './base';
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
