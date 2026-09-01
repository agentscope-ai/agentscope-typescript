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

export type FeishuReceiveIdType = 'chat_id' | 'open_id';

export interface FeishuToolChannel {
    listBotChats(): Promise<Record<string, unknown>[]>;
    listChatMembers(chatId: string): Promise<Record<string, unknown>[]>;
    sendMessageTo(
        receiveId: string,
        receiveIdType: FeishuReceiveIdType,
        text: string
    ): Promise<Record<string, unknown> | null>;
    sendFileTo(
        receiveId: string,
        receiveIdType: FeishuReceiveIdType,
        data: Uint8Array,
        fileName: string
    ): Promise<Record<string, unknown> | null>;
    sendImageTo(
        receiveId: string,
        receiveIdType: FeishuReceiveIdType,
        data: Uint8Array
    ): Promise<Record<string, unknown> | null>;
}

abstract class FeishuToolBase extends ToolBase {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly inputSchema: z.ZodObject;
    readonly isConcurrencySafe = false;
    abstract readonly isReadOnly: boolean;

    constructor(
        protected readonly channel: FeishuToolChannel,
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
                  message: "Sending to another Feishu chat/user needs the user's confirmation.",
              });
    }
}

export class FeishuListChats extends FeishuToolBase {
    readonly name = 'ListChats';
    readonly description = `List the Feishu groups this bot belongs to, to obtain a target for sending.

## When to Use
- You need to message a *group* other than the current conversation and must first find its id.

## Output
A JSON array of \`{receive_id, receive_id_type, name}\`. \`receive_id_type\` is always \`"chat_id"\`. Copy \`receive_id\` + \`receive_id_type\` verbatim into a Send* tool. To reach a specific *person* in a group, take that group's \`receive_id\` and call \`ListChatMembers\` next.`;
    readonly isReadOnly = true;
    readonly inputSchema = z.object({
        query: z
            .string()
            .nullable()
            .optional()
            .describe(
                'Optional case-insensitive substring to filter groups by name. Omit to list all.'
            ),
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { query } = this.inputSchema.parse(input);
        const needle = (query ?? '').toLowerCase();
        const chats = await this.channel.listBotChats();
        return chunk(
            JSON.stringify(
                chats
                    .filter(chat =>
                        !needle
                            ? true
                            : String(chat.name ?? '')
                                  .toLowerCase()
                                  .includes(needle)
                    )
                    .map(chat => ({
                        receive_id: String(chat.chat_id ?? ''),
                        receive_id_type: 'chat_id',
                        name: String(chat.name ?? ''),
                    }))
            )
        );
    }
}

export class FeishuListChatMembers extends FeishuToolBase {
    readonly name = 'ListChatMembers';
    readonly description = `List the members of a Feishu group, to obtain a person's id for a direct message.

## When to Use
- You need to message a *specific person* directly and must first find their id. Get the group's \`chat_id\` from \`ListChats\`, then call this.

## Output
A JSON array of \`{receive_id, receive_id_type, name}\`. \`receive_id_type\` is always \`"open_id"\`. Copy the \`receive_id\` + \`receive_id_type\` of the person you want into a Send* tool to message them directly.`;
    readonly isReadOnly = true;
    readonly inputSchema = z.object({
        chat_id: z.string().describe("The group's chat_id, taken from a ListChats result."),
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { chat_id: chatId } = this.inputSchema.parse(input);
        const members = await this.channel.listChatMembers(chatId);
        return chunk(
            JSON.stringify(
                members.map(member => ({
                    receive_id: String(member.open_id ?? ''),
                    receive_id_type: 'open_id',
                    name: String(member.name ?? ''),
                }))
            )
        );
    }
}

const receiveSchema = {
    receive_id: z
        .string()
        .describe('Target id, taken verbatim from a ListChats / ListChatMembers result.'),
    receive_id_type: z
        .enum(['chat_id', 'open_id'])
        .describe(
            "Must match the id: 'chat_id' for a group, 'open_id' for a person. Copy it from the same discovery result."
        ),
};

export class FeishuSendMessage extends FeishuToolBase {
    readonly name = 'SendMessage';
    readonly description = `Send a text message to a Feishu chat or person OTHER than the current conversation.

## When to Use
- The user asks you to notify or relay something to a *different* group or person (e.g. "tell the finance group ...", "let Li Si know ...").

## When NOT to Use
- To answer the person you are talking with now — that reply is sent automatically. Never use this tool for the current conversation.

## How to Use
Obtain \`receive_id\` first: a group's via \`ListChats\`, a person's via \`ListChatMembers\`. Pass \`receive_id\` and \`receive_id_type\` exactly as returned. Sending requires the user's confirmation.`;
    readonly isReadOnly = false;
    readonly inputSchema = z.object({
        ...receiveSchema,
        text: z.string().describe('The message text to send.'),
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const value = this.inputSchema.parse(input);
        return acknowledgement(
            await this.channel.sendMessageTo(value.receive_id, value.receive_id_type, value.text),
            `message to ${value.receive_id}`
        );
    }
}

export class FeishuSendFile extends FeishuToolBase {
    readonly name = 'SendFile';
    readonly description = `Send a file to a Feishu chat or person OTHER than the current conversation.

## When to Use
- The user asks you to deliver a file (a report, export, ...) to a *different* group or person.

## How to Use
Give \`path\` — a file in your workspace (the one you produced it in). Obtain \`receive_id\` via \`ListChats\` (group) or \`ListChatMembers\` (person) and pass \`receive_id\` + \`receive_id_type\` verbatim. Sending requires the user's confirmation.

To send an image so it renders inline, use \`SendImage\` instead.`;
    readonly isReadOnly = false;
    readonly inputSchema = z.object({
        path: z
            .string()
            .describe(
                'Absolute path to the file in your workspace, e.g. one you just created with Write — the same absolute path you used there.'
            ),
        ...receiveSchema,
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const value = this.inputSchema.parse(input);
        let data: Buffer;
        try {
            data = await this.backend.readFile(value.path);
        } catch (error) {
            return chunk(
                `SendFile: cannot read ${pythonRepr(value.path)}: ${errorMessage(error)}`,
                'error'
            );
        }
        const fileName = portableBasename(value.path);
        return acknowledgement(
            await this.channel.sendFileTo(value.receive_id, value.receive_id_type, data, fileName),
            `file ${fileName} to ${value.receive_id}`
        );
    }
}

export class FeishuSendImage extends FeishuToolBase {
    readonly name = 'SendImage';
    readonly description = `Send an image to a Feishu chat or person OTHER than the current conversation, rendered inline.

## When to Use
- The user asks you to send a picture/chart to a *different* group or person, and you want it shown inline (not as a file attachment).

## How to Use
Give \`path\` to the image file. Obtain \`receive_id\` via \`ListChats\` (group) or \`ListChatMembers\` (person) and pass \`receive_id\` + \`receive_id_type\` verbatim. Sending requires the user's confirmation.`;
    readonly isReadOnly = false;
    readonly inputSchema = z.object({
        path: z
            .string()
            .describe(
                'Absolute path to the image file in your workspace — the same absolute path you used to create it.'
            ),
        ...receiveSchema,
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const value = this.inputSchema.parse(input);
        let data: Buffer;
        try {
            data = await this.backend.readFile(value.path);
        } catch (error) {
            return chunk(
                `SendImage: cannot read ${pythonRepr(value.path)}: ${errorMessage(error)}`,
                'error'
            );
        }
        return acknowledgement(
            await this.channel.sendImageTo(value.receive_id, value.receive_id_type, data),
            `image to ${value.receive_id}`
        );
    }
}

function acknowledgement(data: Record<string, unknown> | null, what: string): ToolChunk {
    if (data && Number(data.code) === 0) return chunk(`Sent ${what}.`);
    return chunk(
        `Failed to send ${what}: ${String(data?.msg || 'the platform rejected the request')}`,
        'error'
    );
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
