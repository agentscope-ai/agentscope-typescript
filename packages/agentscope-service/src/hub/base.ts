/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-returns */

/** Options shared by every catalog hub. */
export interface HubOptions {
    hubId: string;
    displayName: string;
    description?: string;
    iconUrl?: string | null;
}

/** Stable identity and lifecycle shared by every hub implementation. */
export class HubBase {
    readonly hubId: string;
    readonly displayName: string;
    readonly description: string;
    readonly iconUrl: string | null;

    constructor(options: HubOptions) {
        if (!/^[a-zA-Z0-9_-]+$/.test(options.hubId)) {
            throw new TypeError(
                `Hub id ${JSON.stringify(options.hubId)} must match [a-zA-Z0-9_-]+ ` +
                    'so it is usable as a route path segment.'
            );
        }
        this.hubId = options.hubId;
        this.displayName = options.displayName;
        this.description = options.description ?? '';
        this.iconUrl = options.iconUrl ?? null;
    }

    /** Open resources used by this hub. The default implementation is a no-op. */
    async open(): Promise<this> {
        return this;
    }

    /** Close resources opened by this hub. The default implementation is a no-op. */
    async close(): Promise<void> {}

    /** Python-compatible wire representation used by the HTTP API. */
    toJSON(): Record<string, unknown> {
        return {
            hub_id: this.hubId,
            display_name: this.displayName,
            description: this.description,
            icon_url: this.iconUrl,
        };
    }
}
