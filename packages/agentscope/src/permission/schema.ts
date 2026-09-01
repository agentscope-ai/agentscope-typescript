import { z } from 'zod';

import type { PermissionContext, PermissionDecision } from './index';

import { PermissionBehavior, PermissionMode } from './runtime';

/** Runtime schema for a Python-compatible permission rule. */
export const PermissionRuleSchema = z.object({
    tool_name: z.string(),
    rule_content: z.string().nullable(),
    behavior: z.nativeEnum(PermissionBehavior),
    source: z.string(),
});

/** Runtime schema for an additional working directory. */
export const AdditionalWorkingDirectorySchema = z.object({
    path: z.string(),
    source: z.string(),
});

const ruleMapSchema = z.record(z.string(), z.array(PermissionRuleSchema));

/** Runtime schema for persisted permission context. */
export const PermissionContextSchema = z.object({
    mode: z.nativeEnum(PermissionMode).default(PermissionMode.DEFAULT),
    working_directories: z.record(z.string(), AdditionalWorkingDirectorySchema).default(() => ({})),
    allow_rules: ruleMapSchema.default(() => ({})),
    deny_rules: ruleMapSchema.default(() => ({})),
    ask_rules: ruleMapSchema.default(() => ({})),
});

/** Runtime schema for a complete permission decision. */
export const PermissionDecisionSchema = z.object({
    behavior: z.nativeEnum(PermissionBehavior),
    message: z.string(),
    decision_reason: z.string().nullable().default(null),
    updated_input: z.record(z.string(), z.unknown()).nullable().default(null),
    suggested_rules: z.array(PermissionRuleSchema).nullable().default(null),
    bypass_immune: z.boolean().default(false),
});

/**
 * Parse one permission rule.
 * @param value Unknown wire value.
 * @returns A validated rule.
 */
export function parsePermissionRule(value: unknown) {
    return PermissionRuleSchema.parse(value);
}

/**
 * Parse a permission context and apply Python defaults.
 * @param value Unknown wire value.
 * @returns A validated context.
 */
export function parsePermissionContext(value: unknown): PermissionContext {
    return PermissionContextSchema.parse(value);
}

/**
 * Parse a permission decision and apply Python defaults.
 * @param value Unknown wire value.
 * @returns A validated decision.
 */
export function parsePermissionDecision(value: unknown): PermissionDecision {
    return PermissionDecisionSchema.parse(value);
}
