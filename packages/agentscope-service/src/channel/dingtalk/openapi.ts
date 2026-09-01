/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { logger } from '@agentscope-ai/agentscope/logger';

const API = 'https://api.dingtalk.com/v1.0';
const OAPI = 'https://oapi.dingtalk.com';
const TOKEN_REFRESH_BUFFER_SECONDS = 300;
const ERROR_BODY_CHARS = 500;
const SUPPORTED_FILE_TYPES = new Set(['doc', 'docx', 'pdf', 'rar', 'xlsx', 'zip']);
const AI_CARD_RENDERING = '1';
const AI_CARD_RENDERED = '3';

export type DingTalkFetch = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<Response>;

export interface DingTalkOpenAPIOptions {
    clientId: string;
    clientSecret: string;
    fetch?: DingTalkFetch;
    now?: () => number;
}

/** Minimal asynchronous DingTalk OpenAPI client used by the channel adapter. */
export class DingTalkOpenAPI {
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly fetcher: DingTalkFetch;
    private readonly now: () => number;
    private token: string | null = null;
    private tokenExpiresAt = 0;
    private tokenRequest: Promise<string | null> | null = null;

    constructor(options: DingTalkOpenAPIOptions) {
        this.clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this.fetcher = options.fetch ?? fetch;
        this.now = options.now ?? (() => Date.now() / 1000);
    }

    async downloadMedia(downloadCode: string, maxBytes: number): Promise<[Buffer, string] | null> {
        const token = await this.accessToken();
        if (!token) return null;
        try {
            const response = await this.fetcher(`${API}/robot/messageFiles/download`, {
                method: 'POST',
                headers: this.headers(token),
                body: JSON.stringify({ robotCode: this.clientId, downloadCode }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = asRecord(await response.json());
            const url = safeDingTalkDownloadUrl(String(result.downloadUrl ?? ''));
            if (!url) {
                logger.warning('DingTalk returned an unsafe media URL');
                return null;
            }
            return await this.downloadBytes(url, maxBytes);
        } catch (error) {
            logger.error(`DingTalk media URL resolution failed: ${errorMessage(error)}`);
            return null;
        }
    }

    async sendMedia(
        chatId: string,
        data: Uint8Array,
        fileName: string,
        mediaType: string
    ): Promise<boolean> {
        const isImage = mediaType.startsWith('image/');
        const suffix = fileName.includes('.') ? fileName.split('.').at(-1)!.toLowerCase() : '';
        if (!isImage && !SUPPORTED_FILE_TYPES.has(suffix)) {
            logger.warning(`DingTalk does not support outbound '.${suffix}' files`);
            return false;
        }
        const mediaId = await this.uploadMedia(
            data,
            fileName,
            mediaType,
            isImage ? 'image' : 'file'
        );
        if (!mediaId) return false;
        return isImage
            ? this.sendMessage(chatId, 'sampleImageMsg', { photoURL: mediaId })
            : this.sendMessage(chatId, 'sampleFile', {
                  mediaId,
                  fileName,
                  fileType: suffix,
              });
    }

    async sendText(chatId: string, text: string): Promise<boolean> {
        return this.sendMessage(chatId, 'sampleMarkdown', { title: 'AgentScope', text });
    }

    async createApprovalCard(
        chatId: string,
        approverId: string,
        templateId: string,
        cardData: Record<string, string>,
        outTrackId = ''
    ): Promise<string | null> {
        const track = await this.createAndDeliverCard(
            chatId,
            templateId,
            { flowStatus: AI_CARD_RENDERING },
            approverId,
            outTrackId
        );
        if (!track) return null;
        const settled = await this.updateApprovalCard(track, {
            ...cardData,
            flowStatus: AI_CARD_RENDERED,
        });
        return settled ? track : null;
    }

    async createStreamingCard(
        chatId: string,
        templateId: string,
        contentKey: string
    ): Promise<string | null> {
        return this.createAndDeliverCard(chatId, templateId, { [contentKey]: '' });
    }

    async streamCard(
        outTrackId: string,
        contentKey: string,
        content: string,
        options: { finalize?: boolean; isError?: boolean } = {}
    ): Promise<boolean> {
        const token = await this.accessToken();
        if (!token) return false;
        return this.request(
            'PUT',
            `${API}/card/streaming`,
            token,
            {
                outTrackId,
                guid: randomUUID(),
                key: contentKey,
                content,
                isFull: true,
                isFinalize: options.finalize ?? false,
                isError: options.isError ?? false,
            },
            'card streaming update'
        );
    }

    async updateApprovalCard(
        outTrackId: string,
        cardData: Record<string, string>
    ): Promise<boolean> {
        const token = await this.accessToken();
        if (!token) return false;
        return this.request(
            'PUT',
            `${API}/card/instances`,
            token,
            {
                outTrackId,
                cardData: { cardParamMap: cardData },
                cardUpdateOptions: { updateCardDataByKey: true },
            },
            'card update'
        );
    }

    async searchUsers(query: string, limit: number): Promise<Record<string, unknown>[]> {
        const token = await this.accessToken();
        if (!token) return [];
        let userIds: string[];
        try {
            const response = await this.fetcher(`${API}/contact/users/search`, {
                method: 'POST',
                headers: this.headers(token),
                body: JSON.stringify({ queryWord: query, offset: 0, size: limit }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = asRecord(await response.json());
            userIds = (Array.isArray(result.list) ? result.list : [])
                .filter(Boolean)
                .map(String)
                .slice(0, limit);
        } catch (error) {
            logger.error(`DingTalk user search failed: ${errorMessage(error)}`);
            return [];
        }
        const users: Record<string, unknown>[] = [];
        for (const userId of userIds) {
            users.push(
                (await this.userDetail(token, userId)) ?? {
                    user_id: userId,
                    name: '',
                    title: '',
                    department_ids: [],
                }
            );
        }
        return users;
    }

    private async createAndDeliverCard(
        chatId: string,
        templateId: string,
        cardData: Record<string, string>,
        recipientId = '',
        suppliedTrackId = ''
    ): Promise<string | null> {
        let openSpaceId: string;
        let deliveryModel: Record<string, unknown>;
        if (chatId.startsWith('group:')) {
            const conversationId = chatId.slice('group:'.length);
            openSpaceId = `dtv1.card//IM_GROUP.${conversationId}`;
            const groupModel: Record<string, unknown> = { robotCode: this.clientId };
            if (recipientId) groupModel.recipients = [recipientId];
            deliveryModel = { imGroupOpenDeliverModel: groupModel };
        } else if (chatId.startsWith('user:')) {
            const userId = chatId.slice('user:'.length);
            if (recipientId && userId !== recipientId) {
                logger.warning('DingTalk card target does not match user');
                return null;
            }
            openSpaceId = `dtv1.card//IM_ROBOT.${userId}`;
            deliveryModel = { imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' } };
        } else {
            logger.warning('Invalid DingTalk card target');
            return null;
        }
        const token = await this.accessToken();
        if (!token) return null;
        const outTrackId = suppliedTrackId || randomUUID().replaceAll('-', '');
        const created = await this.request(
            'POST',
            `${API}/card/instances`,
            token,
            {
                cardTemplateId: templateId,
                outTrackId,
                cardData: { cardParamMap: cardData },
                callbackType: 'STREAM',
                imGroupOpenSpaceModel: { supportForward: false },
                imRobotOpenSpaceModel: { supportForward: false },
            },
            'card creation'
        );
        if (!created) return null;
        const delivered = await this.request(
            'POST',
            `${API}/card/instances/deliver`,
            token,
            { outTrackId, openSpaceId, userIdType: 1, ...deliveryModel },
            'card delivery'
        );
        return delivered ? outTrackId : null;
    }

    private async accessToken(): Promise<string | null> {
        if (this.token && this.now() < this.tokenExpiresAt) return this.token;
        if (!this.tokenRequest) {
            this.tokenRequest = this.requestToken().finally(() => {
                this.tokenRequest = null;
            });
        }
        return this.tokenRequest;
    }

    private async requestToken(): Promise<string | null> {
        try {
            const response = await this.fetcher(`${API}/oauth2/accessToken`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = asRecord(await response.json());
            const token = String(result.accessToken ?? '');
            const expiresIn = Number(result.expireIn ?? 0);
            if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
                logger.warning('DingTalk returned an invalid access token');
                return null;
            }
            const reserve = Math.min(
                TOKEN_REFRESH_BUFFER_SECONDS,
                Math.max(Math.floor(expiresIn / 10), 1)
            );
            this.token = token;
            this.tokenExpiresAt = this.now() + expiresIn - reserve;
            return token;
        } catch (error) {
            logger.error(`DingTalk access token request failed: ${errorMessage(error)}`);
            return null;
        }
    }

    private async downloadBytes(url: string, maxBytes: number): Promise<[Buffer, string] | null> {
        try {
            const response = await this.fetcher(url, { redirect: 'manual' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const declared = Number(response.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > maxBytes) {
                logger.warning('DingTalk media exceeds the size limit');
                return null;
            }
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (reader) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > maxBytes) {
                        await reader.cancel();
                        logger.warning('DingTalk media exceeds the size limit');
                        return null;
                    }
                    chunks.push(value);
                }
            } else {
                const value = new Uint8Array(await response.arrayBuffer());
                if (value.byteLength > maxBytes) return null;
                chunks.push(value);
            }
            const mediaType = (response.headers.get('content-type') ?? 'application/octet-stream')
                .split(';', 1)[0]
                .trim();
            return [Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), mediaType];
        } catch (error) {
            logger.error(`DingTalk media download failed: ${errorMessage(error)}`);
            return null;
        }
    }

    private async uploadMedia(
        data: Uint8Array,
        fileName: string,
        mediaType: string,
        uploadType: string
    ): Promise<string | null> {
        const token = await this.accessToken();
        if (!token) return null;
        try {
            const form = new FormData();
            form.set('type', uploadType);
            form.set(
                'media',
                new Blob([Uint8Array.from(data).buffer], { type: mediaType }),
                fileName
            );
            const url = new URL(`${OAPI}/media/upload`);
            url.searchParams.set('access_token', token);
            const response = await this.fetcher(url, { method: 'POST', body: form });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = asRecord(await response.json());
            if (result.errcode !== undefined && Number(result.errcode) !== 0) {
                logger.warning(`DingTalk media upload rejected: code=${String(result.errcode)}`);
                return null;
            }
            return String(result.media_id ?? '') || null;
        } catch (error) {
            logger.error(`DingTalk media upload failed: ${errorMessage(error)}`);
            return null;
        }
    }

    private async userDetail(
        token: string,
        userId: string
    ): Promise<Record<string, unknown> | null> {
        try {
            const url = new URL(`${OAPI}/topapi/v2/user/get`);
            url.searchParams.set('access_token', token);
            const response = await this.fetcher(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userid: userId, language: 'zh_CN' }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = asRecord(await response.json());
            if (payload.errcode !== undefined && Number(payload.errcode) !== 0) return null;
            const result = asRecord(payload.result);
            return {
                user_id: String(result.userid ?? userId),
                name: String(result.name ?? ''),
                title: String(result.title ?? ''),
                department_ids: Array.isArray(result.dept_id_list) ? result.dept_id_list : [],
            };
        } catch (error) {
            logger.error(`DingTalk user detail request failed: ${errorMessage(error)}`);
            return null;
        }
    }

    private async sendMessage(
        chatId: string,
        msgKey: string,
        msgParam: Record<string, string>
    ): Promise<boolean> {
        const token = await this.accessToken();
        if (!token) return false;
        let url: string;
        let target: Record<string, unknown>;
        if (chatId.startsWith('group:')) {
            url = `${API}/robot/groupMessages/send`;
            target = { openConversationId: chatId.slice('group:'.length) };
        } else if (chatId.startsWith('user:')) {
            url = `${API}/robot/oToMessages/batchSend`;
            target = { userIds: [chatId.slice('user:'.length)] };
        } else {
            logger.warning('Invalid DingTalk message target');
            return false;
        }
        return this.request(
            'POST',
            url,
            token,
            {
                robotCode: this.clientId,
                msgKey,
                msgParam: JSON.stringify(msgParam),
                ...target,
            },
            `${msgKey} message send`
        );
    }

    private async request(
        method: string,
        url: string,
        token: string,
        body: Record<string, unknown>,
        operation: string
    ): Promise<boolean> {
        try {
            const response = await this.fetcher(url, {
                method,
                headers: this.headers(token),
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const text = (await response.text()).slice(0, ERROR_BODY_CHARS);
                logger.warning(
                    `DingTalk rejected ${operation} with HTTP ${response.status}: ${text}`
                );
                return false;
            }
            const result = asRecord(await response.json());
            const code = result.code;
            if (code !== undefined && code !== null && code !== '' && String(code) !== '0') {
                logger.warning(`DingTalk ${operation} rejected: code=${String(code)}`);
                return false;
            }
            return true;
        } catch (error) {
            logger.error(`DingTalk ${operation} failed: ${errorMessage(error)}`);
            return false;
        }
    }

    private headers(token: string): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'x-acs-dingtalk-access-token': token,
        };
    }
}

export function safeDingTalkDownloadUrl(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (
        url.username ||
        url.password ||
        !url.hostname ||
        url.hostname.toLowerCase() === 'localhost'
    ) {
        return null;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname.includes('%') || isNonGlobalIPAddress(hostname)) return null;
    if (url.protocol === 'https:') return url.toString();
    if (url.protocol === 'http:' && url.hostname.toLowerCase().endsWith('.aliyuncs.com')) {
        url.protocol = 'https:';
        return url.toString();
    }
    return null;
}

function isNonGlobalIPAddress(hostname: string): boolean {
    const version = isIP(hostname);
    if (version === 0) return false;
    if (version === 4) {
        return isNonGlobalIPv4(ipv4Value(hostname));
    }
    const value = ipv6Value(hostname);
    if (inIPv6Cidr(value, '::ffff:0:0', 96)) {
        return isNonGlobalIPv4(Number(value & 0xffffffffn));
    }
    if (
        value === 0n ||
        value === 1n ||
        inIPv6Cidr(value, '64:ff9b:1::', 48) ||
        inIPv6Cidr(value, '100::', 64) ||
        inIPv6Cidr(value, '2001:db8::', 32) ||
        inIPv6Cidr(value, '2002::', 16) ||
        inIPv6Cidr(value, 'fc00::', 7) ||
        inIPv6Cidr(value, 'fe80::', 10)
    ) {
        return true;
    }
    if (!inIPv6Cidr(value, '2001::', 23)) return false;
    return ![
        ['2001:1::1', 128],
        ['2001:1::2', 128],
        ['2001:3::', 32],
        ['2001:4:112::', 48],
        ['2001:20::', 28],
        ['2001:30::', 28],
    ].some(([prefix, bits]) => inIPv6Cidr(value, String(prefix), Number(bits)));
}

function isNonGlobalIPv4(value: number): boolean {
    if (value === ipv4Value('192.0.0.9') || value === ipv4Value('192.0.0.10')) return false;
    return [
        ['0.0.0.0', 8],
        ['10.0.0.0', 8],
        ['100.64.0.0', 10],
        ['127.0.0.0', 8],
        ['169.254.0.0', 16],
        ['172.16.0.0', 12],
        ['192.0.0.0', 24],
        ['192.0.2.0', 24],
        ['192.168.0.0', 16],
        ['198.18.0.0', 15],
        ['198.51.100.0', 24],
        ['203.0.113.0', 24],
        ['240.0.0.0', 4],
    ].some(([prefix, bits]) => inIPv4Cidr(value, String(prefix), Number(bits)));
}

function ipv4Value(hostname: string): number {
    return hostname
        .split('.')
        .map(Number)
        .reduce((value, octet) => (value * 256 + octet) >>> 0, 0);
}

function inIPv4Cidr(value: number, prefix: string, bits: number): boolean {
    const divisor = 2 ** (32 - bits);
    return Math.floor(value / divisor) === Math.floor(ipv4Value(prefix) / divisor);
}

function inIPv6Cidr(value: bigint, prefix: string, bits: number): boolean {
    const shift = BigInt(128 - bits);
    return value >> shift === ipv6Value(prefix) >> shift;
}

function ipv6Value(hostname: string): bigint {
    const [leftRaw, rightRaw = ''] = hostname.toLowerCase().split('::');
    const left = leftRaw ? leftRaw.split(':') : [];
    const right = rightRaw ? rightRaw.split(':') : [];
    const missing = 8 - left.length - right.length;
    const segments = [...left, ...Array(Math.max(missing, 0)).fill('0'), ...right];
    return segments.reduce((value, segment) => (value << 16n) | BigInt(`0x${segment || '0'}`), 0n);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
