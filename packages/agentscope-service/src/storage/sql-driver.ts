/* eslint-disable jsdoc/require-jsdoc */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface SQLRecordRow {
    kind: string;
    id: string;
    userId: string;
    payload: string;
    createdAt: string;
    updatedAt: string;
}

export interface SQLMessageRow {
    messageId: string;
    payload: string;
    sequence: number;
}

/** Relational operations required by SQLStorage. */
export interface SQLStorageDriver {
    open(): Promise<void>;
    close(): Promise<void>;
    transaction<T>(work: () => Promise<T>): Promise<T>;
    getRecord(kind: string, id: string): Promise<SQLRecordRow | null>;
    listRecords(kind: string, userId?: string): Promise<SQLRecordRow[]>;
    compareAndSetRecord(row: SQLRecordRow, expectedPayload: string | null): Promise<boolean>;
    deleteRecord(kind: string, id: string, userId: string): Promise<boolean>;
    claimUnique(namespace: string, scope: string, value: string, ownerId: string): Promise<boolean>;
    getUnique(namespace: string, scope: string, value: string): Promise<string | null>;
    releaseUnique(
        namespace: string,
        scope: string,
        value: string,
        ownerId: string
    ): Promise<boolean>;
    upsertMessage(
        userId: string,
        sessionId: string,
        messageId: string,
        payload: string
    ): Promise<void>;
    getMessages(userId: string, sessionId: string): Promise<SQLMessageRow[]>;
    deleteMessages(userId: string, sessionId: string): Promise<void>;
}

interface SQLiteRunResult {
    changes: number | bigint;
}

interface SQLiteStatementLike {
    run(...parameters: unknown[]): SQLiteRunResult;
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
}

interface SQLiteDatabaseLike {
    open: boolean;
    close(): void;
    exec(sql: string): void;
    pragma(source: string): unknown;
    prepare(sql: string): SQLiteStatementLike;
}

type SQLiteDatabaseConstructor = new (
    filename: string,
    options?: Record<string, unknown>
) => SQLiteDatabaseLike;

const MIGRATION_VERSION = 1;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS agentscope_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agentscope_records (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS agentscope_records_owner
    ON agentscope_records (kind, user_id);
CREATE TABLE IF NOT EXISTS agentscope_unique_constraints (
    namespace TEXT NOT NULL,
    scope TEXT NOT NULL,
    value TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    PRIMARY KEY (namespace, scope, value)
);
CREATE TABLE IF NOT EXISTS agentscope_messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (user_id, session_id, message_id)
);
CREATE INDEX IF NOT EXISTS agentscope_messages_session
    ON agentscope_messages (user_id, session_id, sequence);
`;

export interface BetterSQLiteDriverOptions {
    filename?: string;
    database?: SQLiteDatabaseLike;
    databaseOptions?: Record<string, unknown>;
}

/** SQLite implementation backed by the optional better-sqlite3 package. */
export class BetterSQLiteDriver implements SQLStorageDriver {
    private database: SQLiteDatabaseLike | null;
    private readonly externalDatabase: SQLiteDatabaseLike | null;
    private readonly filename: string;
    private readonly databaseOptions: Record<string, unknown>;
    private readonly transactionContext = new AsyncLocalStorage<boolean>();
    private gate: Promise<void> = Promise.resolve();

    constructor(options: BetterSQLiteDriverOptions = {}) {
        this.externalDatabase = options.database ?? null;
        this.database = options.database ?? null;
        this.filename = options.filename ?? ':memory:';
        this.databaseOptions = options.databaseOptions ?? {};
    }

    async open(): Promise<void> {
        if (!this.database) {
            let Database: SQLiteDatabaseConstructor;
            try {
                const module = (await import('better-sqlite3')) as unknown as {
                    default: SQLiteDatabaseConstructor;
                };
                Database = module.default;
            } catch (error) {
                throw new Error(
                    "The optional 'better-sqlite3' package is required for SQLStorage.",
                    { cause: error }
                );
            }
            this.database = new Database(this.filename, this.databaseOptions);
        }
        await this.exclusive(() => {
            const database = this.requireDatabase();
            database.pragma('foreign_keys = ON');
            database.exec(MIGRATION_SQL);
            database
                .prepare(
                    `INSERT OR IGNORE INTO agentscope_schema_migrations
                     (version, applied_at) VALUES (?, ?)`
                )
                .run(MIGRATION_VERSION, new Date().toISOString());
        });
    }

    async close(): Promise<void> {
        await this.exclusive(() => {
            if (this.database && this.database !== this.externalDatabase && this.database.open) {
                this.database.close();
            }
            if (!this.externalDatabase) this.database = null;
        });
    }

    async transaction<T>(work: () => Promise<T>): Promise<T> {
        if (this.transactionContext.getStore()) return work();
        return this.exclusive(async () => {
            const database = this.requireDatabase();
            database.exec('BEGIN IMMEDIATE');
            try {
                const result = await this.transactionContext.run(true, work);
                database.exec('COMMIT');
                return result;
            } catch (error) {
                database.exec('ROLLBACK');
                throw error;
            }
        });
    }

    async getRecord(kind: string, id: string): Promise<SQLRecordRow | null> {
        return this.operation(() => {
            const row = this.requireDatabase()
                .prepare(
                    `SELECT kind, id, user_id, payload, created_at, updated_at
                     FROM agentscope_records WHERE kind = ? AND id = ?`
                )
                .get(kind, id);
            return row ? this.toRecordRow(row) : null;
        });
    }

    async listRecords(kind: string, userId?: string): Promise<SQLRecordRow[]> {
        return this.operation(() => {
            const rows =
                userId === undefined
                    ? this.requireDatabase()
                          .prepare(
                              `SELECT kind, id, user_id, payload, created_at, updated_at
                               FROM agentscope_records WHERE kind = ? ORDER BY created_at, id`
                          )
                          .all(kind)
                    : this.requireDatabase()
                          .prepare(
                              `SELECT kind, id, user_id, payload, created_at, updated_at
                               FROM agentscope_records
                               WHERE kind = ? AND user_id = ? ORDER BY created_at, id`
                          )
                          .all(kind, userId);
            return rows.map(row => this.toRecordRow(row));
        });
    }

    async compareAndSetRecord(row: SQLRecordRow, expectedPayload: string | null): Promise<boolean> {
        return this.operation(() => {
            const database = this.requireDatabase();
            const result =
                expectedPayload === null
                    ? database
                          .prepare(
                              `INSERT OR IGNORE INTO agentscope_records
                               (kind, id, user_id, payload, created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?)`
                          )
                          .run(
                              row.kind,
                              row.id,
                              row.userId,
                              row.payload,
                              row.createdAt,
                              row.updatedAt
                          )
                    : database
                          .prepare(
                              `UPDATE agentscope_records
                               SET user_id = ?, payload = ?, created_at = ?, updated_at = ?
                               WHERE kind = ? AND id = ? AND payload = ?`
                          )
                          .run(
                              row.userId,
                              row.payload,
                              row.createdAt,
                              row.updatedAt,
                              row.kind,
                              row.id,
                              expectedPayload
                          );
            return Number(result.changes) === 1;
        });
    }

    async deleteRecord(kind: string, id: string, userId: string): Promise<boolean> {
        return this.operation(() => {
            const result = this.requireDatabase()
                .prepare(
                    `DELETE FROM agentscope_records
                     WHERE kind = ? AND id = ? AND user_id = ?`
                )
                .run(kind, id, userId);
            return Number(result.changes) === 1;
        });
    }

    async claimUnique(
        namespace: string,
        scope: string,
        value: string,
        ownerId: string
    ): Promise<boolean> {
        return this.operation(() => {
            const database = this.requireDatabase();
            database
                .prepare(
                    `INSERT OR IGNORE INTO agentscope_unique_constraints
                     (namespace, scope, value, owner_id) VALUES (?, ?, ?, ?)`
                )
                .run(namespace, scope, value, ownerId);
            const row = database
                .prepare(
                    `SELECT owner_id FROM agentscope_unique_constraints
                     WHERE namespace = ? AND scope = ? AND value = ?`
                )
                .get(namespace, scope, value) as { owner_id: string } | undefined;
            return row?.owner_id === ownerId;
        });
    }

    async getUnique(namespace: string, scope: string, value: string): Promise<string | null> {
        return this.operation(() => {
            const row = this.requireDatabase()
                .prepare(
                    `SELECT owner_id FROM agentscope_unique_constraints
                     WHERE namespace = ? AND scope = ? AND value = ?`
                )
                .get(namespace, scope, value) as { owner_id: string } | undefined;
            return row?.owner_id ?? null;
        });
    }

    async releaseUnique(
        namespace: string,
        scope: string,
        value: string,
        ownerId: string
    ): Promise<boolean> {
        return this.operation(() => {
            const result = this.requireDatabase()
                .prepare(
                    `DELETE FROM agentscope_unique_constraints
                     WHERE namespace = ? AND scope = ? AND value = ? AND owner_id = ?`
                )
                .run(namespace, scope, value, ownerId);
            return Number(result.changes) === 1;
        });
    }

    async upsertMessage(
        userId: string,
        sessionId: string,
        messageId: string,
        payload: string
    ): Promise<void> {
        await this.operation(() => {
            this.requireDatabase()
                .prepare(
                    `INSERT INTO agentscope_messages
                     (user_id, session_id, message_id, payload) VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id, session_id, message_id)
                     DO UPDATE SET payload = excluded.payload`
                )
                .run(userId, sessionId, messageId, payload);
        });
    }

    async getMessages(userId: string, sessionId: string): Promise<SQLMessageRow[]> {
        return this.operation(() =>
            this.requireDatabase()
                .prepare(
                    `SELECT message_id, payload, sequence FROM agentscope_messages
                     WHERE user_id = ? AND session_id = ? ORDER BY sequence`
                )
                .all(userId, sessionId)
                .map(row => {
                    const value = row as Record<string, unknown>;
                    return {
                        messageId: String(value.message_id),
                        payload: String(value.payload),
                        sequence: Number(value.sequence),
                    };
                })
        );
    }

    async deleteMessages(userId: string, sessionId: string): Promise<void> {
        await this.operation(() => {
            this.requireDatabase()
                .prepare(`DELETE FROM agentscope_messages WHERE user_id = ? AND session_id = ?`)
                .run(userId, sessionId);
        });
    }

    private async operation<T>(work: () => T): Promise<T> {
        if (this.transactionContext.getStore()) return work();
        return this.exclusive(work);
    }

    private async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
        const previous = this.gate;
        let release = (): void => {};
        this.gate = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await work();
        } finally {
            release();
        }
    }

    private requireDatabase(): SQLiteDatabaseLike {
        if (!this.database) throw new Error('SQL driver is not open.');
        return this.database;
    }

    private toRecordRow(input: unknown): SQLRecordRow {
        const row = input as Record<string, unknown>;
        return {
            kind: String(row.kind),
            id: String(row.id),
            userId: String(row.user_id),
            payload: String(row.payload),
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
        };
    }
}
