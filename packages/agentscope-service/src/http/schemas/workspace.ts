import { z } from 'zod';

export const WorkspaceScopeQuerySchema = z.object({
    agent_id: z.string(),
    session_id: z.string(),
});

export const WorkspaceDirectoryQuerySchema = WorkspaceScopeQuerySchema.extend({
    path: z.string().default(''),
});

const booleanQuery = z.preprocess(value => {
    if (typeof value !== 'string') return value;
    const normalized = value.toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'off', 'no'].includes(normalized)) return false;
    return value;
}, z.boolean());

export const WorkspaceFileQuerySchema = WorkspaceScopeQuerySchema.extend({
    path: z.string(),
    download: booleanQuery.default(false),
    token: z.string().optional(),
});

export const AddFromLibraryRequestSchema = z.object({
    mcp_ids: z.array(z.string()),
});

export const AddSkillsFromLibraryRequestSchema = z.object({
    skill_ids: z.array(z.string()),
});

export const AddSkillRequestSchema = z.object({ skill_path: z.string() });
