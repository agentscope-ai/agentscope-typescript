/* eslint-disable jsdoc/require-jsdoc */

import { BindingState, FeishuCredentialBinding } from '../src/channel';

function fetchScript(payloads: Record<string, unknown>[]) {
    return jest.fn<Promise<Response>, [input: string | URL | Request, init?: RequestInit]>(
        async (_input, _init) => {
            const payload = payloads.shift();
            if (!payload) throw new Error('No scripted response.');
            return { json: async () => payload } as Response;
        }
    );
}

describe('Feishu credential binding Python parity', () => {
    test('begins with device URL, interval, expiry and exact registration request', async () => {
        const fetchImpl = fetchScript([
            {
                device_code: 'dc-1',
                verification_uri_complete: 'https://feishu.test/qr?x=1',
                interval: 7,
                expires_in: 300,
            },
        ]);
        const binding = new FeishuCredentialBinding(fetchImpl);

        expect(await binding.begin()).toEqual(
            expect.objectContaining({
                state: BindingState.PENDING,
                verificationUrl: 'https://feishu.test/qr?x=1',
                credentials: {},
                error: '',
                providerState: {
                    device_code: 'dc-1',
                    domain: 'https://accounts.feishu.cn',
                    interval: 7,
                },
                retryAfterSeconds: 7,
                expiresInSeconds: 300,
            })
        );
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://accounts.feishu.cn/oauth/v1/app/registration',
            expect.objectContaining({ method: 'POST' })
        );
        const request = fetchImpl.mock.calls[0][1] as RequestInit;
        expect(Object.fromEntries(request.body as URLSearchParams)).toEqual({
            action: 'begin',
            archetype: 'PersonalAgent',
            auth_method: 'client_secret',
            request_user_info: 'open_id',
        });
    });

    test('maps begin refusal and approval to terminal states', async () => {
        const refused = new FeishuCredentialBinding(
            fetchScript([{ error_description: 'app quota exceeded' }])
        );
        await expect(refused.begin()).resolves.toMatchObject({
            state: BindingState.FAILED,
            error: 'app quota exceeded',
        });

        const approved = new FeishuCredentialBinding(
            fetchScript([{ client_id: 'cli-1', client_secret: 'sec-1' }])
        );
        await expect(
            approved.advance({ device_code: 'dc-1', domain: 'https://accounts.feishu.cn' })
        ).resolves.toMatchObject({
            state: BindingState.AUTHORIZED,
            credentials: { app_id: 'cli-1', app_secret: 'sec-1' },
        });
    });

    test('preserves pending state, slows down, and moves Lark tenants', async () => {
        const state = {
            device_code: 'dc-1',
            domain: 'https://accounts.feishu.cn',
            interval: 5,
        };
        const pending = new FeishuCredentialBinding(
            fetchScript([{ error: 'authorization_pending' }])
        );
        await expect(pending.advance(state)).resolves.toMatchObject({
            state: BindingState.PENDING,
            providerState: state,
            retryAfterSeconds: null,
        });

        const slower = new FeishuCredentialBinding(fetchScript([{ error: 'slow_down' }]));
        await expect(slower.advance(state)).resolves.toMatchObject({
            providerState: { ...state, interval: 10 },
            retryAfterSeconds: 10,
        });

        const lark = new FeishuCredentialBinding(
            fetchScript([{ user_info: { tenant_brand: 'lark' } }])
        );
        await expect(lark.advance(state)).resolves.toMatchObject({
            providerState: { ...state, domain: 'https://accounts.larksuite.com' },
        });
    });

    test('maps a denied approval to a failed step', async () => {
        const binding = new FeishuCredentialBinding(
            fetchScript([{ error: 'access_denied', error_description: 'user said no' }])
        );
        await expect(
            binding.advance({ device_code: 'dc-1', domain: 'https://accounts.feishu.cn' })
        ).resolves.toMatchObject({ state: BindingState.FAILED, error: 'user said no' });
    });
});
