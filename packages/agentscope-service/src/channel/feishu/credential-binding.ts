/* eslint-disable jsdoc/require-jsdoc */

import { BindingState, BindingStep, CredentialBindingBase } from '../credential-binding';

const ENDPOINT = '/oauth/v1/app/registration';
const FEISHU_DOMAIN = 'https://accounts.feishu.cn';
const LARK_DOMAIN = 'https://accounts.larksuite.com';

/** Feishu/Lark app registration through one device-flow step per request. */
export class FeishuCredentialBinding extends CredentialBindingBase {
    constructor(private readonly fetchImpl: typeof fetch = fetch) {
        super();
    }

    async begin(): Promise<BindingStep> {
        const payload = await this.post(FEISHU_DOMAIN, {
            action: 'begin',
            archetype: 'PersonalAgent',
            auth_method: 'client_secret',
            request_user_info: 'open_id',
        });
        const deviceCode = stringValue(payload.device_code);
        if (!deviceCode) {
            return new BindingStep({
                state: BindingState.FAILED,
                error:
                    stringValue(payload.error_description) ||
                    stringValue(payload.error) ||
                    'Feishu did not return a device code.',
            });
        }
        const interval = integerValue(payload.interval, 5);
        return new BindingStep({
            verificationUrl: stringValue(payload.verification_uri_complete),
            providerState: {
                device_code: deviceCode,
                domain: FEISHU_DOMAIN,
                interval,
            },
            retryAfterSeconds: interval,
            expiresInSeconds: integerValue(payload.expires_in, 600),
        });
    }

    async advance(providerState: Record<string, unknown>): Promise<BindingStep> {
        const domain = stringValue(providerState.domain) || FEISHU_DOMAIN;
        const payload = await this.post(domain, {
            action: 'poll',
            device_code: stringValue(providerState.device_code),
        });
        const clientId = stringValue(payload.client_id);
        const clientSecret = stringValue(payload.client_secret);
        if (clientId && clientSecret) {
            return new BindingStep({
                state: BindingState.AUTHORIZED,
                credentials: { app_id: clientId, app_secret: clientSecret },
            });
        }
        const userInfo = recordValue(payload.user_info);
        if (userInfo.tenant_brand === 'lark' && domain !== LARK_DOMAIN) {
            return new BindingStep({
                providerState: { ...providerState, domain: LARK_DOMAIN },
            });
        }
        const error = stringValue(payload.error);
        if (error === 'authorization_pending') {
            return new BindingStep({ providerState });
        }
        if (error === 'slow_down') {
            const interval = integerValue(providerState.interval, 5) + 5;
            return new BindingStep({
                providerState: { ...providerState, interval },
                retryAfterSeconds: interval,
            });
        }
        return new BindingStep({
            state: BindingState.FAILED,
            error: stringValue(payload.error_description) || error || 'unknown',
        });
    }

    private async post(
        domain: string,
        data: Record<string, string>
    ): Promise<Record<string, unknown>> {
        const response = await this.fetchImpl(`${domain}${ENDPOINT}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(data),
            signal: AbortSignal.timeout(10_000),
        });
        return recordValue(await response.json());
    }
}

function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function integerValue(value: unknown, fallback: number): number {
    const number = Number(value);
    return Number.isInteger(number) ? number : fallback;
}
