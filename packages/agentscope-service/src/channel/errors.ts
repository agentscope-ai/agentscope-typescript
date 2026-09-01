/* eslint-disable jsdoc/require-jsdoc */

/** A channel operation failure with the HTTP status the router should expose. */
export class ChannelError extends Error {
    constructor(
        message: string,
        readonly statusCode = 400
    ) {
        super(message);
        this.name = 'ChannelError';
    }
}
