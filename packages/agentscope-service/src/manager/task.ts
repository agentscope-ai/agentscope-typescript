/* eslint-disable jsdoc/require-jsdoc */

export type AbortableWork<T> = (signal: AbortSignal) => Promise<T>;

/** Cooperative, AbortSignal-based counterpart of an asyncio task handle. */
export class ManagedTask<T = void> {
    readonly controller: AbortController;
    readonly promise: Promise<T>;
    readonly name: string;
    settled = false;

    constructor(work: AbortableWork<T>, name: string, controller = new AbortController()) {
        this.controller = controller;
        this.name = name;
        this.promise = Promise.resolve()
            .then(() => work(controller.signal))
            .finally(() => {
                this.settled = true;
            });
    }

    cancel(reason?: unknown): void {
        if (!this.settled) this.controller.abort(reason);
    }
}
