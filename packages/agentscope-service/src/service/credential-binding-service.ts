/* eslint-disable jsdoc/require-jsdoc */

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
    BindingState,
    type BindingStep,
    type ChannelTypeRegistry,
    isTerminalBindingState,
} from '../channel';
import type { MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';

const BindingSessionSchema = z.object({
    user_id: z.string(),
    channel_type: z.string(),
    state: z.nativeEnum(BindingState).default(BindingState.PENDING),
    verification_url: z.string().default(''),
    error: z.string().default(''),
    credentials: z.record(z.string(), z.unknown()).default({}),
    provider_state: z.record(z.string(), z.unknown()).default({}),
    retry_after_secs: z.number().int().default(5),
    last_stepped_at: z.number().default(0),
});

type BindingSession = z.infer<typeof BindingSessionSchema>;

/** Public binding state without credentials or opaque provider state. */
export class BindingView {
    constructor(
        readonly bindingId: string,
        readonly state: BindingState,
        readonly verificationUrl = '',
        readonly error = '',
        readonly retryAfterSeconds = 5
    ) {}

    toJSON(): Record<string, unknown> {
        return {
            binding_id: this.bindingId,
            state: this.state,
            verification_url: this.verificationUrl,
            error: this.error,
            retry_after_secs: this.retryAfterSeconds,
        };
    }
}

export class CredentialBindingError extends Error {
    constructor(
        message: string,
        readonly statusCode = 400
    ) {
        super(message);
        this.name = 'CredentialBindingError';
    }
}

/** Stateless, replica-safe lifecycle for interactive channel credentials. */
export class CredentialBindingService {
    constructor(
        private readonly messageBus: MessageBus,
        private readonly typeRegistry: ChannelTypeRegistry,
        private readonly now: () => number = () => Date.now() / 1_000,
        private readonly createId: () => string = () => randomBytes(24).toString('base64url')
    ) {}

    async start(userId: string, channelType: string): Promise<BindingView> {
        const step = await this.provider(channelType).begin();
        const session: BindingSession = {
            user_id: userId,
            channel_type: channelType,
            state: step.state,
            verification_url: step.verificationUrl,
            error: step.error,
            credentials: step.credentials,
            provider_state: step.providerState,
            retry_after_secs: step.retryAfterSeconds ?? 5,
            last_stepped_at: 0,
        };
        const bindingId = this.createId();
        await this.messageBus.registrySet(
            MessageBusKeys.channelCredentialBinding(bindingId),
            MessageBusKeys.CREDENTIAL_BINDING_FIELD,
            JSON.stringify(session),
            { ttlSeconds: step.expiresInSeconds }
        );
        return this.view(bindingId, session);
    }

    async poll(userId: string, bindingId: string): Promise<BindingView> {
        let [raw, session] = await this.load(userId, bindingId);
        if (
            isTerminalBindingState(session.state) ||
            this.now() - session.last_stepped_at < session.retry_after_secs
        ) {
            return this.view(bindingId, session);
        }

        session.last_stepped_at = this.now();
        const reserved = JSON.stringify(session);
        const claimed = await this.messageBus.registrySetIf(
            MessageBusKeys.channelCredentialBinding(bindingId),
            MessageBusKeys.CREDENTIAL_BINDING_FIELD,
            reserved,
            { expected: raw }
        );
        if (!claimed) {
            [, session] = await this.load(userId, bindingId);
            return this.view(bindingId, session);
        }

        const step = await this.provider(session.channel_type).advance(session.provider_state);
        applyStep(session, step);
        const written = await this.messageBus.registrySetIf(
            MessageBusKeys.channelCredentialBinding(bindingId),
            MessageBusKeys.CREDENTIAL_BINDING_FIELD,
            JSON.stringify(session),
            {
                expected: reserved,
                ...(session.state === BindingState.AUTHORIZED
                    ? { ttlSeconds: MessageBusKeys.CREDENTIAL_BINDING_CLAIM_TTL_SECS }
                    : {}),
            }
        );
        if (!written) [, session] = await this.load(userId, bindingId);
        return this.view(bindingId, session);
    }

    async cancel(userId: string, bindingId: string): Promise<void> {
        while (true) {
            let raw: string;
            let session: BindingSession;
            try {
                [raw, session] = await this.load(userId, bindingId);
            } catch (error) {
                if (error instanceof CredentialBindingError) return;
                throw error;
            }
            if (session.state === BindingState.AUTHORIZED) {
                await this.messageBus.registryPop(
                    MessageBusKeys.channelCredentialBinding(bindingId),
                    MessageBusKeys.CREDENTIAL_BINDING_FIELD
                );
                return;
            }
            if (isTerminalBindingState(session.state)) return;
            session.state = BindingState.CANCELLED;
            session.credentials = {};
            if (
                await this.messageBus.registrySetIf(
                    MessageBusKeys.channelCredentialBinding(bindingId),
                    MessageBusKeys.CREDENTIAL_BINDING_FIELD,
                    JSON.stringify(session),
                    { expected: raw }
                )
            ) {
                return;
            }
        }
    }

    async claim(
        userId: string,
        bindingId: string,
        channelType: string
    ): Promise<Record<string, unknown>> {
        const [, session] = await this.load(userId, bindingId);
        if (session.channel_type !== channelType) {
            throw new CredentialBindingError(
                `Binding is for channel type '${session.channel_type}'.`,
                409
            );
        }
        if (session.state !== BindingState.AUTHORIZED) {
            throw new CredentialBindingError(`Binding is ${session.state}, not authorized.`, 409);
        }
        const raw = await this.messageBus.registryPop(
            MessageBusKeys.channelCredentialBinding(bindingId),
            MessageBusKeys.CREDENTIAL_BINDING_FIELD
        );
        if (raw === null) throw new CredentialBindingError('Binding not found.', 404);
        return BindingSessionSchema.parse(JSON.parse(raw)).credentials;
    }

    private provider(channelType: string) {
        const Channel = this.typeRegistry.get(channelType);
        if (!Channel) {
            throw new CredentialBindingError(
                `Channel type '${channelType}' is not registered.`,
                404
            );
        }
        if (!Channel.credentialBinding) {
            throw new CredentialBindingError(
                `Channel type '${channelType}' has no interactive credential binding.`,
                400
            );
        }
        return new Channel.credentialBinding();
    }

    private async load(userId: string, bindingId: string): Promise<[string, BindingSession]> {
        const raw = await this.messageBus.registryGet(
            MessageBusKeys.channelCredentialBinding(bindingId),
            MessageBusKeys.CREDENTIAL_BINDING_FIELD
        );
        if (raw === null) throw new CredentialBindingError('Binding not found.', 404);
        const session = BindingSessionSchema.parse(JSON.parse(raw));
        if (session.user_id !== userId) {
            throw new CredentialBindingError('Binding not found.', 404);
        }
        return [raw, session];
    }

    private view(bindingId: string, session: BindingSession): BindingView {
        return new BindingView(
            bindingId,
            session.state,
            session.verification_url,
            session.error,
            session.retry_after_secs
        );
    }
}

function applyStep(session: BindingSession, step: BindingStep): void {
    session.state = step.state;
    session.error = step.error;
    if (Object.keys(step.credentials).length > 0) session.credentials = step.credentials;
    if (Object.keys(step.providerState).length > 0) session.provider_state = step.providerState;
    if (step.retryAfterSeconds !== null) session.retry_after_secs = step.retryAfterSeconds;
}
