/* eslint-disable jsdoc/require-jsdoc */

import path from 'node:path';

import { TextBlock } from '@agentscope-ai/agentscope/message';
import {
    createPermissionDecision,
    PermissionBehavior,
    type PermissionContext,
    type PermissionDecision,
} from '@agentscope-ai/agentscope/permission';
import { BackendBase, ToolBase, ToolChunk } from '@agentscope-ai/agentscope/tool';
import { z } from 'zod';

export interface DingTalkToolChannel {
    listBotChats(): Promise<Record<string, unknown>[]>;
    searchUsers(query: string, limit?: number): Promise<Record<string, unknown>[]>;
    sendMessageTo(target: string, text: string): Promise<boolean>;
    sendFileTo(target: string, data: Uint8Array, fileName: string): Promise<boolean>;
    sendImageTo(target: string, data: Uint8Array, fileName: string): Promise<boolean>;
}

abstract class DingTalkToolBase extends ToolBase {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly inputSchema: z.ZodObject;
    readonly isConcurrencySafe = false;
    abstract readonly isReadOnly: boolean;

    constructor(
        protected readonly channel: DingTalkToolChannel,
        protected readonly backend: BackendBase
    ) {
        super();
    }

    checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): PermissionDecision {
        return this.isReadOnly
            ? createPermissionDecision({
                  behavior: PermissionBehavior.ALLOW,
                  message: `${this.name} is a read-only lookup.`,
              })
            : createPermissionDecision({
                  behavior: PermissionBehavior.ASK,
                  message:
                      "Sending to another DingTalk conversation needs the user's confirmation.",
              });
    }
}

export class DingTalkListConversations extends DingTalkToolBase {
    readonly name = 'ListConversations';
    readonly description = `List DingTalk conversations this robot process has already received messages from.

## Important Limitation
DingTalk application robots cannot enumerate every group they belong to, and the process answering this call is not the one holding the robot's connection — so in a deployment that separates them this list is empty and stays empty. Treat an empty array as the normal case and ask the user for the target; waiting for it to fill will not help.

## Output
A JSON array of \`{target, name, chat_type}\`. Copy \`target\` verbatim into a DingTalk Send* tool.`;
    readonly isReadOnly = true;
    readonly inputSchema = z.object({
        query: z.string().nullable().optional().describe('Optional case-insensitive name filter.'),
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { query } = this.inputSchema.parse(input);
        const needle = (query ?? '').toLowerCase();
        const chats = await this.channel.listBotChats();
        const items = chats
            .filter(
                chat =>
                    !needle ||
                    String(chat.name ?? '')
                        .toLowerCase()
                        .includes(needle)
            )
            .map(chat => ({
                target: String(chat.chat_id ?? ''),
                name: String(chat.name ?? ''),
                chat_type: String(chat.chat_type ?? ''),
            }));
        return chunk(JSON.stringify(items));
    }
}

export class DingTalkListUsers extends DingTalkToolBase {
    readonly name = 'ListUsers';
    readonly description = `Search users visible to the DingTalk application.

## When to Use
- You need a stable DingTalk user target before sending a direct message.

## Important Limitation
Searching the directory needs contact permission, which the DingTalk application may not have been granted, and a failed lookup reads the same as one that matched nobody. An empty array therefore proves nothing: it may mean no match, no permission, or a request that did not go through. Ask the user for the target rather than retrying, and say the search came back empty rather than that the person does not exist.

## Output
A JSON array of \`{target, name, title, department_ids}\`. Copy \`target\` verbatim into a DingTalk Send* tool.`;
    readonly isReadOnly = true;
    readonly inputSchema = z.object({
        query: z.string().min(1).describe('User name to search for in the DingTalk directory.'),
        limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(20)
            .describe('Maximum number of matches to return.'),
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { query, limit } = this.inputSchema.parse(input);
        const users = await this.channel.searchUsers(query, limit);
        const items = users
            .filter(user => Boolean(user.user_id))
            .map(user => ({
                target: `user:${String(user.user_id)}`,
                name: String(user.name ?? ''),
                title: String(user.title ?? ''),
                department_ids: Array.isArray(user.department_ids) ? user.department_ids : [],
            }));
        return chunk(JSON.stringify(items));
    }
}

const targetSchema = z
    .string()
    .regex(/^(user|group):.+$/)
    .describe('Encoded target returned by ListConversations or ListUsers.');

export class DingTalkSendMessage extends DingTalkToolBase {
    readonly name = 'SendMessage';
    readonly description = `Send Markdown text to a DingTalk user or group.

Use this only when the user asks to contact a target other than the current conversation. Obtain \`target\` from \`ListConversations\` or \`ListUsers\`. The operation requires confirmation.`;
    readonly isReadOnly = false;
    readonly inputSchema = z.object({
        target: targetSchema,
        text: z.string().min(1).describe('Markdown-formatted message body.'),
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { target, text } = this.inputSchema.parse(input);
        return acknowledgement(
            await this.channel.sendMessageTo(target, text),
            `message to ${target}`
        );
    }
}

export class DingTalkSendFile extends DingTalkToolBase {
    readonly name = 'SendFile';
    readonly description = `Send a workspace file to a specified DingTalk user or group.

Supported DingTalk file extensions are doc, docx, pdf, rar, xlsx, and zip. Obtain \`target\` from a discovery tool. The operation requires confirmation. Use \`SendImage\` for inline images.`;
    readonly isReadOnly = false;
    readonly inputSchema = z.object({
        path: z.string().describe('Absolute path to a file in the calling workspace.'),
        target: targetSchema,
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { path: filePath, target } = this.inputSchema.parse(input);
        let data: Buffer;
        try {
            data = await this.backend.readFile(filePath);
        } catch (error) {
            return chunk(
                `SendFile: cannot read ${pythonRepr(filePath)}: ${errorMessage(error)}`,
                'error'
            );
        }
        const fileName = portableBasename(filePath);
        return acknowledgement(
            await this.channel.sendFileTo(target, data, fileName),
            `file ${fileName} to ${target}`
        );
    }
}

export class DingTalkSendImage extends DingTalkToolBase {
    readonly name = 'SendImage';
    readonly description = `Send a workspace image to a specified DingTalk user or group so it renders inline.

Obtain \`target\` from \`ListConversations\` or \`ListUsers\`. The operation requires confirmation.`;
    readonly isReadOnly = false;
    readonly inputSchema = z.object({
        path: z.string().describe('Absolute path to an image in the calling workspace.'),
        target: targetSchema,
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { path: filePath, target } = this.inputSchema.parse(input);
        let data: Buffer;
        try {
            data = await this.backend.readFile(filePath);
        } catch (error) {
            return chunk(
                `SendImage: cannot read ${pythonRepr(filePath)}: ${errorMessage(error)}`,
                'error'
            );
        }
        return acknowledgement(
            await this.channel.sendImageTo(target, data, portableBasename(filePath)),
            `image to ${target}`
        );
    }
}

function acknowledgement(accepted: boolean, what: string): ToolChunk {
    return accepted
        ? chunk(`Sent ${what}.`)
        : chunk(`Failed to send ${what}: DingTalk rejected the request.`, 'error');
}

function chunk(text: string, state: 'running' | 'error' = 'running'): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text })], state });
}

function portableBasename(value: string): string {
    return path.posix.basename(value.replaceAll('\\', '/')) || 'file';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function pythonRepr(value: string): string {
    const escaped = value
        .replaceAll('\\', '\\\\')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r')
        .replaceAll('\t', '\\t');
    if (escaped.includes("'") && !escaped.includes('"')) {
        return `"${escaped.replaceAll('"', '\\"')}"`;
    }
    return `'${escaped.replaceAll("'", "\\'")}'`;
}
