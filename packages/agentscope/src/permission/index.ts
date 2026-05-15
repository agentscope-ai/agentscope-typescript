export enum PermissionBehavior {
    ALLOW = 'allow',
    DENY = 'deny',
    ASK = 'ask',
    PASSTHROUGH = 'passthrough',
}

export interface PermissionRule {
    tool_name: string;
    rule_content: string | null;
    behavior: PermissionBehavior;
    source: string;
}
