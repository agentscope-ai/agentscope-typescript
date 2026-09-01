/* eslint-disable jsdoc/require-jsdoc */

import { createEvent, EventType, type AgentEvent } from '@agentscope-ai/agentscope/event';

import type { BusPayload, MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';
import type { AgentRecord, SessionRecord, StorageBase } from '../storage';

/** Durable cross-session UI projection store layered on generic bus primitives. */
export class SessionProjection {
    constructor(private readonly messageBus: MessageBus) {}

    async upsert(
        targetSessionId: string,
        kind: string,
        entryId: string,
        payload: BusPayload
    ): Promise<void> {
        await this.messageBus.registrySet(
            MessageBusKeys.projectionNamespace(targetSessionId),
            MessageBusKeys.projectionField(kind, entryId),
            JSON.stringify(payload)
        );
    }

    async delete(targetSessionId: string, kind: string, entryId: string): Promise<void> {
        await this.messageBus.registryDelete(
            MessageBusKeys.projectionNamespace(targetSessionId),
            MessageBusKeys.projectionField(kind, entryId)
        );
    }

    async list(targetSessionId: string, kind: string): Promise<BusPayload[]> {
        const raw = await this.messageBus.registryGetAll(
            MessageBusKeys.projectionNamespace(targetSessionId)
        );
        const prefix = MessageBusKeys.projectionFieldPrefix(kind);
        return Object.entries(raw)
            .filter(([field]) => field.startsWith(prefix))
            .map(([, value]) => JSON.parse(value) as BusPayload);
    }

    async purge(targetSessionId: string, kind?: string): Promise<void> {
        const namespace = MessageBusKeys.projectionNamespace(targetSessionId);
        if (kind === undefined) {
            await this.messageBus.registryDrop(namespace);
            return;
        }
        const prefix = MessageBusKeys.projectionFieldPrefix(kind);
        const raw = await this.messageBus.registryGetAll(namespace);
        await Promise.all(
            Object.keys(raw)
                .filter(field => field.startsWith(prefix))
                .map(field => this.messageBus.registryDelete(namespace, field))
        );
    }

    async publish(targetSessionId: string, eventName: string, value: BusPayload): Promise<void> {
        const event = createEvent({
            type: EventType.CUSTOM,
            name: eventName,
            value,
        });
        await this.messageBus.sessionPublishEvent(targetSessionId, event as unknown as BusPayload);
    }
}

/** Project team-worker HITL cards onto the leader session. */
export class SubagentHitlProjector {
    static readonly KIND = 'subagent_hitl';
    static readonly EVT_REQUIRE = 'subagent_require_user_confirm';
    static readonly EVT_RESULT = 'subagent_user_confirm_result';

    constructor(private readonly storage: StorageBase) {}

    static entryId(workerSessionId: string, replyId: string): string {
        return `${workerSessionId}:${replyId}`;
    }

    async maybeProject(
        userId: string,
        session: SessionRecord,
        agent: AgentRecord,
        event: AgentEvent,
        projection: SessionProjection
    ): Promise<void> {
        if (!session.team_id || !PROJECTED_EVENT_TYPES.has(event.type)) return;
        const team = await this.storage.getTeam(userId, session.team_id);
        if (!team || team.session_id === session.id) return;
        const replyId =
            'reply_id' in event && typeof event.reply_id === 'string' ? event.reply_id : '';
        if (!replyId) return;

        if (
            event.type === EventType.REQUIRE_USER_CONFIRM ||
            event.type === EventType.REQUIRE_EXTERNAL_EXECUTION
        ) {
            const payload: BusPayload = {
                worker_session_id: session.id,
                worker_agent_id: agent.id,
                worker_agent_name: agent.data.name,
                reply_id: replyId,
                event_type:
                    event.type === EventType.REQUIRE_USER_CONFIRM
                        ? 'require_user_confirm'
                        : 'require_external_execution',
                event: event as unknown as BusPayload,
                created_at: new Date().toISOString(),
            };
            await projection.upsert(
                team.session_id,
                SubagentHitlProjector.KIND,
                SubagentHitlProjector.entryId(session.id, replyId),
                payload
            );
            await projection.publish(team.session_id, SubagentHitlProjector.EVT_REQUIRE, payload);
            return;
        }

        await projection.delete(
            team.session_id,
            SubagentHitlProjector.KIND,
            SubagentHitlProjector.entryId(session.id, replyId)
        );
        await projection.publish(team.session_id, SubagentHitlProjector.EVT_RESULT, {
            worker_session_id: session.id,
            reply_id: replyId,
        });
    }

    static async resolve(
        projection: SessionProjection,
        leaderSessionId: string,
        replyId: string
    ): Promise<BusPayload | null> {
        return (
            (await projection.list(leaderSessionId, SubagentHitlProjector.KIND)).find(
                entry => entry.reply_id === replyId
            ) ?? null
        );
    }

    static purge(projection: SessionProjection, leaderSessionId: string): Promise<void> {
        return projection.purge(leaderSessionId, SubagentHitlProjector.KIND);
    }

    static async dropWorker(
        projection: SessionProjection,
        leaderSessionId: string,
        workerSessionId: string
    ): Promise<void> {
        for (const entry of await projection.list(leaderSessionId, SubagentHitlProjector.KIND)) {
            if (entry.worker_session_id === workerSessionId && typeof entry.reply_id === 'string') {
                await projection.delete(
                    leaderSessionId,
                    SubagentHitlProjector.KIND,
                    SubagentHitlProjector.entryId(workerSessionId, entry.reply_id)
                );
            }
        }
    }
}

const PROJECTED_EVENT_TYPES = new Set<EventType>([
    EventType.REQUIRE_USER_CONFIRM,
    EventType.REQUIRE_EXTERNAL_EXECUTION,
    EventType.USER_CONFIRM_RESULT,
    EventType.EXTERNAL_EXECUTION_RESULT,
    EventType.REPLY_END,
]);
