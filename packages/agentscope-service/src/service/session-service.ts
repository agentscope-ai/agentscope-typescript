/* eslint-disable jsdoc/require-jsdoc */

import { logger } from '@agentscope-ai/agentscope/logger';
import type { Msg, ToolCallBlock } from '@agentscope-ai/agentscope/message';

import type { MessageBus } from '../message-bus';
import type { StorageBase, TeamMember, TeamRecord } from '../storage';
import type { WorkspaceManagerBase } from '../workspace-manager';
import { SessionProjection, SubagentHitlProjector } from './session-projection';

export enum SessionStatus {
    RUNNING = 'running',
    IDLE = 'idle',
    AWAITING_PERMISSION = 'awaiting_permission',
    AWAITING_EXTERNAL_RESULT = 'awaiting_external_result',
}

export interface SessionServiceOptions {
    cancelPollIntervalMs?: number;
}

/** Cross-resource cancel and deletion orchestration for sessions. */
export class SessionService {
    private readonly projection: SessionProjection;
    private readonly cancelPollIntervalMs: number;

    constructor(
        private readonly storage: StorageBase,
        private readonly messageBus: MessageBus,
        private readonly workspaceManager: WorkspaceManagerBase | null = null,
        options: SessionServiceOptions = {}
    ) {
        this.projection = new SessionProjection(messageBus);
        this.cancelPollIntervalMs = options.cancelPollIntervalMs ?? 100;
    }

    async getSessionStatus(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<SessionStatus | null> {
        if (await this.messageBus.sessionIsRunning(sessionId)) return SessionStatus.RUNNING;
        const session = await this.storage.getSession(userId, agentId, sessionId);
        return session ? SessionService.deriveParkedStatus(session.state.context) : null;
    }

    static deriveParkedStatus(context: Msg[]): SessionStatus {
        const last = context.at(-1);
        if (!last || last.role !== 'assistant') return SessionStatus.IDLE;
        const calls = last.content.filter(
            (block): block is ToolCallBlock => block.type === 'tool_call'
        );
        if (calls.some(call => call.state === 'asking')) {
            return SessionStatus.AWAITING_PERMISSION;
        }
        if (calls.some(call => call.state === 'submitted')) {
            return SessionStatus.AWAITING_EXTERNAL_RESULT;
        }
        return SessionStatus.IDLE;
    }

    async cancelSessionRun(sessionId: string, timeoutMs = 10_000): Promise<boolean> {
        await this.messageBus.sessionPublishCancel(sessionId);
        const deadline = Date.now() + timeoutMs;
        while (await this.messageBus.sessionIsRunning(sessionId)) {
            if (Date.now() >= deadline) {
                logger.warning(
                    'Session %s did not release its run lock within %dms; proceeding.',
                    sessionId,
                    timeoutMs
                );
                return false;
            }
            await delay(this.cancelPollIntervalMs);
        }
        return true;
    }

    async deleteSession(userId: string, agentId: string, sessionId: string): Promise<boolean> {
        const workerSessionIds = await this.teamWorkerSessionIds(userId, agentId, sessionId);
        const allSessionIds = [sessionId, ...workerSessionIds];
        const record = await this.storage.getSession(userId, agentId, sessionId);
        const workspaceId = record?.config.workspace_id ?? null;
        await this.purgeSubagentHitl(userId, agentId, sessionId);
        await Promise.all(allSessionIds.map(id => this.cancelSessionRun(id)));
        const deleted = await this.storage.deleteSession(userId, agentId, sessionId);
        await Promise.all(allSessionIds.map(id => this.messageBus.sessionPurge(id)));

        if (deleted && this.workspaceManager && workspaceId) {
            try {
                const workspace = await this.workspaceManager.getWorkspace(
                    userId,
                    agentId,
                    sessionId,
                    workspaceId
                );
                await workspace.purgeSession({ agentId, sessionId });
            } catch (error) {
                logger.warning(
                    'Failed to purge workspace %s for session %s: %s',
                    workspaceId,
                    sessionId,
                    String(error)
                );
            }
        }
        return deleted;
    }

    async deleteTeam(userId: string, teamId: string): Promise<boolean> {
        const team = await this.storage.getTeam(userId, teamId);
        if (!team) return this.storage.deleteTeam(userId, teamId);
        for (const member of await ensureTeamMembers(this.storage, userId, team)) {
            if (member.role === 'created') {
                await this.deleteAgent(member.owner_id, member.agent_id);
            } else {
                await this.deleteSession(member.owner_id, member.agent_id, member.session_id);
            }
        }
        return this.storage.deleteTeam(userId, teamId);
    }

    async deleteAgent(userId: string, agentId: string): Promise<boolean> {
        const workspaces = new Map<string, string>();
        for (const session of await this.storage.listSessions(userId, agentId)) {
            if (session.config.workspace_id) {
                workspaces.set(session.config.workspace_id, session.id);
            }
            if (session.team_id) {
                const team = await this.storage.getTeam(userId, session.team_id);
                if (team && team.session_id !== session.id) {
                    const members = await ensureTeamMembers(this.storage, userId, team);
                    const filtered = members.filter(member => member.session_id !== session.id);
                    if (filtered.length !== members.length) {
                        team.data.members = filtered;
                        team.data.member_ids = team.data.member_ids.filter(id => id !== agentId);
                        await this.storage.upsertTeam(userId, team);
                    }
                }
            }
            await this.deleteSession(userId, agentId, session.id);
        }

        for (const schedule of await this.storage.listSchedules(userId)) {
            if (schedule.agent_id === agentId) await this.deleteSchedule(userId, schedule.id);
        }

        if (this.workspaceManager) {
            for (const [workspaceId, sessionId] of workspaces) {
                try {
                    const workspace = await this.workspaceManager.getWorkspace(
                        userId,
                        agentId,
                        sessionId,
                        workspaceId
                    );
                    await workspace.purgeAgent(agentId);
                } catch (error) {
                    logger.warning(
                        'Failed to purge workspace %s for agent %s: %s',
                        workspaceId,
                        agentId,
                        String(error)
                    );
                }
            }
        }
        return this.storage.deleteAgent(userId, agentId);
    }

    async deleteSchedule(userId: string, scheduleId: string): Promise<boolean> {
        for (const session of await this.storage.listSessionsBySchedule(userId, scheduleId)) {
            await this.deleteSession(userId, session.agent_id, session.id);
        }
        return this.storage.deleteSchedule(userId, scheduleId);
    }

    private async teamWorkerSessionIds(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<string[]> {
        const session = await this.storage.getSession(userId, agentId, sessionId);
        if (!session?.team_id) return [];
        const team = await this.storage.getTeam(userId, session.team_id);
        if (!team || team.session_id !== sessionId) return [];
        return (await ensureTeamMembers(this.storage, userId, team)).map(
            member => member.session_id
        );
    }

    private async purgeSubagentHitl(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<void> {
        try {
            const session = await this.storage.getSession(userId, agentId, sessionId);
            if (!session?.team_id) {
                await SubagentHitlProjector.purge(this.projection, sessionId);
                return;
            }
            const team = await this.storage.getTeam(userId, session.team_id);
            if (!team || team.session_id === sessionId) {
                await SubagentHitlProjector.purge(this.projection, sessionId);
            } else {
                await SubagentHitlProjector.dropWorker(this.projection, team.session_id, sessionId);
            }
        } catch (error) {
            logger.warning(
                'Failed to purge subagent HITL projection for session %s: %s',
                sessionId,
                String(error)
            );
        }
    }
}

async function ensureTeamMembers(
    storage: StorageBase,
    userId: string,
    team: TeamRecord
): Promise<TeamMember[]> {
    if (team.data.members.length > 0) return team.data.members;
    const members: TeamMember[] = [];
    for (const agentId of team.data.member_ids) {
        const session = (await storage.listSessions(userId, agentId))[0];
        if (session) {
            members.push({
                owner_id: userId,
                agent_id: agentId,
                session_id: session.id,
                role: 'created',
            });
        }
    }
    team.data.members = members;
    team.data.member_ids = members.map(member => member.agent_id);
    await storage.upsertTeam(userId, team);
    return members;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
