/* eslint-disable jsdoc/require-jsdoc */

/** Reverse-order async cleanup stack with startup-failure rollback. */
export class AsyncLifecycleStack {
    private readonly cleanups: Array<() => Promise<void>> = [];
    private closed = false;

    defer(cleanup: () => Promise<void>): void {
        if (this.closed) throw new Error('The lifecycle stack is already closed.');
        this.cleanups.push(cleanup);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const errors: unknown[] = [];
        for (const cleanup of this.cleanups.reverse()) {
            try {
                await cleanup();
            } catch (error) {
                errors.push(error);
            }
        }
        this.cleanups.length = 0;
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, 'Multiple service resources failed to close.');
    }
}
