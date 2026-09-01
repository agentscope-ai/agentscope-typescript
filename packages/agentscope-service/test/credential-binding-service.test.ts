/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import {
    BindingState,
    BindingStep,
    ChannelBase,
    ChannelTypeRegistry,
    CredentialBindingBase,
    type ChannelEmitter,
    type ChannelEvent,
} from '../src/channel';
import { InMemoryMessageBus, type BusPayload } from '../src/message-bus';
import { CredentialBindingError, CredentialBindingService } from '../src/service';

class ScriptedBinding extends CredentialBindingBase {
    static script: BindingStep[] = [];
    static calls = 0;
    static retryAfterSeconds = 0;
    static duringAdvance: (() => Promise<void>) | null = null;

    async begin(): Promise<BindingStep> {
        return new BindingStep({
            verificationUrl: 'https://example.test/qr',
            providerState: { device_code: 'dc-1' },
            retryAfterSeconds: ScriptedBinding.retryAfterSeconds,
            expiresInSeconds: 600,
        });
    }

    async advance(): Promise<BindingStep> {
        ScriptedBinding.calls += 1;
        await ScriptedBinding.duringAdvance?.();
        const step = ScriptedBinding.script.shift();
        if (!step) throw new Error('No scripted binding step.');
        return step;
    }
}

class BoundChannel extends ChannelBase {
    static override readonly channelType = 'scripted';
    static override readonly displayName = 'Scripted';
    static override readonly platformBotIdField = 'app_id';
    static override readonly credentialsSchema = z.object({
        app_id: z.string(),
        app_secret: z.string(),
    });
    static override readonly configSchema = z.object({});
    static override readonly credentialBinding = ScriptedBinding;
    readonly channelId: string;

    constructor(channelId: string) {
        super();
        this.channelId = channelId;
    }

    async startListening(_emit: ChannelEmitter): Promise<void> {}
    async sendResponse(_event: ChannelEvent, _events: AsyncIterable<BusPayload>): Promise<void> {}
}

class FormOnlyChannel extends ChannelBase {
    static override readonly channelType = 'form-only';
    static override readonly displayName = 'Form only';
    static override readonly platformBotIdField = 'app_id';
    static override readonly credentialsSchema = BoundChannel.credentialsSchema;
    static override readonly configSchema = z.object({});
    static override readonly credentialBinding = null;
    readonly channelId: string;

    constructor(channelId: string) {
        super();
        this.channelId = channelId;
    }

    async startListening(_emit: ChannelEmitter): Promise<void> {}
    async sendResponse(_event: ChannelEvent, _events: AsyncIterable<BusPayload>): Promise<void> {}
}

class ContendingBus extends InMemoryMessageBus {
    private readers = 0;
    private release!: () => void;
    private readonly ready = new Promise<void>(resolve => {
        this.release = resolve;
    });

    override async registryGet(namespace: string, field: string): Promise<string | null> {
        const value = await super.registryGet(namespace, field);
        this.readers += 1;
        if (this.readers === 2) this.release();
        await this.ready;
        return value;
    }
}

describe('CredentialBindingService Python parity', () => {
    let bus: InMemoryMessageBus;
    let nodeA: CredentialBindingService;
    let nodeB: CredentialBindingService;

    beforeEach(async () => {
        bus = await new InMemoryMessageBus().open();
        const registry = new ChannelTypeRegistry([BoundChannel, FormOnlyChannel]);
        nodeA = new CredentialBindingService(bus, registry);
        nodeB = new CredentialBindingService(bus, registry);
        ScriptedBinding.script = [];
        ScriptedBinding.calls = 0;
        ScriptedBinding.retryAfterSeconds = 0;
        ScriptedBinding.duringAdvance = null;
    });

    afterEach(async () => bus.close());

    test('opens on one replica, advances on another, hides and claims secrets once', async () => {
        const opened = await nodeA.start('u', 'scripted');
        expect(opened.toJSON()).toEqual({
            binding_id: expect.any(String),
            state: 'pending',
            verification_url: 'https://example.test/qr',
            error: '',
            retry_after_secs: 0,
        });
        ScriptedBinding.script = [
            new BindingStep({ providerState: { device_code: 'dc-1' } }),
            new BindingStep({
                state: BindingState.AUTHORIZED,
                credentials: { app_id: 'a', app_secret: 's' },
            }),
        ];

        await expect(nodeB.poll('u', opened.bindingId)).resolves.toMatchObject({
            state: BindingState.PENDING,
        });
        expect((await nodeA.poll('u', opened.bindingId)).toJSON()).toEqual({
            binding_id: opened.bindingId,
            state: 'authorized',
            verification_url: 'https://example.test/qr',
            error: '',
            retry_after_secs: 0,
        });
        await expect(nodeB.claim('u', opened.bindingId, 'scripted')).resolves.toEqual({
            app_id: 'a',
            app_secret: 's',
        });
        await expect(nodeA.claim('u', opened.bindingId, 'scripted')).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    test('lets cancellation win over an in-flight platform approval', async () => {
        const opened = await nodeA.start('u', 'scripted');
        ScriptedBinding.duringAdvance = () => nodeB.cancel('u', opened.bindingId);
        ScriptedBinding.script = [
            new BindingStep({
                state: BindingState.AUTHORIZED,
                credentials: { app_id: 'a', app_secret: 's' },
            }),
        ];

        expect((await nodeA.poll('u', opened.bindingId)).toJSON()).toMatchObject({
            state: 'cancelled',
        });
        await expect(nodeB.claim('u', opened.bindingId, 'scripted')).rejects.toBeInstanceOf(
            CredentialBindingError
        );
    });

    test('absorbs fast and concurrent polls before they reach the provider twice', async () => {
        ScriptedBinding.retryAfterSeconds = 60;
        const opened = await nodeA.start('u', 'scripted');
        ScriptedBinding.script = [new BindingStep(), new BindingStep()];
        await nodeA.poll('u', opened.bindingId);
        await nodeB.poll('u', opened.bindingId);
        expect(ScriptedBinding.calls).toBe(1);

        const contendingBus = await new ContendingBus().open();
        const registry = new ChannelTypeRegistry([BoundChannel]);
        const first = new CredentialBindingService(contendingBus, registry);
        const second = new CredentialBindingService(contendingBus, registry);
        ScriptedBinding.calls = 0;
        ScriptedBinding.script = [new BindingStep(), new BindingStep()];
        const contended = await first.start('u', 'scripted');
        await Promise.all([
            first.poll('u', contended.bindingId),
            second.poll('u', contended.bindingId),
        ]);
        expect(ScriptedBinding.calls).toBe(1);
        await contendingBus.close();
    });

    test('protects owner/type/state checks without burning the session', async () => {
        const opened = await nodeA.start('u', 'scripted');
        await expect(nodeB.poll('intruder', opened.bindingId)).rejects.toMatchObject({
            statusCode: 404,
        });
        await expect(nodeA.claim('u', opened.bindingId, 'scripted')).rejects.toMatchObject({
            statusCode: 409,
        });
        ScriptedBinding.script = [
            new BindingStep({
                state: BindingState.AUTHORIZED,
                credentials: { app_id: 'a', app_secret: 's' },
            }),
        ];
        await nodeA.poll('u', opened.bindingId);
        await expect(nodeB.claim('u', opened.bindingId, 'form-only')).rejects.toMatchObject({
            statusCode: 409,
        });
        await expect(nodeA.claim('u', opened.bindingId, 'scripted')).resolves.toEqual({
            app_id: 'a',
            app_secret: 's',
        });
    });

    test('rejects form-only types and discards approved sessions on cancel', async () => {
        await expect(nodeA.start('u', 'form-only')).rejects.toMatchObject({ statusCode: 400 });
        const opened = await nodeA.start('u', 'scripted');
        ScriptedBinding.script = [
            new BindingStep({
                state: BindingState.AUTHORIZED,
                credentials: { app_id: 'a', app_secret: 's' },
            }),
        ];
        await nodeA.poll('u', opened.bindingId);
        await nodeB.cancel('u', opened.bindingId);
        await expect(nodeA.claim('u', opened.bindingId, 'scripted')).rejects.toMatchObject({
            statusCode: 404,
        });
        await expect(nodeA.cancel('u', opened.bindingId)).resolves.toBeUndefined();
    });
});
