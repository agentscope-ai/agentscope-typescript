import type { PermissionContext, PermissionDecision, PermissionRule } from './index';

import { PermissionBehavior, PermissionMode, createPermissionDecision } from './runtime';

/** A value returned directly or through a promise by a tool hook. */
export type MaybePromise<T> = T | Promise<T>;

/** Structural contract required by the permission engine. */
export interface PermissionTool {
    name: string;
    checkPermissions(
        toolInput: Record<string, unknown>,
        context: PermissionContext
    ): MaybePromise<PermissionDecision>;
    checkReadOnly(toolInput: Record<string, unknown>): MaybePromise<boolean>;
    matchRule(ruleContent: string, toolInput: Record<string, unknown>): MaybePromise<boolean>;
    generateSuggestions(toolInput: Record<string, unknown>): MaybePromise<PermissionRule[]>;
}

/** Evaluate tool calls using the same ordered policies as Python AgentScope. */
export class PermissionEngine {
    readonly context: PermissionContext;

    /**
     * Create a permission engine.
     * @param context Mutable permission context shared with tool checks.
     */
    constructor(context: PermissionContext) {
        this.context = context;
    }

    /**
     * Add a rule to the matching behavior bucket.
     * @param rule Rule to add. PASSTHROUGH rules are ignored.
     */
    addRule(rule: PermissionRule): void {
        const rules =
            rule.behavior === PermissionBehavior.ALLOW
                ? this.context.allow_rules
                : rule.behavior === PermissionBehavior.DENY
                  ? this.context.deny_rules
                  : rule.behavior === PermissionBehavior.ASK
                    ? this.context.ask_rules
                    : undefined;
        if (!rules) return;
        (rules[rule.tool_name] ??= []).push(rule);
    }

    /**
     * Check permission for one tool invocation.
     * @param tool Tool supplying matching and safety hooks.
     * @param toolInput Tool call input.
     * @returns The final decision for the active mode.
     */
    async checkPermission(
        tool: PermissionTool,
        toolInput: Record<string, unknown>
    ): Promise<PermissionDecision> {
        switch (this.context.mode) {
            case PermissionMode.DEFAULT:
            case PermissionMode.ACCEPT_EDITS:
                return this.checkInteractive(tool, toolInput);
            case PermissionMode.EXPLORE:
                return this.checkExplore(tool, toolInput);
            case PermissionMode.BYPASS:
                return this.checkBypass(tool, toolInput);
            case PermissionMode.DONT_ASK:
                return this.checkDontAsk(tool, toolInput);
            default:
                throw new Error(`Unknown permission mode: ${String(this.context.mode)}`);
        }
    }

    /**
     * Run the shared DEFAULT and ACCEPT_EDITS policy.
     * @param tool
     * @param toolInput
     * @returns The final interactive-mode decision.
     */
    private async checkInteractive(
        tool: PermissionTool,
        toolInput: Record<string, unknown>
    ): Promise<PermissionDecision> {
        const deny = await this.checkRules(tool, toolInput, PermissionBehavior.DENY);
        if (deny) return deny;
        const ask = await this.checkRules(tool, toolInput, PermissionBehavior.ASK);
        if (ask) return this.withSuggestions(ask, tool, toolInput);
        const readOnly = await this.checkReadOnly(tool, toolInput);
        if (readOnly) return readOnly;

        const toolDecision = await tool.checkPermissions(toolInput, this.context);
        if (
            toolDecision.behavior === PermissionBehavior.ALLOW ||
            toolDecision.behavior === PermissionBehavior.DENY
        ) {
            return toolDecision;
        }
        if (this.isSafetyAsk(toolDecision)) {
            return this.withSuggestions(toolDecision, tool, toolInput);
        }

        const allow = await this.checkRules(tool, toolInput, PermissionBehavior.ALLOW);
        if (allow) return allow;
        return this.withSuggestions(
            createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: `Permission required for ${tool.name}`,
                decisionReason: `Mode: ${this.context.mode}`,
            }),
            tool,
            toolInput
        );
    }

    /**
     * Run the read-only EXPLORE policy.
     * @param tool
     * @param toolInput
     * @returns The final explore-mode decision.
     */
    private async checkExplore(
        tool: PermissionTool,
        toolInput: Record<string, unknown>
    ): Promise<PermissionDecision> {
        const deny = await this.checkRules(tool, toolInput, PermissionBehavior.DENY);
        if (deny) return deny;
        const ask = await this.checkRules(tool, toolInput, PermissionBehavior.ASK);
        if (ask) return this.withSuggestions(ask, tool, toolInput);
        const readOnly = await this.checkReadOnly(tool, toolInput);
        if (readOnly) return readOnly;
        return createPermissionDecision({
            behavior: PermissionBehavior.DENY,
            message: `Permission denied for ${tool.name} (explore mode is read-only)`,
            decisionReason: 'Explore mode does not allow modifications',
        });
    }

    /**
     * Run the permissive BYPASS policy.
     * @param tool
     * @param toolInput
     * @returns The final bypass-mode decision.
     */
    private async checkBypass(
        tool: PermissionTool,
        toolInput: Record<string, unknown>
    ): Promise<PermissionDecision> {
        const deny = await this.checkRules(tool, toolInput, PermissionBehavior.DENY);
        if (deny) return deny;
        const ask = await this.checkRules(tool, toolInput, PermissionBehavior.ASK);
        if (ask) return this.withSuggestions(ask, tool, toolInput);
        const readOnly = await this.checkReadOnly(tool, toolInput);
        if (readOnly) return readOnly;

        const toolDecision = await tool.checkPermissions(toolInput, this.context);
        if (
            toolDecision.behavior === PermissionBehavior.ALLOW ||
            toolDecision.behavior === PermissionBehavior.DENY
        ) {
            return toolDecision;
        }
        const allow = await this.checkRules(tool, toolInput, PermissionBehavior.ALLOW);
        if (allow) return allow;
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: `Permission granted for ${tool.name} (bypass mode)`,
            decisionReason: 'Bypass mode allows all operations',
        });
    }

    /**
     * Run the unattended DONT_ASK policy.
     * @param tool
     * @param toolInput
     * @returns The final decision, which is never ASK.
     */
    private async checkDontAsk(
        tool: PermissionTool,
        toolInput: Record<string, unknown>
    ): Promise<PermissionDecision> {
        const deny = await this.checkRules(tool, toolInput, PermissionBehavior.DENY);
        if (deny) return deny;
        const ask = await this.checkRules(tool, toolInput, PermissionBehavior.ASK);
        if (ask) {
            return this.convertAskToDeny(tool, await this.withSuggestions(ask, tool, toolInput));
        }
        const readOnly = await this.checkReadOnly(tool, toolInput);
        if (readOnly) return readOnly;

        const toolDecision = await tool.checkPermissions(toolInput, this.context);
        if (
            toolDecision.behavior === PermissionBehavior.ALLOW ||
            toolDecision.behavior === PermissionBehavior.DENY
        ) {
            return toolDecision;
        }
        if (this.isSafetyAsk(toolDecision)) {
            return this.convertAskToDeny(
                tool,
                await this.withSuggestions(toolDecision, tool, toolInput)
            );
        }
        const allow = await this.checkRules(tool, toolInput, PermissionBehavior.ALLOW);
        if (allow) return allow;
        return createPermissionDecision({
            behavior: PermissionBehavior.DENY,
            message: `Permission denied for ${tool.name} (dont_ask mode - user not available)`,
            decisionReason: 'User is not available to answer permission prompts',
        });
    }

    /**
     * Convert an ASK into the traceable DENY required by DONT_ASK.
     * @param tool
     * @param askDecision
     * @returns A converted deny decision.
     */
    private convertAskToDeny(
        tool: PermissionTool,
        askDecision: PermissionDecision
    ): PermissionDecision {
        return createPermissionDecision({
            behavior: PermissionBehavior.DENY,
            message:
                `Permission denied for ${tool.name} ` +
                '(dont_ask mode - ASK converted to DENY, user not available)',
            decisionReason:
                'DONT_ASK mode converted ASK to DENY. ' +
                `Original reason: ${String(askDecision.decision_reason)}`,
            suggestedRules: askDecision.suggested_rules,
        });
    }

    /**
     * Return whether a tool ASK cannot be overridden by an allow rule.
     * @param decision
     * @returns Whether the decision is a bypass-immune ASK.
     */
    private isSafetyAsk(decision: PermissionDecision): boolean {
        return decision.behavior === PermissionBehavior.ASK && decision.bypass_immune === true;
    }

    /**
     * Return an ALLOW decision for read-only invocations.
     * @param tool
     * @param toolInput
     * @returns An allow decision when read-only, otherwise undefined.
     */
    private async checkReadOnly(
        tool: PermissionTool,
        toolInput: Record<string, unknown>
    ): Promise<PermissionDecision | undefined> {
        if (!(await tool.checkReadOnly(toolInput))) return undefined;
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: `Permission granted for ${tool.name} (read-only invocation)`,
            decisionReason: 'Read-only operations are auto-allowed',
        });
    }

    /**
     * Return the first matching decision from one rule bucket.
     * @param tool
     * @param toolInput
     * @param behavior
     * @returns The first matching rule decision, if any.
     */
    private async checkRules(
        tool: PermissionTool,
        toolInput: Record<string, unknown>,
        behavior: PermissionBehavior.ALLOW | PermissionBehavior.DENY | PermissionBehavior.ASK
    ): Promise<PermissionDecision | undefined> {
        const rules =
            behavior === PermissionBehavior.ALLOW
                ? this.context.allow_rules
                : behavior === PermissionBehavior.DENY
                  ? this.context.deny_rules
                  : this.context.ask_rules;
        for (const rule of rules[tool.name] ?? []) {
            if (rule.rule_content && !(await tool.matchRule(rule.rule_content, toolInput)))
                continue;
            if (behavior === PermissionBehavior.ALLOW) {
                return createPermissionDecision({
                    behavior,
                    message: `Permission granted for ${tool.name}`,
                    updatedInput: toolInput,
                });
            }
            return createPermissionDecision({
                behavior,
                message:
                    behavior === PermissionBehavior.DENY
                        ? `Permission to use ${tool.name} has been denied`
                        : `Permission required for ${tool.name}`,
                decisionReason: `Rule: ${String(rule.rule_content)}`,
            });
        }
        return undefined;
    }

    /**
     * Attach tool-generated rule suggestions to a decision.
     * @param decision
     * @param tool
     * @param toolInput
     * @returns The same decision with generated suggestions.
     */
    private async withSuggestions(
        decision: PermissionDecision,
        tool: PermissionTool,
        toolInput: Record<string, unknown>
    ): Promise<PermissionDecision> {
        decision.suggested_rules = await tool.generateSuggestions(toolInput);
        return decision;
    }
}
