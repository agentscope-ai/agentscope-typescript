/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS = 60;

/** Mint a short-lived capability bound to a user and resource path. */
export function signDownloadToken(
    secret: string,
    userId: string,
    path: string,
    ttlSeconds = DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS,
    now = Date.now()
): { token: string; expiresAt: number } {
    const expiresAt = Math.floor(now / 1_000) + ttlSeconds;
    const signature = tokenSignature(secret, expiresAt, userId, path);
    return {
        token: `${expiresAt}.${base64Url(Buffer.from(userId, 'utf8'))}.${base64Url(signature)}`,
        expiresAt,
    };
}

/** Verify a capability and return the user it authorizes. */
export function verifyDownloadToken(
    secret: string,
    token: string,
    path: string,
    now = Date.now()
): string {
    let expiresAt: number;
    let userId: string;
    let signature: Buffer;
    try {
        const parts = token.split('.');
        if (parts.length !== 3 || !/^\d+$/.test(parts[0])) throw new Error();
        expiresAt = Number(parts[0]);
        userId = fromBase64Url(parts[1]).toString('utf8');
        signature = fromBase64Url(parts[2]);
        if (!Number.isSafeInteger(expiresAt) || !userId) throw new Error();
    } catch {
        throw new Error('Malformed download token.');
    }

    const expected = tokenSignature(secret, expiresAt, userId, path);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
        throw new Error('Invalid download token.');
    }
    if (expiresAt < now / 1_000) throw new Error('Expired download token.');
    return userId;
}

function tokenSignature(secret: string, expiresAt: number, userId: string, path: string): Buffer {
    return createHmac('sha256', secret).update(`${expiresAt}\0${userId}\0${path}`, 'utf8').digest();
}

function base64Url(value: Buffer): string {
    return value.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error();
    return Buffer.from(value, 'base64url');
}
