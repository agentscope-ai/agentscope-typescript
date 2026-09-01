import { CredentialFactory, type CredentialClass } from '@agentscope-ai/agentscope/credential';
import { z } from 'zod';

import type { AgentView, CredentialView } from '../../service';
import { AgentDataSchema, AgentRecordSchema, type AgentRecord } from '../../storage';
import { HTTPError } from '../errors';
import { emptyResponse, jsonResponse } from '../response';
import type { AgentScopeHTTPRouter } from '../router';
import {
    agentDataJSONSchema,
    CreateAgentRequestSchema,
    CreateCredentialRequestSchema,
    ProviderQuerySchema,
    UpdateAgentRequestSchema,
    UpdateCredentialRequestSchema,
} from '../schemas';

/**
 * Register agent, credential, model catalog, and health routes.
 * @param router
 */
export function registerFoundationRoutes(router: AgentScopeHTTPRouter): void {
    registerAgentRoutes(router);
    registerCredentialRoutes(router);
    registerModelRoutes(router);
    registerHealthRoute(router);
}

/**
 *
 * @param router
 */
function registerAgentRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/agent/schema', context => {
        context.userId();
        const full = agentDataJSONSchema();
        const properties = full.properties as Record<string, unknown>;
        return jsonResponse({
            identity: {
                type: 'object',
                title: 'Identity',
                properties: { name: properties.name, system_prompt: properties.system_prompt },
                required: ['name'],
            },
            context_config: z.toJSONSchema(z.record(z.string(), z.unknown())),
            react_config: z.toJSONSchema(z.record(z.string(), z.unknown())),
        });
    });
    router.get('/agent/schema/v2', context => {
        context.userId();
        return jsonResponse({ schema: agentDataJSONSchema() });
    });
    router.get('/agent/', async context => {
        const agents = await context.app.services.resourceAccess.listResource(
            context.userId(),
            'agent'
        );
        return jsonResponse({ agents, total: agents.length });
    });
    router.post('/agent/', async context => {
        const body = (await context.json(CreateAgentRequestSchema)) as z.output<
            typeof CreateAgentRequestSchema
        >;
        const record = AgentRecordSchema.parse({
            user_id: context.userId(),
            data: AgentDataSchema.parse(body),
        });
        await context.app.storage.upsertAgent(record.user_id, record);
        return jsonResponse({ agent_id: record.id }, 201);
    });
    router.patch('/agent/{agent_id}', async context => {
        const body = (await context.json(UpdateAgentRequestSchema)) as z.output<
            typeof UpdateAgentRequestSchema
        >;
        const [ownerId, raw] = await context.app.services.resourceAccess.resolveForEdit(
            context.userId(),
            'agent',
            context.params.agent_id
        );
        const existing = raw as AgentRecord;
        const data = AgentDataSchema.parse({ ...existing.data, ...body });
        const updated = AgentRecordSchema.parse({
            ...existing,
            data,
            updated_at: new Date().toISOString(),
        });
        await context.app.storage.upsertAgent(ownerId, updated);
        return jsonResponse({ ...updated, editable: true } satisfies AgentView);
    });
    router.delete('/agent/{agent_id}', async context => {
        const [ownerId] = await context.app.services.resourceAccess.resolveForEdit(
            context.userId(),
            'agent',
            context.params.agent_id
        );
        if (!(await context.app.services.session.deleteAgent(ownerId, context.params.agent_id))) {
            throw new HTTPError(404, `Agent '${context.params.agent_id}' not found.`);
        }
        return emptyResponse();
    });
}

/**
 *
 * @param router
 */
function registerCredentialRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/credential/schemas', context => {
        context.userId();
        const schemas = CredentialFactory.listSchemas();
        return jsonResponse({ schemas, total: schemas.length });
    });
    router.get('/credential/', async context => {
        const credentials = await context.app.services.resourceAccess.listResource(
            context.userId(),
            'credential'
        );
        return jsonResponse({ credentials, total: credentials.length });
    });
    router.post('/credential/', async context => {
        const body = (await context.json(CreateCredentialRequestSchema)) as z.output<
            typeof CreateCredentialRequestSchema
        >;
        let credential;
        try {
            credential = CredentialFactory.fromDict(body.data);
        } catch (error) {
            throw new HTTPError(422, error instanceof Error ? error.message : String(error));
        }
        const credentialId = await context.app.storage.upsertCredential(
            context.userId(),
            credential
        );
        return jsonResponse({ credential_id: credentialId }, 201);
    });
    router.patch('/credential/{credential_id}', async context => {
        const body = (await context.json(UpdateCredentialRequestSchema)) as z.output<
            typeof UpdateCredentialRequestSchema
        >;
        const [ownerId] = await context.app.services.resourceAccess.resolveForEdit(
            context.userId(),
            'credential',
            context.params.credential_id
        );
        let credential;
        try {
            credential = CredentialFactory.fromDict({
                ...body.data,
                id: context.params.credential_id,
            });
        } catch (error) {
            throw new HTTPError(422, error instanceof Error ? error.message : String(error));
        }
        await context.app.storage.upsertCredential(ownerId, credential);
        const updated = await context.app.storage.getCredential(
            ownerId,
            context.params.credential_id
        );
        if (!updated) throw new HTTPError(500, 'Credential disappeared after update.');
        return jsonResponse({ ...updated, editable: true } satisfies CredentialView);
    });
    router.delete('/credential/{credential_id}', async context => {
        const [ownerId] = await context.app.services.resourceAccess.resolveForEdit(
            context.userId(),
            'credential',
            context.params.credential_id
        );
        await context.app.storage.deleteCredential(ownerId, context.params.credential_id);
        return emptyResponse();
    });
}

/**
 *
 * @param router
 */
function registerModelRoutes(router: AgentScopeHTTPRouter): void {
    router.get('/model/', context => {
        context.userId();
        const { provider } = context.query(ProviderQuerySchema) as z.output<
            typeof ProviderQuerySchema
        >;
        const credential = catalogCredential(provider);
        const models = credential.listModels();
        return jsonResponse({ models, total: models.length });
    });
    router.get('/embedding-model/', context => {
        context.userId();
        const { provider } = context.query(ProviderQuerySchema) as z.output<
            typeof ProviderQuerySchema
        >;
        const credential = catalogCredential(provider);
        const models = credential.listEmbeddingModels();
        return jsonResponse({ models, total: models.length });
    });
    router.get('/tts-model/', context => {
        context.userId();
        const { provider } = context.query(ProviderQuerySchema) as z.output<
            typeof ProviderQuerySchema
        >;
        const credential = catalogCredential(provider);
        const models = credential.listTTSModels();
        return jsonResponse({ models, total: models.length });
    });
}

/**
 *
 * @param router
 */
function registerHealthRoute(router: AgentScopeHTTPRouter): void {
    router.get('/health', context => {
        context.userId();
        const ready = context.app.started;
        const runtime = ready ? 'ok' : 'not_ready';
        const components = {
            storage: 'ok',
            message_bus: 'ok',
            workspace_manager: 'ok',
            background_task_manager: runtime,
            chat_run_registry: runtime,
            scheduler_manager: runtime,
            resource_access_service: runtime,
            chat_service: runtime,
            session_service: runtime,
            mcp_hubs: 'disabled',
            skill_hubs: 'disabled',
            knowledge_base: context.app.knowledgeBaseManager
                ? ready && context.app.services.knowledgeBase
                    ? 'ok'
                    : 'not_ready'
                : 'disabled',
        };
        return jsonResponse(
            { status: ready ? 'ok' : 'not_ready', version: context.app.version, components },
            ready ? 200 : 503
        );
    });
}

/**
 *
 * @param provider
 */
function catalogCredential(provider: string) {
    const Credential = CredentialFactory.getCredentialClass(provider);
    if (!Credential) throw new HTTPError(404, `Provider '${provider}' not found.`);
    return Credential.fromDict(dummyCredentialData(Credential));
}

/**
 *
 * @param Credential
 */
function dummyCredentialData(Credential: CredentialClass): Record<string, unknown> {
    const schema = Credential.schema as {
        properties?: Record<string, { default?: unknown; type?: string }>;
        required?: string[];
    };
    const data: Record<string, unknown> = { type: Credential.credentialType };
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (property.default !== undefined) data[name] = property.default;
    }
    for (const name of schema.required ?? []) {
        if (!(name in data)) data[name] = 'catalog-placeholder';
    }
    return data;
}
