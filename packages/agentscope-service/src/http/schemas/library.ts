import { z } from 'zod';

import { JsonObjectSchema } from './foundation';
import { RoutingConfigSchema, SessionSettingsSchema } from '../../storage';

export const CreateChannelRequestSchema = z.object({
    channel_type: z.string(),
    name: z.string().nullable().default(null),
    credentials: JsonObjectSchema.default({}),
    credential_binding_id: z.string().nullable().default(null),
    platform_config: JsonObjectSchema.default({}),
    routing: RoutingConfigSchema,
    session: SessionSettingsSchema,
    enabled: z.boolean().default(true),
});

export const StartCredentialBindingRequestSchema = z.object({
    channel_type: z.string(),
});

export const UpdateChannelRequestSchema = z.object({
    name: z.string().nullable().optional(),
    platform_config: JsonObjectSchema.optional(),
    routing: RoutingConfigSchema.optional(),
    session: SessionSettingsSchema.optional(),
    enabled: z.boolean().optional(),
});

export const HubPageQuerySchema = z.object({
    q: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(20),
});

export const InstallMCPRequestSchema = z.object({
    name: z.string().optional(),
    values: JsonObjectSchema.default({}),
});

export const UpdateMCPRequestSchema = z.object({
    name: z.string().optional(),
    values: JsonObjectSchema.optional(),
    enabled: z.boolean().optional(),
});
