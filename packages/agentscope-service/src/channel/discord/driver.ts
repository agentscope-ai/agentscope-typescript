/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';

import { logger } from '@agentscope-ai/agentscope/logger';
import type { Client, MessageCreateOptions, SendableChannels } from 'discord.js';

export interface DiscordAttachment {
    filename: string;
    contentType?: string;
    read(): Promise<Buffer>;
}

export interface DiscordInboundMessage {
    id: string;
    channelId: string;
    authorId: string;
    content: string;
    guildId: string | null;
    mentionedUserIds: string[];
    attachments: DiscordAttachment[];
}

export interface DiscordApprovalDecision {
    channelId: string;
    userId: string;
    toolCallId: string;
    approved: boolean;
    agentId: string;
    sessionId: string;
}

export interface DiscordDriverHandlers {
    onMessage(message: DiscordInboundMessage): Promise<void>;
    onApproval(decision: DiscordApprovalDecision): Promise<void>;
    onReady(): void;
}

export interface DiscordChatInfo {
    id: string;
    name: string;
    kind: 'group' | 'private';
}

export interface DiscordPlatformDriver {
    readonly botUserId: string;
    listen(handlers: DiscordDriverHandlers, signal: AbortSignal): Promise<void>;
    close(): Promise<void>;
    sendText(channelId: string, text: string): Promise<boolean>;
    sendFile(channelId: string, data: Uint8Array, fileName: string): Promise<boolean>;
    sendApproval(
        channelId: string,
        content: string,
        decision: Omit<DiscordApprovalDecision, 'channelId' | 'userId' | 'approved'>
    ): Promise<boolean>;
    resolveChat(channelId: string): Promise<DiscordChatInfo | null>;
    listTextChannels(): Promise<Array<{ id: string; name: string }>>;
}

interface StoredApproval {
    approved: boolean;
    decision: Omit<DiscordApprovalDecision, 'channelId' | 'userId' | 'approved'>;
}

/** Discord.js transport kept behind a narrow interface for deterministic tests. */
export class OfficialDiscordDriver implements DiscordPlatformDriver {
    private client: Client | null = null;
    private clientPromise: Promise<Client> | null = null;
    private handlers: DiscordDriverHandlers | null = null;
    private readonly approvals = new Map<string, StoredApproval>();

    constructor(
        private readonly botToken: string,
        private readonly applicationId: string
    ) {}

    get botUserId(): string {
        return this.client?.user?.id ?? this.applicationId;
    }

    async listen(handlers: DiscordDriverHandlers, signal: AbortSignal): Promise<void> {
        this.handlers = handlers;
        const client = await this.ensureClient();
        const discord = await import('discord.js');
        client.on(discord.Events.MessageCreate, message => {
            void handlers.onMessage({
                id: message.id,
                channelId: message.channelId,
                authorId: message.author.id,
                content: message.content ?? '',
                guildId: message.guildId,
                mentionedUserIds: [...message.mentions.users.keys()],
                attachments: [...message.attachments.values()].map(attachment => ({
                    filename: attachment.name,
                    contentType: attachment.contentType ?? undefined,
                    read: async () => {
                        const response = await fetch(attachment.url);
                        if (!response.ok) {
                            throw new Error(
                                `Discord attachment download failed: ${response.status}`
                            );
                        }
                        return Buffer.from(await response.arrayBuffer());
                    },
                })),
            });
        });
        client.on(discord.Events.InteractionCreate, interaction => {
            if (!interaction.isButton()) return;
            const stored = this.approvals.get(interaction.customId);
            if (!stored) return;
            this.approvals.delete(interaction.customId);
            void (async () => {
                await interaction.deferUpdate();
                try {
                    await interaction.message.edit({
                        content: stored.approved ? '✅ Approved' : '🚫 Denied',
                        components: [],
                    });
                } catch {
                    logger.debug('Discord card freeze failed');
                }
                await handlers.onApproval({
                    channelId: interaction.channelId,
                    userId: interaction.user.id,
                    approved: stored.approved,
                    ...stored.decision,
                });
            })().catch(error => {
                logger.error(
                    `Discord approval callback failed: ${error instanceof Error ? error.message : String(error)}`
                );
            });
        });
        client.once(discord.Events.ClientReady, () => handlers.onReady());
        try {
            await client.login(this.botToken);
            if (!client.isReady()) handlers.onReady();
            await waitForAbort(signal);
        } catch (error) {
            client.destroy();
            if (this.client === client) this.client = null;
            throw error;
        }
    }

    async close(): Promise<void> {
        this.client?.destroy();
        this.client = null;
        this.clientPromise = null;
    }

    async sendText(channelId: string, text: string): Promise<boolean> {
        const channel = await this.messageable(channelId);
        if (!channel) return false;
        await channel.send(text);
        return true;
    }

    async sendFile(channelId: string, data: Uint8Array, fileName: string): Promise<boolean> {
        const channel = await this.messageable(channelId);
        if (!channel) return false;
        await channel.send({ files: [{ attachment: Buffer.from(data), name: fileName }] });
        return true;
    }

    async sendApproval(
        channelId: string,
        content: string,
        decision: Omit<DiscordApprovalDecision, 'channelId' | 'userId' | 'approved'>
    ): Promise<boolean> {
        const channel = await this.messageable(channelId);
        if (!channel) return false;
        const discord = await import('discord.js');
        const approveId = `agentscope:${randomUUID()}`;
        const denyId = `agentscope:${randomUUID()}`;
        this.approvals.set(approveId, { approved: true, decision });
        this.approvals.set(denyId, { approved: false, decision });
        const row = new discord.ActionRowBuilder<
            import('discord.js').ButtonBuilder
        >().addComponents(
            new discord.ButtonBuilder()
                .setCustomId(approveId)
                .setLabel('✅ Approve')
                .setStyle(discord.ButtonStyle.Success),
            new discord.ButtonBuilder()
                .setCustomId(denyId)
                .setLabel('❌ Deny')
                .setStyle(discord.ButtonStyle.Danger)
        );
        try {
            const payload: MessageCreateOptions = { content, components: [row] };
            await channel.send(payload);
            return true;
        } catch (error) {
            this.approvals.delete(approveId);
            this.approvals.delete(denyId);
            throw error;
        }
    }

    async resolveChat(channelId: string): Promise<DiscordChatInfo | null> {
        const channel = await this.fetchChannel(channelId);
        if (!channel) return null;
        const discord = await import('discord.js');
        const kind = channel.type === discord.ChannelType.DM ? 'private' : 'group';
        return {
            id: channel.id,
            name: 'name' in channel && typeof channel.name === 'string' ? channel.name : '',
            kind,
        };
    }

    async listTextChannels(): Promise<Array<{ id: string; name: string }>> {
        const client = await this.ensureClient();
        const discord = await import('discord.js');
        const guilds = (await client.rest.get(discord.Routes.userGuilds())) as Array<{
            id: string;
            name: string;
        }>;
        const results: Array<{ id: string; name: string }> = [];
        for (const guild of guilds) {
            const channels = (await client.rest.get(
                discord.Routes.guildChannels(guild.id)
            )) as Array<{ id: string; name?: string; type: number }>;
            for (const channel of channels) {
                if (channel.type !== discord.ChannelType.GuildText) continue;
                results.push({ id: channel.id, name: `${guild.name}#${channel.name ?? ''}` });
            }
        }
        return results;
    }

    private async messageable(channelId: string): Promise<SendableChannels | null> {
        const channel = await this.fetchChannel(channelId);
        return channel?.isSendable() ? channel : null;
    }

    private async fetchChannel(channelId: string) {
        if (!/^\d+$/.test(channelId)) return null;
        const client = await this.ensureClient();
        return client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
    }

    private async ensureClient(): Promise<Client> {
        if (this.client) return this.client;
        if (!this.clientPromise) {
            this.clientPromise = (async () => {
                const discord = await import('discord.js');
                const client = new discord.Client({
                    intents: [
                        discord.GatewayIntentBits.Guilds,
                        discord.GatewayIntentBits.GuildMessages,
                        discord.GatewayIntentBits.DirectMessages,
                        discord.GatewayIntentBits.MessageContent,
                    ],
                    partials: [discord.Partials.Channel],
                });
                client.rest.setToken(this.botToken);
                this.client = client;
                return client;
            })().finally(() => {
                this.clientPromise = null;
            });
        }
        return this.clientPromise;
    }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve =>
        signal.addEventListener('abort', () => resolve(), { once: true })
    );
}
