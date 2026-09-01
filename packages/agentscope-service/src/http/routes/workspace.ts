/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

import { deserializeMcpClient, serializeMcpClient } from '@agentscope-ai/agentscope/workspace';
import { lookup as lookupMediaType } from 'mime-types';
import { z } from 'zod';

import { SkillUploadError, WorkspaceService } from '../../service';
import { MCPRecordSchema, MCPClientWireSchema } from '../../storage';
import { HTTPError } from '../errors';
import {
    emptyResponse,
    iterableResponse,
    jsonResponse,
    quoteHeaderFilename,
    streamingContentType,
} from '../response';
import type { AgentScopeHTTPRouter, HTTPContext } from '../router';
import {
    AddFromLibraryRequestSchema,
    AddSkillRequestSchema,
    AddSkillsFromLibraryRequestSchema,
    WorkspaceDirectoryQuerySchema,
    WorkspaceFileQuerySchema,
    WorkspaceScopeQuerySchema,
} from '../schemas';

/**
 * Register workspace MCP, skill, directory, status, and file routes.
 * @param router
 */
export function registerWorkspaceRoutes(router: AgentScopeHTTPRouter): void {
    registerWorkspaceMCPRoutes(router);
    registerWorkspaceSkillRoutes(router);
    registerWorkspaceFileRoutes(router);
}

/**
 *
 * @param router
 */
function registerWorkspaceMCPRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/workspace/mcp', async context => {
        const scope = workspaceScope(context);
        const workspace = await resolveWorkspace(context, scope);
        const clients = await workspace.listMcps({
            agentId: scope.agent_id,
            sessionId: scope.session_id,
        });
        const result = [];
        for (const client of clients) {
            const base = serializeMcpClient(client);
            try {
                const tools = (await client.listTools()).map(tool => ({
                    name: tool.name,
                    description: tool.description,
                }));
                result.push({ ...base, is_healthy: true, tools, error: null });
            } catch (error) {
                result.push({
                    ...base,
                    is_healthy: false,
                    tools: [],
                    error: describeError(error),
                });
            }
        }
        return jsonResponse(result);
    });
    router.post('/workspace/mcp', async context => {
        const scope = workspaceScope(context);
        const wire = (await context.json(MCPClientWireSchema)) as z.output<
            typeof MCPClientWireSchema
        >;
        const client = deserializeMcpClient(wire);
        const workspace = await resolveWorkspace(context, scope);
        try {
            await workspace.addMcp(client, {
                agentId: scope.agent_id,
                sessionId: scope.session_id,
            });
        } catch (error) {
            throw new HTTPError(409, describeError(error));
        }
        const userId = context.userId();
        if (!(await context.app.storage.getMCPByName(userId, client.name))) {
            await context.app.storage.upsertMCP(
                userId,
                MCPRecordSchema.parse({ user_id: userId, client: wire })
            );
        }
        return emptyResponse(201);
    });
    router.post('/workspace/mcp/from-library', async context => {
        const scope = workspaceScope(context);
        const body = (await context.json(AddFromLibraryRequestSchema)) as z.output<
            typeof AddFromLibraryRequestSchema
        >;
        const workspace = await resolveWorkspace(context, scope);
        const present = new Set(
            (
                await workspace.listMcps({
                    agentId: scope.agent_id,
                    sessionId: scope.session_id,
                })
            ).map(client => client.name)
        );
        const added: string[] = [];
        const failed: Record<string, string> = {};
        for (const id of body.mcp_ids) {
            const record = await context.app.storage.getMCP(context.userId(), id);
            if (!record) {
                failed[id] = 'Not in your library.';
                continue;
            }
            if (present.has(record.client.name)) continue;
            try {
                await workspace.addMcp(deserializeMcpClient(record.client), {
                    agentId: scope.agent_id,
                    sessionId: scope.session_id,
                });
                present.add(record.client.name);
                added.push(record.client.name);
            } catch (error) {
                failed[record.client.name] = describeError(error);
            }
        }
        return jsonResponse({ added, failed });
    });
    router.delete('/workspace/mcp/{mcp_name}', async context => {
        const scope = workspaceScope(context);
        const workspace = await resolveWorkspace(context, scope);
        await workspace.removeMcp(context.params.mcp_name, {
            agentId: scope.agent_id,
            sessionId: scope.session_id,
        });
        return emptyResponse();
    });
}

/**
 *
 * @param router
 */
function registerWorkspaceSkillRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/workspace/skill', async context => {
        const scope = workspaceScope(context);
        const workspace = await resolveWorkspace(context, scope);
        return jsonResponse(
            (await workspace.listSkills({ agentId: scope.agent_id })).map(skill => skill.toJSON())
        );
    });
    router.post('/workspace/skill', async context => {
        const scope = workspaceScope(context);
        const body = (await context.json(AddSkillRequestSchema)) as z.output<
            typeof AddSkillRequestSchema
        >;
        const workspace = await resolveWorkspace(context, scope);
        await workspace.addSkill(body.skill_path, { agentId: scope.agent_id });
        return emptyResponse(201);
    });
    router.post('/workspace/skill/upload', async context => {
        const scope = workspaceScope(context);
        let form: FormData;
        try {
            form = await context.request.formData();
        } catch {
            throw new HTTPError(422, 'Invalid multipart form data.');
        }
        const rawManifest = form.get('manifest');
        const files = form.getAll('files').filter((item): item is File => item instanceof File);
        if (typeof rawManifest !== 'string') throw new HTTPError(422, 'Field required: manifest');
        let manifest: z.output<typeof UploadManifestSchema>;
        try {
            manifest = UploadManifestSchema.parse(JSON.parse(rawManifest));
            WorkspaceService.validateManifest(manifest, files.length);
        } catch (error) {
            throw new HTTPError(422, describeError(error));
        }
        const workspace = await resolveWorkspace(context, scope);
        try {
            await context.app.services.workspace.installSkill(
                workspace,
                WorkspaceService.tarStream(
                    manifest,
                    await Promise.all(files.map(file => FileUploadPart.create(file)))
                ),
                'tar',
                'skill',
                scope.agent_id
            );
        } catch (error) {
            if (error instanceof SkillUploadError || error instanceof Error) {
                throw new HTTPError(422, error.message);
            }
            throw error;
        }
        return emptyResponse(201);
    });
    router.post('/workspace/skill/from-library', async context => {
        const scope = workspaceScope(context);
        const body = (await context.json(AddSkillsFromLibraryRequestSchema)) as z.output<
            typeof AddSkillsFromLibraryRequestSchema
        >;
        const workspace = await resolveWorkspace(context, scope);
        const added: string[] = [];
        const failed: Record<string, string> = {};
        for (const id of body.skill_ids) {
            const record = await context.app.storage.getSkill(context.userId(), id);
            if (!record) {
                failed[id] = 'Not in your library.';
                continue;
            }
            const hub = record.hub_id ? context.app.skillHubs.get(record.hub_id) : null;
            if (!hub) {
                failed[record.name] = `Its hub '${record.hub_id}' is no longer registered.`;
                continue;
            }
            try {
                const archive = await hub.download(
                    context.userId(),
                    record.card_id ?? record.name,
                    record.version
                );
                await context.app.services.workspace.installSkill(
                    workspace,
                    archive.stream,
                    archive.format,
                    record.name,
                    scope.agent_id
                );
                added.push(record.name);
            } catch (error) {
                failed[record.name] = describeError(error);
            }
        }
        return jsonResponse({ added, failed });
    });
    router.delete('/workspace/skill/{skill_name}', async context => {
        const scope = workspaceScope(context);
        const workspace = await resolveWorkspace(context, scope);
        await workspace.removeSkill(context.params.skill_name, { agentId: scope.agent_id });
        return emptyResponse();
    });
}

/**
 *
 * @param router
 */
function registerWorkspaceFileRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/workspace/directories', async context => {
        const query = context.query(WorkspaceDirectoryQuerySchema) as z.output<
            typeof WorkspaceDirectoryQuerySchema
        >;
        const workspace = await resolveWorkspace(context, query);
        const backend = workspace.getBackend();
        const target = backend.absolutePath(query.path, workspace.workdir);
        const entry = await backend.stat(target);
        if (!entry) throw new HTTPError(404, 'Directory not found.');
        if (!entry.isDir) throw new HTTPError(400, 'Requested path is a file, not a directory.');
        return jsonResponse({
            path: target,
            entries: (await backend.scanDirectory(target)).map(item => ({
                name: item.name,
                is_dir: item.isDir,
                size_bytes: item.sizeBytes,
                updated_at: item.mtime,
            })),
        });
    });
    router.get('/workspace/status', async context => {
        const scope = workspaceScope(context);
        return jsonResponse(
            await context.app.services.workspace.readStatus(
                context.userId(),
                scope.agent_id,
                scope.session_id
            )
        );
    });
    router.post('/workspace/files/download-token', async context => {
        const query = context.query(WorkspaceFileQuerySchema) as z.output<
            typeof WorkspaceFileQuerySchema
        >;
        await resolveWorkspace(context, query);
        const result = context.app.services.workspace.signDownloadToken(
            context.userId(),
            query.path
        );
        return jsonResponse({ token: result.token, expires_at: result.expiresAt });
    });
    router.get('/workspace/files', async context => {
        const query = context.query(WorkspaceFileQuerySchema) as z.output<
            typeof WorkspaceFileQuerySchema
        >;
        let userId = context.request.headers.get('x-user-id');
        if (query.token) {
            try {
                userId = context.app.services.workspace.verifyDownloadToken(
                    query.token,
                    query.path
                );
            } catch (error) {
                throw new HTTPError(401, describeError(error));
            }
        }
        if (!userId) throw new HTTPError(401, 'X-User-ID header or download token is required.');
        const workspace = await context.app.services.workspace.resolve(
            userId,
            query.agent_id,
            query.session_id
        );
        const backend = workspace.getBackend();
        const target = backend.absolutePath(query.path, workspace.workdir);
        const basename = backend.basename(target) || 'download';
        const entry = await backend.stat(target);
        if (!entry) throw new HTTPError(404, 'File not found.');
        if (entry.isDir) throw new HTTPError(400, 'Requested path is a directory, not a file.');
        const headers = new Headers({
            'content-type': streamingContentType(
                lookupMediaType(basename) || 'application/octet-stream'
            ),
        });
        if (entry.sizeBytes !== null) headers.set('content-length', String(entry.sizeBytes));
        if (query.download) {
            headers.set(
                'content-disposition',
                `attachment; filename*=UTF-8''${quoteHeaderFilename(basename)}`
            );
        }
        return iterableResponse(backend.readStream(target), { headers });
    });
}

const UploadManifestSchema = z.object({
    entries: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
});

/**
 *
 * @param context
 */
function workspaceScope(context: HTTPContext): z.output<typeof WorkspaceScopeQuerySchema> {
    return context.query(WorkspaceScopeQuerySchema) as z.output<typeof WorkspaceScopeQuerySchema>;
}

/**
 *
 * @param context
 * @param scope
 */
function resolveWorkspace(context: HTTPContext, scope: z.output<typeof WorkspaceScopeQuerySchema>) {
    return context.app.services.workspace.resolve(
        context.userId(),
        scope.agent_id,
        scope.session_id
    );
}

/**
 *
 * @param error
 */
function describeError(error: unknown): string {
    if (error instanceof AggregateError && error.errors.length > 0) {
        return describeError(error.errors[0]);
    }
    if (error instanceof Error && error.cause) return describeError(error.cause);
    return error instanceof Error ? error.message : String(error);
}

/**
 *
 */
class FileUploadPart {
    private offset = 0;
    /**
     *
     * @param bytes
     */
    private constructor(private readonly bytes: Uint8Array) {}

    /**
     *
     * @param file
     */
    static async create(file: File): Promise<FileUploadPart> {
        return new FileUploadPart(new Uint8Array(await file.arrayBuffer()));
    }

    /**
     *
     * @param size
     */
    async read(size: number): Promise<Uint8Array> {
        if (this.offset >= this.bytes.byteLength) return new Uint8Array();
        const chunk = this.bytes.subarray(this.offset, this.offset + size);
        this.offset += chunk.byteLength;
        return chunk;
    }
}
