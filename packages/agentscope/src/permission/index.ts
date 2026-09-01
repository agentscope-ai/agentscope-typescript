import { PermissionBehavior, PermissionMode } from './runtime';

export {
    PermissionBehavior,
    PermissionMode,
    CreatePermissionDecisionOptions,
    createPermissionDecision,
} from './runtime';

/**
 * Permission rule for tool usage.
 *
 * A permission rule defines whether a specific tool or tool operation
 * should be allowed, denied, or require user confirmation. The
 * `rule_content` field has different semantics depending on the
 * `tool_name`:
 *
 * - For `Bash`: `rule_content` is a substring pattern matched against the
 *   command. Example: `rule_content="npm install"` matches
 *   `"npm install express"`.
 * - For `Write`/`Read`: `rule_content` is a glob pattern matched against
 *   file paths. Example: `rule_content="src/**"` matches `"src/main.py"`.
 * - For other tools: `rule_content` is a tool-specific filter pattern.
 */
export interface PermissionRule {
    /** The name of the tool this rule applies to (e.g. "Bash", "Write", "Read"). */
    tool_name: string;
    /** Optional filter pattern — semantics depend on `tool_name`. */
    rule_content: string | null;
    /** The permission behavior ("allow", "deny", or "ask"). */
    behavior: PermissionBehavior;
    /** Where this rule originated from (e.g. "userSettings", "projectSettings"). */
    source: string;
}

/**
 * An additional directory included in permission scope.
 *
 * Working directories are used to determine which file paths should be
 * automatically allowed in `ACCEPT_EDITS` mode.
 */
export interface AdditionalWorkingDirectory {
    /** Absolute path to the directory. */
    path: string;
    /**
     * Where this directory permission originated from
     * (e.g. 'userSettings', 'session').
     */
    source: string;
}

/**
 * Context for permission checking.
 *
 * Contains the permission mode, working directories, and all configured
 * permission rules organized by behavior type (allow, deny, ask).
 *
 * Rule maps are keyed by tool name; multiple rules per tool are supported
 * via array values.
 */
export interface PermissionContext {
    /** The current permission mode. Defaults to {@link PermissionMode.DEFAULT}. */
    mode: PermissionMode;
    /** Additional directories allowed for file operations, keyed by path. */
    working_directories: Record<string, AdditionalWorkingDirectory>;
    /** Rules that allow tool execution, keyed by tool name. */
    allow_rules: Record<string, PermissionRule[]>;
    /** Rules that deny tool execution, keyed by tool name. */
    deny_rules: Record<string, PermissionRule[]>;
    /** Rules that require user confirmation, keyed by tool name. */
    ask_rules: Record<string, PermissionRule[]>;
}

/**
 * Factory for an empty {@link PermissionContext} with sensible defaults.
 * Mirrors the Pydantic `default_factory` semantics on the Python side.
 *
 * @param mode - Initial permission mode. Defaults to {@link PermissionMode.DEFAULT}.
 * @returns A fresh `PermissionContext` with empty rule / working-directory maps.
 */
export function createPermissionContext(
    mode: PermissionMode = PermissionMode.DEFAULT
): PermissionContext {
    return {
        mode,
        working_directories: {},
        allow_rules: {},
        deny_rules: {},
        ask_rules: {},
    };
}

/**
 * Decision result from permission checking.
 *
 * Represents the outcome of a permission check, including whether the
 * action should be allowed, denied, or require user confirmation.
 */
export interface PermissionDecision {
    /** The permission behavior decision. */
    behavior: PermissionBehavior;
    /** Human-readable message describing the decision. */
    message: string;
    /**
     * Optional explanation for why this decision was made.
     *
     * Accepts `null` so JSON payloads coming from the Python side
     * (which serialises `None` as `null`) round-trip cleanly.
     */
    decision_reason?: string | null;
    /**
     * Optional modified input data (e.g. sanitized paths).
     *
     * Accepts `null` for the same Python `None` → JSON `null` reason
     * as {@link decision_reason}.
     */
    updated_input?: Record<string, unknown> | null;
    /**
     * Optional list of suggested permission rules for the user to apply.
     *
     * Accepts `null` for the same Python `None` → JSON `null` reason
     * as {@link decision_reason}.
     */
    suggested_rules?: PermissionRule[] | null;
    /**
     * Whether this decision is immune to being silenced by allow rules
     * ("bypass-immune"). Only meaningful when `behavior` is
     * {@link PermissionBehavior.ASK}.
     *
     * A tool sets this to `true` to signal that the operation is dangerous
     * enough that **no allow rule** may convert the `ASK` into an `ALLOW`
     * — the user must explicitly confirm in-the-moment. In
     * {@link PermissionMode.DONT_ASK} where no user is available, a
     * bypass-immune `ASK` is converted to `DENY` rather than silently
     * allowed.
     *
     * Per-mode handling of a `bypass_immune=true` `ASK`:
     * - `DEFAULT` / `ACCEPT_EDITS`: honored — allow rules cannot override.
     * - `EXPLORE`: not applicable (engine resolves EXPLORE via read-only
     *   check and does not invoke `checkPermissions`).
     * - `BYPASS`: intentionally ignored — BYPASS's contract is "the user
     *   has opted out of safety prompts; only deny / ask rules remain as
     *   guardrails." Use deny rules in BYPASS to enforce specific
     *   protections.
     * - `DONT_ASK`: converted to `DENY` (no user available).
     *
     * Default is `false`: a regular `ASK` that may be overridden by an
     * allow rule in `DEFAULT` / `ACCEPT_EDITS`, and is silently allowed by
     * `BYPASS`'s fallback. Tools should set this only for genuine safety
     * checks (e.g. writes to dangerous paths, `rm -rf /`, command-
     * injection patterns) — not for "I'd prefer user input" cases.
     *
     * Note: this field is internal metadata for the permission engine.
     * Callers handling the decision (agent loop, HITL backend, UI) treat a
     * bypass-immune `ASK` the same as a regular `ASK` — both prompt the
     * user. The distinction only governs whether engine-level rules /
     * modes may override it before reaching the caller.
     */
    bypass_immune?: boolean;
}

export { MaybePromise, PermissionTool, PermissionEngine } from './engine';
export {
    PermissionRuleSchema,
    AdditionalWorkingDirectorySchema,
    PermissionContextSchema,
    PermissionDecisionSchema,
    parsePermissionRule,
    parsePermissionContext,
    parsePermissionDecision,
} from './schema';
