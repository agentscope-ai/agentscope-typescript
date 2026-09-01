/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { ChannelBase, type ChannelConstructor } from './base';

export class ChannelTypeSchema {
    constructor(
        readonly channelType: string,
        readonly displayName: string,
        readonly description: string,
        readonly iconUrl: string,
        readonly credentialsSchema: Record<string, unknown>,
        readonly configSchema: Record<string, unknown>,
        readonly platformBotIdField: string,
        readonly supportsCredentialBinding: boolean
    ) {}

    toJSON(): Record<string, unknown> {
        return {
            channel_type: this.channelType,
            display_name: this.displayName,
            description: this.description,
            icon_url: this.iconUrl,
            credentials_schema: this.credentialsSchema,
            config_schema: this.configSchema,
            platform_bot_id_field: this.platformBotIdField,
            supports_credential_binding: this.supportsCredentialBinding,
        };
    }
}

/** Registry of the platform channel classes enabled by one service. */
export class ChannelTypeRegistry {
    private readonly classes = new Map<string, ChannelConstructor>();

    constructor(channels: ChannelConstructor[] = []) {
        for (const channel of channels) this.register(channel);
    }

    get enabled(): boolean {
        return this.classes.size > 0;
    }

    register(channel: ChannelConstructor): void {
        if (!channel.channelType) {
            throw new TypeError(
                `${channel.name} must set a non-empty 'channelType' to be registered.`
            );
        }
        this.classes.set(channel.channelType, channel);
    }

    get(channelType: string): ChannelConstructor | null {
        return this.classes.get(channelType) ?? null;
    }

    hasType(channelType: string): boolean {
        return this.classes.has(channelType);
    }

    createChannel(
        channelType: string,
        channelId: string,
        credentials: Record<string, unknown>,
        config: Record<string, unknown>
    ): ChannelBase {
        const Channel = this.classes.get(channelType);
        if (!Channel) {
            throw new TypeError(
                `Channel type '${channelType}' is not registered; pass it to createApp({ channels: [...] }).`
            );
        }
        return new Channel(
            channelId,
            Channel.credentialsSchema.parse(credentials),
            Channel.configSchema.parse(config)
        );
    }

    schemaOf(Channel: ChannelConstructor): ChannelTypeSchema {
        const { $schema: _credentialsDialect, ...credentialsSchema } = z.toJSONSchema(
            Channel.credentialsSchema
        );
        const { $schema: _configDialect, ...configSchema } = z.toJSONSchema(Channel.configSchema);
        return new ChannelTypeSchema(
            Channel.channelType,
            Channel.displayName || Channel.channelType,
            Channel.description ?? '',
            Channel.iconUrl ?? '',
            credentialsSchema,
            configSchema,
            Channel.platformBotIdField,
            Channel.credentialBinding !== null && Channel.credentialBinding !== undefined
        );
    }

    listTypes(): ChannelTypeSchema[] {
        return [...this.classes.values()].map(Channel => this.schemaOf(Channel));
    }

    extractPlatformBotId(channelType: string, credentials: Record<string, unknown>): string {
        const Channel = this.classes.get(channelType);
        if (!Channel?.platformBotIdField) {
            throw new TypeError(`Cannot extract platform_bot_id for type '${channelType}'.`);
        }
        const botId = credentials[Channel.platformBotIdField];
        if (!botId) {
            throw new TypeError(`Missing '${Channel.platformBotIdField}' in credentials.`);
        }
        return String(botId);
    }
}
