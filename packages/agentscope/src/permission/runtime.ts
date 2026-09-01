import type { PermissionDecision, PermissionRule } from './index';

/** The policy used to resolve permission requests. */
export enum PermissionMode {
    DEFAULT = 'default',
    ACCEPT_EDITS = 'accept_edits',
    EXPLORE = 'explore',
    BYPASS = 'bypass',
    DONT_ASK = 'dont_ask',
}

/** The outcome of one permission check. */
export enum PermissionBehavior {
    ALLOW = 'allow',
    DENY = 'deny',
    ASK = 'ask',
    PASSTHROUGH = 'passthrough',
}

/** Camel-case options used to create a Python-compatible decision payload. */
export interface CreatePermissionDecisionOptions {
    behavior: PermissionBehavior;
    message: string;
    decisionReason?: string | null;
    updatedInput?: Record<string, unknown> | null;
    suggestedRules?: PermissionRule[] | null;
    bypassImmune?: boolean;
}

/**
 * Create a complete permission decision with Python dataclass defaults.
 * @param options Decision fields using idiomatic TypeScript names.
 * @returns A Python-compatible wire payload.
 */
export function createPermissionDecision(
    options: CreatePermissionDecisionOptions
): Required<PermissionDecision> {
    return {
        behavior: options.behavior,
        message: options.message,
        decision_reason: options.decisionReason ?? null,
        updated_input: options.updatedInput ?? null,
        suggested_rules: options.suggestedRules ?? null,
        bypass_immune: options.bypassImmune ?? false,
    };
}
