/* eslint-disable jsdoc/require-jsdoc */

/** A failed response from an upstream hub registry. */
export class HubError extends Error {
    readonly hubId: string;
    readonly statusCode: number;
    readonly detail: string;

    constructor(hubId: string, statusCode: number, detail: string) {
        super(`${hubId} returned ${statusCode}: ${detail}`);
        this.name = 'HubError';
        this.hubId = hubId;
        this.statusCode = statusCode;
        this.detail = detail;
    }
}

/** A card that does not exist, or cannot be installed from its registry record. */
export class HubCardNotFoundError extends Error {
    readonly cardId: string;

    constructor(cardId: string) {
        super(cardId);
        this.name = 'HubCardNotFoundError';
        this.cardId = cardId;
    }
}
