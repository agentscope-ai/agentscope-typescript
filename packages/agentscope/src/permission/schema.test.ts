import {
    PermissionBehavior,
    PermissionContextSchema,
    PermissionDecisionSchema,
    PermissionMode,
    PermissionRuleSchema,
    parsePermissionContext,
    parsePermissionDecision,
    parsePermissionRule,
} from '.';

describe('permission runtime schemas', () => {
    test('validates a rule and rejects passthrough-free assumptions', () => {
        const input = {
            tool_name: 'Bash',
            rule_content: 'git:*',
            behavior: PermissionBehavior.ALLOW,
            source: 'settings',
        };
        expect(PermissionRuleSchema.parse(input)).toEqual(input);
        expect(parsePermissionRule(input)).toEqual(input);
    });

    test('fills all context defaults without sharing containers', () => {
        const first = parsePermissionContext({});
        const second = PermissionContextSchema.parse({});
        expect(first).toEqual({
            mode: PermissionMode.DEFAULT,
            working_directories: {},
            allow_rules: {},
            deny_rules: {},
            ask_rules: {},
        });
        first.allow_rules.Bash = [];
        expect(second.allow_rules).toEqual({});
    });

    test('fills all decision defaults and strips unknown keys', () => {
        expect(
            parsePermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: 'Confirm',
                ignored: true,
            })
        ).toEqual({
            behavior: PermissionBehavior.ASK,
            message: 'Confirm',
            decision_reason: null,
            updated_input: null,
            suggested_rules: null,
            bypass_immune: false,
        });
        expect(() => PermissionDecisionSchema.parse({ message: 'Missing behavior' })).toThrow();
    });
});
