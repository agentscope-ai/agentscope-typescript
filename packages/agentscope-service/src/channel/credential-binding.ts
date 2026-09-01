/* eslint-disable jsdoc/require-jsdoc */

export enum BindingState {
    PENDING = 'pending',
    AUTHORIZED = 'authorized',
    FAILED = 'failed',
    CANCELLED = 'cancelled',
}

export function isTerminalBindingState(state: BindingState): boolean {
    return state !== BindingState.PENDING;
}

export interface BindingStepOptions {
    state?: BindingState;
    verificationUrl?: string;
    credentials?: Record<string, unknown>;
    error?: string;
    providerState?: Record<string, unknown>;
    retryAfterSeconds?: number | null;
    expiresInSeconds?: number;
}

/** One stateless platform credential-binding step. */
export class BindingStep {
    readonly state: BindingState;
    readonly verificationUrl: string;
    readonly credentials: Record<string, unknown>;
    readonly error: string;
    readonly providerState: Record<string, unknown>;
    readonly retryAfterSeconds: number | null;
    readonly expiresInSeconds: number;

    constructor(options: BindingStepOptions = {}) {
        this.state = options.state ?? BindingState.PENDING;
        this.verificationUrl = options.verificationUrl ?? '';
        this.credentials = options.credentials ?? {};
        this.error = options.error ?? '';
        this.providerState = options.providerState ?? {};
        this.retryAfterSeconds = options.retryAfterSeconds ?? null;
        this.expiresInSeconds = options.expiresInSeconds ?? 600;
    }
}

/** Stateless platform adapter for interactive credential acquisition. */
export abstract class CredentialBindingBase {
    abstract begin(): Promise<BindingStep>;
    abstract advance(providerState: Record<string, unknown>): Promise<BindingStep>;
}

export type CredentialBindingConstructor = new () => CredentialBindingBase;
