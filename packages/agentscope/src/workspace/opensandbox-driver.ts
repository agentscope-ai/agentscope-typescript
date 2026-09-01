/* eslint-disable jsdoc/require-jsdoc */

import { logger } from '../logger';

export type OpenSandboxProtocol = 'http' | 'https';

export interface OpenSandboxConnectionOptions {
    apiKey?: string;
    domain?: string;
    protocol: OpenSandboxProtocol;
    requestTimeoutSeconds?: number;
}

export interface OpenSandboxInfo {
    id: string;
    state: string;
    createdAt: Date;
}

export interface OpenSandboxRunOptions {
    workingDirectory: string;
    timeoutSeconds?: number;
    signal?: AbortSignal;
}

export interface OpenSandboxExecution {
    exitCode: number | null;
    stdout?: string | Uint8Array;
    stderr?: string | Uint8Array;
    stdoutLogs?: Array<string | { text?: string | null }>;
    stderrLogs?: Array<string | { text?: string | null }>;
}

export interface OpenSandboxWriteEntry {
    path: string;
    data: Uint8Array | AsyncIterable<Uint8Array>;
    mode: number;
}

export interface OpenSandboxSandboxDriver {
    readonly id: string;
    run(commandLine: string, options: OpenSandboxRunOptions): Promise<OpenSandboxExecution>;
    readBytes(filePath: string): Promise<Uint8Array>;
    writeFiles(entries: OpenSandboxWriteEntry[]): Promise<void>;
    isHealthy?(): Promise<boolean>;
    pause(): Promise<void>;
    close(): Promise<void>;
}

export interface OpenSandboxListOptions {
    states: string[];
    metadata: Record<string, string>;
}

export interface OpenSandboxCreateOptions {
    image: string;
    metadata: Record<string, string>;
    timeoutSeconds: number;
    readyTimeoutSeconds: number;
    env?: Record<string, string>;
    resource?: Record<string, string>;
    entrypoint?: string[];
    networkPolicy?: Record<string, unknown>;
}

export interface OpenSandboxClientDriver {
    list(options: OpenSandboxListOptions): Promise<OpenSandboxInfo[]>;
    create(options: OpenSandboxCreateOptions): Promise<OpenSandboxSandboxDriver>;
    connect(sandboxId: string, timeoutSeconds: number): Promise<OpenSandboxSandboxDriver>;
    resume(sandboxId: string, timeoutSeconds: number): Promise<OpenSandboxSandboxDriver>;
}

type RawConnectionConfig = object;

interface RawExecution {
    exitCode?: number | null;
    stdout?: unknown;
    stderr?: unknown;
    logs?: {
        stdout?: Array<string | { text?: string | null }>;
        stderr?: Array<string | { text?: string | null }>;
    };
}

interface RawSandbox {
    readonly id: string;
    readonly commands: {
        run(
            commandLine: string,
            options: { workingDirectory: string; timeoutSeconds?: number },
            handlers?: undefined,
            signal?: AbortSignal
        ): Promise<RawExecution>;
    };
    readonly files: {
        readBytes(filePath: string): Promise<Uint8Array>;
        writeFiles(entries: OpenSandboxWriteEntry[]): Promise<void>;
    };
    isHealthy?(): Promise<boolean>;
    pause(): Promise<void>;
    close(): Promise<void>;
}

interface RawSandboxInfo {
    id: string;
    status: { state: string };
    createdAt: Date | string;
}

interface RawManager {
    listSandboxInfos(options: OpenSandboxListOptions): Promise<{
        items: RawSandboxInfo[];
    }>;
    close(): Promise<void>;
}

interface OpenSandboxSdkModule {
    ConnectionConfig: new (options: OpenSandboxConnectionOptions) => RawConnectionConfig;
    SandboxManager: {
        create(options: { connectionConfig: RawConnectionConfig }): RawManager;
    };
    Sandbox: {
        create(options: Record<string, unknown>): Promise<RawSandbox>;
        connect(options: Record<string, unknown>): Promise<RawSandbox>;
        resume(options: Record<string, unknown>): Promise<RawSandbox>;
    };
}

/**
 * Load the optional official OpenSandbox JavaScript client.
 * @param connection OpenSandbox server connection settings.
 * @returns An OpenSandbox client driver.
 */
export async function createOpenSandboxClient(
    connection: OpenSandboxConnectionOptions
): Promise<OpenSandboxClientDriver> {
    const moduleName = '@alibaba-group/opensandbox';
    let sdk: OpenSandboxSdkModule;
    try {
        sdk = (await import(moduleName)) as unknown as OpenSandboxSdkModule;
    } catch (error) {
        throw new Error(
            'OpenSandboxWorkspace requires the optional ' +
                `"@alibaba-group/opensandbox" dependency: ${String(error)}`
        );
    }
    return createOpenSandboxClientFromSdk(sdk, connection);
}

/**
 * Adapt one official OpenSandbox SDK module to the workspace boundary.
 * @param sdk Loaded OpenSandbox SDK module.
 * @param connection OpenSandbox server connection settings.
 * @returns An OpenSandbox client driver.
 */
export function createOpenSandboxClientFromSdk(
    sdk: OpenSandboxSdkModule,
    connection: OpenSandboxConnectionOptions
): OpenSandboxClientDriver {
    return new OpenSandboxSdkClient(sdk, connection);
}

class OpenSandboxSdkClient implements OpenSandboxClientDriver {
    constructor(
        private readonly sdk: OpenSandboxSdkModule,
        private readonly connection: OpenSandboxConnectionOptions
    ) {}

    async list(options: OpenSandboxListOptions): Promise<OpenSandboxInfo[]> {
        const manager = this.sdk.SandboxManager.create({
            connectionConfig: this.connectionConfig(),
        });
        try {
            const result = await manager.listSandboxInfos(options);
            return result.items.map(item => ({
                id: item.id,
                state: item.status.state,
                createdAt: new Date(item.createdAt),
            }));
        } finally {
            await manager
                .close()
                .catch(error =>
                    logger.warning('OpenSandboxWorkspace: manager close failed: %s', String(error))
                );
        }
    }

    async create(options: OpenSandboxCreateOptions): Promise<OpenSandboxSandboxDriver> {
        return new OpenSandboxSdkSandbox(
            await this.sdk.Sandbox.create({
                connectionConfig: this.connectionConfig(),
                image: options.image,
                metadata: options.metadata,
                timeoutSeconds: options.timeoutSeconds,
                readyTimeoutSeconds: options.readyTimeoutSeconds,
                ...(options.env ? { env: options.env } : {}),
                ...(options.resource ? { resource: options.resource } : {}),
                ...(options.entrypoint ? { entrypoint: options.entrypoint } : {}),
                ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
            })
        );
    }

    async connect(sandboxId: string, timeoutSeconds: number): Promise<OpenSandboxSandboxDriver> {
        return new OpenSandboxSdkSandbox(
            await this.sdk.Sandbox.connect({
                sandboxId,
                connectionConfig: this.connectionConfig(),
                readyTimeoutSeconds: timeoutSeconds,
            })
        );
    }

    async resume(sandboxId: string, timeoutSeconds: number): Promise<OpenSandboxSandboxDriver> {
        return new OpenSandboxSdkSandbox(
            await this.sdk.Sandbox.resume({
                sandboxId,
                connectionConfig: this.connectionConfig(),
                readyTimeoutSeconds: timeoutSeconds,
            })
        );
    }

    private connectionConfig(): RawConnectionConfig {
        return new this.sdk.ConnectionConfig(this.connection);
    }
}

class OpenSandboxSdkSandbox implements OpenSandboxSandboxDriver {
    constructor(private readonly sandbox: RawSandbox) {}

    get id(): string {
        return this.sandbox.id;
    }

    async run(commandLine: string, options: OpenSandboxRunOptions): Promise<OpenSandboxExecution> {
        const result = await this.sandbox.commands.run(
            commandLine,
            {
                workingDirectory: options.workingDirectory,
                ...(options.timeoutSeconds === undefined
                    ? {}
                    : { timeoutSeconds: options.timeoutSeconds }),
            },
            undefined,
            options.signal
        );
        return {
            exitCode: result.exitCode ?? 0,
            ...(result.stdout === undefined
                ? {}
                : { stdout: normalizeDirectStream(result.stdout) }),
            ...(result.stderr === undefined
                ? {}
                : { stderr: normalizeDirectStream(result.stderr) }),
            stdoutLogs: result.logs?.stdout ?? [],
            stderrLogs: result.logs?.stderr ?? [],
        };
    }

    async readBytes(filePath: string): Promise<Uint8Array> {
        return this.sandbox.files.readBytes(filePath);
    }

    async writeFiles(entries: OpenSandboxWriteEntry[]): Promise<void> {
        await this.sandbox.files.writeFiles(entries);
    }

    async isHealthy(): Promise<boolean> {
        return (await this.sandbox.isHealthy?.()) ?? true;
    }

    async pause(): Promise<void> {
        await this.sandbox.pause();
    }

    async close(): Promise<void> {
        await this.sandbox.close();
    }
}

function normalizeDirectStream(value: unknown): string | Uint8Array {
    return value instanceof Uint8Array ? value : String(value);
}
