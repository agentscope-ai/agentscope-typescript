import {
    PermissionBehavior,
    PermissionContext,
    PermissionDecision,
    PermissionEngine,
    PermissionMode,
    PermissionRule,
    PermissionTool,
    createPermissionContext,
    createPermissionDecision,
} from '.';

type ToolOverrides = Partial<Omit<PermissionTool, 'name'>>;

/**
 * Create a configurable permission tool used by engine tests.
 * @param overrides
 * @returns A fake permission tool.
 */
function createTool(overrides: ToolOverrides = {}): PermissionTool {
    return {
        name: 'Write',
        checkPermissions: () =>
            createPermissionDecision({
                behavior: PermissionBehavior.PASSTHROUGH,
                message: 'Tool deferred to the engine',
            }),
        checkReadOnly: () => false,
        matchRule: (content, input) => String(input.file_path ?? '').includes(content),
        generateSuggestions: () => [
            {
                tool_name: 'Write',
                rule_content: '/tmp/**',
                behavior: PermissionBehavior.ALLOW,
                source: 'tool',
            },
        ],
        ...overrides,
    };
}

/**
 * Create a Write permission rule used by engine tests.
 * @param behavior
 * @param ruleContent
 * @param source
 * @returns A permission rule.
 */
function rule(
    behavior: PermissionBehavior,
    ruleContent: string | null = 'match',
    source = 'test'
): PermissionRule {
    return {
        tool_name: 'Write',
        rule_content: ruleContent,
        behavior,
        source,
    };
}

describe('permission contracts', () => {
    test('creates fresh Python-compatible context defaults', () => {
        const first = createPermissionContext();
        const second = createPermissionContext();

        expect(first).toEqual({
            mode: PermissionMode.DEFAULT,
            working_directories: {},
            allow_rules: {},
            deny_rules: {},
            ask_rules: {},
        });
        expect(first.allow_rules).not.toBe(second.allow_rules);
    });

    test('creates all PermissionDecision dataclass defaults', () => {
        expect(
            createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: 'Confirm',
            })
        ).toEqual({
            behavior: PermissionBehavior.ASK,
            message: 'Confirm',
            decision_reason: null,
            updated_input: null,
            suggested_rules: null,
            bypass_immune: false,
        });
    });
});

describe('PermissionEngine rule priority', () => {
    test('routes rules by behavior and ignores passthrough rules', () => {
        const context = createPermissionContext();
        const engine = new PermissionEngine(context);
        engine.addRule(rule(PermissionBehavior.ALLOW));
        engine.addRule(rule(PermissionBehavior.DENY));
        engine.addRule(rule(PermissionBehavior.ASK));
        engine.addRule(rule(PermissionBehavior.PASSTHROUGH));

        expect(context).toEqual({
            mode: PermissionMode.DEFAULT,
            working_directories: {},
            allow_rules: { Write: [rule(PermissionBehavior.ALLOW)] },
            deny_rules: { Write: [rule(PermissionBehavior.DENY)] },
            ask_rules: { Write: [rule(PermissionBehavior.ASK)] },
        });
    });

    test('applies deny before ask, read-only, tool, and allow', async () => {
        const engine = new PermissionEngine(createPermissionContext());
        engine.addRule(rule(PermissionBehavior.ALLOW));
        engine.addRule(rule(PermissionBehavior.ASK));
        engine.addRule(rule(PermissionBehavior.DENY));

        await expect(
            engine.checkPermission(createTool({ checkReadOnly: () => true }), {
                file_path: 'match',
            })
        ).resolves.toEqual({
            behavior: PermissionBehavior.DENY,
            message: 'Permission to use Write has been denied',
            decision_reason: 'Rule: match',
            updated_input: null,
            suggested_rules: null,
            bypass_immune: false,
        });
    });

    test('applies ask before read-only and attaches suggestions', async () => {
        const engine = new PermissionEngine(createPermissionContext());
        engine.addRule(rule(PermissionBehavior.ASK));

        await expect(
            engine.checkPermission(createTool({ checkReadOnly: () => true }), {
                file_path: 'match',
            })
        ).resolves.toMatchObject({
            behavior: PermissionBehavior.ASK,
            message: 'Permission required for Write',
            decision_reason: 'Rule: match',
            suggested_rules: [rule(PermissionBehavior.ALLOW, '/tmp/**', 'tool')],
        });
    });

    test('treats null and empty rule content as a tool-wide match', async () => {
        for (const content of [null, '']) {
            const engine = new PermissionEngine(createPermissionContext());
            engine.addRule(rule(PermissionBehavior.DENY, content));
            const tool = createTool({ matchRule: () => false });

            await expect(engine.checkPermission(tool, {})).resolves.toMatchObject({
                behavior: PermissionBehavior.DENY,
                decision_reason: `Rule: ${content}`,
            });
        }
    });

    test('supports synchronous and asynchronous tool hooks', async () => {
        const context = createPermissionContext();
        const engine = new PermissionEngine(context);
        engine.addRule(rule(PermissionBehavior.ALLOW));
        const input = { file_path: 'match' };
        const tool = createTool({
            matchRule: async () => true,
            generateSuggestions: async () => [],
        });

        await expect(engine.checkPermission(tool, input)).resolves.toEqual({
            behavior: PermissionBehavior.ALLOW,
            message: 'Permission granted for Write',
            decision_reason: null,
            updated_input: input,
            suggested_rules: null,
            bypass_immune: false,
        });
    });
});

describe.each([PermissionMode.DEFAULT, PermissionMode.ACCEPT_EDITS])(
    'PermissionEngine %s mode',
    mode => {
        test('auto-allows read-only calls', async () => {
            const engine = new PermissionEngine(createPermissionContext(mode));
            await expect(
                engine.checkPermission(createTool({ checkReadOnly: async () => true }), {})
            ).resolves.toEqual({
                behavior: PermissionBehavior.ALLOW,
                message: 'Permission granted for Write (read-only invocation)',
                decision_reason: 'Read-only operations are auto-allowed',
                updated_input: null,
                suggested_rules: null,
                bypass_immune: false,
            });
        });

        test('returns tool allow and deny decisions unchanged', async () => {
            for (const behavior of [PermissionBehavior.ALLOW, PermissionBehavior.DENY]) {
                const decision = createPermissionDecision({ behavior, message: 'Tool verdict' });
                const engine = new PermissionEngine(createPermissionContext(mode));
                await expect(
                    engine.checkPermission(createTool({ checkPermissions: () => decision }), {})
                ).resolves.toBe(decision);
            }
        });

        test('does not let an allow rule override a bypass-immune ask', async () => {
            const engine = new PermissionEngine(createPermissionContext(mode));
            engine.addRule(rule(PermissionBehavior.ALLOW, null));
            const safetyAsk = createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: 'Safety confirmation required',
                decisionReason: 'Safety check',
                bypassImmune: true,
            });

            await expect(
                engine.checkPermission(createTool({ checkPermissions: async () => safetyAsk }), {})
            ).resolves.toBe(safetyAsk);
            expect(safetyAsk.suggested_rules).toEqual([
                rule(PermissionBehavior.ALLOW, '/tmp/**', 'tool'),
            ]);
        });

        test('lets an allow rule override a regular ask', async () => {
            const engine = new PermissionEngine(createPermissionContext(mode));
            engine.addRule(rule(PermissionBehavior.ALLOW, null));
            await expect(
                engine.checkPermission(
                    createTool({
                        checkPermissions: () =>
                            createPermissionDecision({
                                behavior: PermissionBehavior.ASK,
                                message: 'Regular confirmation',
                            }),
                    }),
                    {}
                )
            ).resolves.toMatchObject({ behavior: PermissionBehavior.ALLOW });
        });

        test('falls back to ask with suggestions', async () => {
            const engine = new PermissionEngine(createPermissionContext(mode));
            await expect(engine.checkPermission(createTool(), {})).resolves.toEqual({
                behavior: PermissionBehavior.ASK,
                message: 'Permission required for Write',
                decision_reason: `Mode: ${mode}`,
                updated_input: null,
                suggested_rules: [rule(PermissionBehavior.ALLOW, '/tmp/**', 'tool')],
                bypass_immune: false,
            });
        });
    }
);

describe('PermissionEngine explore mode', () => {
    test('allows only read-only invocations and never consults the tool verdict', async () => {
        const checkPermissions = jest.fn(() =>
            createPermissionDecision({
                behavior: PermissionBehavior.ALLOW,
                message: 'Tool allowed',
            })
        );
        const engine = new PermissionEngine(createPermissionContext(PermissionMode.EXPLORE));

        await expect(engine.checkPermission(createTool({ checkPermissions }), {})).resolves.toEqual(
            {
                behavior: PermissionBehavior.DENY,
                message: 'Permission denied for Write (explore mode is read-only)',
                decision_reason: 'Explore mode does not allow modifications',
                updated_input: null,
                suggested_rules: null,
                bypass_immune: false,
            }
        );
        expect(checkPermissions).not.toHaveBeenCalled();
    });

    test('does not allow an allow rule to grant write access', async () => {
        const engine = new PermissionEngine(createPermissionContext(PermissionMode.EXPLORE));
        engine.addRule(rule(PermissionBehavior.ALLOW, null));
        await expect(engine.checkPermission(createTool(), {})).resolves.toMatchObject({
            behavior: PermissionBehavior.DENY,
        });
    });
});

describe('PermissionEngine bypass mode', () => {
    test('honors explicit ask rules but ignores tool safety asks', async () => {
        const explicit = new PermissionEngine(createPermissionContext(PermissionMode.BYPASS));
        explicit.addRule(rule(PermissionBehavior.ASK, null));
        await expect(explicit.checkPermission(createTool(), {})).resolves.toMatchObject({
            behavior: PermissionBehavior.ASK,
        });

        const fallback = new PermissionEngine(createPermissionContext(PermissionMode.BYPASS));
        await expect(
            fallback.checkPermission(
                createTool({
                    checkPermissions: () =>
                        createPermissionDecision({
                            behavior: PermissionBehavior.ASK,
                            message: 'Safety confirmation required',
                            bypassImmune: true,
                        }),
                }),
                {}
            )
        ).resolves.toEqual({
            behavior: PermissionBehavior.ALLOW,
            message: 'Permission granted for Write (bypass mode)',
            decision_reason: 'Bypass mode allows all operations',
            updated_input: null,
            suggested_rules: null,
            bypass_immune: false,
        });
    });
});

describe('PermissionEngine dont-ask mode', () => {
    test('converts an ask rule to deny and preserves suggestions', async () => {
        const engine = new PermissionEngine(createPermissionContext(PermissionMode.DONT_ASK));
        engine.addRule(rule(PermissionBehavior.ASK, null));
        await expect(engine.checkPermission(createTool(), {})).resolves.toEqual({
            behavior: PermissionBehavior.DENY,
            message:
                'Permission denied for Write (dont_ask mode - ASK converted to DENY, user not available)',
            decision_reason: 'DONT_ASK mode converted ASK to DENY. Original reason: Rule: null',
            updated_input: null,
            suggested_rules: [rule(PermissionBehavior.ALLOW, '/tmp/**', 'tool')],
            bypass_immune: false,
        });
    });

    test('converts bypass-immune tool asks and never returns ask', async () => {
        const engine = new PermissionEngine(createPermissionContext(PermissionMode.DONT_ASK));
        await expect(
            engine.checkPermission(
                createTool({
                    checkPermissions: () =>
                        createPermissionDecision({
                            behavior: PermissionBehavior.ASK,
                            message: 'Safety confirmation',
                            decisionReason: 'Safety reason',
                            bypassImmune: true,
                        }),
                }),
                {}
            )
        ).resolves.toMatchObject({
            behavior: PermissionBehavior.DENY,
            decision_reason: 'DONT_ASK mode converted ASK to DENY. Original reason: Safety reason',
        });
    });

    test('falls back to deny', async () => {
        const engine = new PermissionEngine(createPermissionContext(PermissionMode.DONT_ASK));
        await expect(engine.checkPermission(createTool(), {})).resolves.toEqual({
            behavior: PermissionBehavior.DENY,
            message: 'Permission denied for Write (dont_ask mode - user not available)',
            decision_reason: 'User is not available to answer permission prompts',
            updated_input: null,
            suggested_rules: null,
            bypass_immune: false,
        });
    });
});

describe('PermissionEngine validation', () => {
    test('rejects an unknown runtime mode', async () => {
        const context = createPermissionContext();
        context.mode = 'invalid' as PermissionMode;
        await expect(
            new PermissionEngine(context).checkPermission(createTool(), {})
        ).rejects.toThrow('Unknown permission mode: invalid');
    });

    test('keeps the context available to tool checks', async () => {
        const context = createPermissionContext(PermissionMode.ACCEPT_EDITS);
        const seen: PermissionContext[] = [];
        const decision: PermissionDecision = createPermissionDecision({
            behavior: PermissionBehavior.DENY,
            message: 'No',
        });
        const engine = new PermissionEngine(context);
        await engine.checkPermission(
            createTool({
                checkPermissions: (_input, received) => {
                    seen.push(received);
                    return decision;
                },
            }),
            {}
        );
        expect(seen).toEqual([context]);
    });
});
