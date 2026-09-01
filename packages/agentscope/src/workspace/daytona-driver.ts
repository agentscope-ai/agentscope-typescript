/* eslint-disable jsdoc/require-jsdoc */

export type DaytonaSandboxState =
    | 'started'
    | 'stopped'
    | 'starting'
    | 'stopping'
    | 'error'
    | 'pausing'
    | 'paused'
    | 'resuming'
    | string;

export interface DaytonaCommandOutput {
    exitCode: number;
    result: string;
}

export interface DaytonaSandboxDriver {
    readonly id: string;
    readonly state: DaytonaSandboxState | null;
    readonly recoverable: boolean | null;
    readonly createdAt: string | null;
    readonly updatedAt: string | null;
    readonly lastActivityAt: string | null;
    executeCommand(
        commandLine: string,
        cwd: string,
        timeoutSeconds?: number
    ): Promise<DaytonaCommandOutput>;
    downloadFile(filePath: string): Promise<Uint8Array>;
    uploadFile(data: Uint8Array, filePath: string): Promise<void>;
    getWorkDir(): Promise<string>;
    getUserHomeDir(): Promise<string>;
    start(timeoutSeconds: number): Promise<void>;
    recover(timeoutSeconds: number): Promise<void>;
    stop(timeoutSeconds: number, force: boolean): Promise<void>;
    waitUntilStarted(timeoutSeconds: number): Promise<void>;
    waitUntilStopped(timeoutSeconds: number): Promise<void>;
    refreshData(): Promise<void>;
}

export interface DaytonaClientOptions {
    apiKey?: string;
    apiUrl?: string;
    target?: string;
}

export interface DaytonaListOptions {
    labels: Record<string, string>;
    states: DaytonaSandboxState[];
}

export interface DaytonaCreateOptions {
    labels: Record<string, string>;
    public: boolean;
    env?: Record<string, string>;
    osUser?: string;
    timeoutSeconds: number;
}

export interface DaytonaClientDriver {
    list(options: DaytonaListOptions): Promise<DaytonaSandboxDriver[]>;
    create(options: DaytonaCreateOptions): Promise<DaytonaSandboxDriver>;
    close(): Promise<void>;
}

interface RawCommandOutput {
    exitCode: number;
    result: string;
}

interface RawSandbox {
    readonly id: string;
    state?: unknown;
    readonly recoverable?: boolean;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly lastActivityAt?: string;
    readonly process: {
        executeCommand(
            commandLine: string,
            cwd?: string,
            env?: Record<string, string>,
            timeoutSeconds?: number
        ): Promise<RawCommandOutput>;
    };
    readonly fs: {
        downloadFile(filePath: string): Promise<Uint8Array>;
        uploadFile(data: Buffer, filePath: string): Promise<void>;
    };
    getWorkDir(): Promise<string | undefined>;
    getUserHomeDir(): Promise<string | undefined>;
    start(timeoutSeconds?: number): Promise<void>;
    recover(timeoutSeconds?: number): Promise<void>;
    stop(timeoutSeconds?: number, force?: boolean): Promise<void>;
    waitUntilStarted(timeoutSeconds?: number): Promise<void>;
    waitUntilStopped(timeoutSeconds?: number): Promise<void>;
    refreshData(): Promise<void>;
}

interface RawDaytona {
    list(options: { labels: Record<string, string>; states: unknown[] }): AsyncIterable<RawSandbox>;
    create(
        options: {
            labels: Record<string, string>;
            public: boolean;
            envVars?: Record<string, string>;
            user?: string;
        },
        operation: { timeout: number }
    ): Promise<RawSandbox>;
    close?: () => Promise<void>;
    [Symbol.asyncDispose]?: () => Promise<void>;
}

type RawDaytonaConstructor = new (options?: DaytonaClientOptions) => RawDaytona;

interface DaytonaModule {
    Daytona?: RawDaytonaConstructor;
    SandboxState?: Record<string, unknown>;
}

/**
 * Load the optional Daytona SDK and adapt it to the workspace boundary.
 * @param options Daytona connection settings.
 * @returns A Daytona client driver.
 */
export async function createDaytonaClient(
    options: DaytonaClientOptions = {}
): Promise<DaytonaClientDriver> {
    const moduleName = '@daytona/sdk';
    let imported: DaytonaModule;
    try {
        imported = (await import(moduleName)) as DaytonaModule;
    } catch (error) {
        throw new Error(
            `DaytonaWorkspace requires the optional "@daytona/sdk" dependency: ${String(error)}`
        );
    }
    if (!imported.Daytona) {
        throw new Error('The installed "@daytona/sdk" package does not export Daytona.');
    }
    const client = Object.keys(options).length
        ? new imported.Daytona(options)
        : new imported.Daytona();
    return new DaytonaSdkClient(client, imported.SandboxState ?? {});
}

class DaytonaSdkClient implements DaytonaClientDriver {
    constructor(
        private readonly client: RawDaytona,
        private readonly states: Record<string, unknown>
    ) {}

    async list(options: DaytonaListOptions): Promise<DaytonaSandboxDriver[]> {
        const sandboxes: DaytonaSandboxDriver[] = [];
        const rawStates = options.states.map(state => this.states[state.toUpperCase()] ?? state);
        for await (const sandbox of this.client.list({
            labels: options.labels,
            states: rawStates,
        })) {
            sandboxes.push(new DaytonaSdkSandbox(sandbox));
        }
        return sandboxes;
    }

    async create(options: DaytonaCreateOptions): Promise<DaytonaSandboxDriver> {
        const sandbox = await this.client.create(
            {
                labels: options.labels,
                public: options.public,
                ...(options.env ? { envVars: options.env } : {}),
                ...(options.osUser === undefined ? {} : { user: options.osUser }),
            },
            { timeout: options.timeoutSeconds }
        );
        return new DaytonaSdkSandbox(sandbox);
    }

    async close(): Promise<void> {
        if (this.client.close) await this.client.close();
        else {
            const dispose = this.client[Symbol.asyncDispose];
            if (dispose) await dispose.call(this.client);
        }
    }
}

class DaytonaSdkSandbox implements DaytonaSandboxDriver {
    constructor(private readonly sandbox: RawSandbox) {}

    get id(): string {
        return this.sandbox.id;
    }

    get state(): DaytonaSandboxState | null {
        return normalizeState(this.sandbox.state);
    }

    get recoverable(): boolean | null {
        return this.sandbox.recoverable ?? null;
    }

    get createdAt(): string | null {
        return this.sandbox.createdAt ?? null;
    }

    get updatedAt(): string | null {
        return this.sandbox.updatedAt ?? null;
    }

    get lastActivityAt(): string | null {
        return this.sandbox.lastActivityAt ?? null;
    }

    async executeCommand(
        commandLine: string,
        cwd: string,
        timeoutSeconds?: number
    ): Promise<DaytonaCommandOutput> {
        return this.sandbox.process.executeCommand(commandLine, cwd, undefined, timeoutSeconds);
    }

    async downloadFile(filePath: string): Promise<Uint8Array> {
        return this.sandbox.fs.downloadFile(filePath);
    }

    async uploadFile(data: Uint8Array, filePath: string): Promise<void> {
        await this.sandbox.fs.uploadFile(Buffer.from(data), filePath);
    }

    async getWorkDir(): Promise<string> {
        return requireSdkPath(await this.sandbox.getWorkDir(), 'working directory');
    }

    async getUserHomeDir(): Promise<string> {
        return requireSdkPath(await this.sandbox.getUserHomeDir(), 'user home directory');
    }

    async start(timeoutSeconds: number): Promise<void> {
        await this.sandbox.start(timeoutSeconds);
    }

    async recover(timeoutSeconds: number): Promise<void> {
        await this.sandbox.recover(timeoutSeconds);
    }

    async stop(timeoutSeconds: number, force: boolean): Promise<void> {
        await this.sandbox.stop(timeoutSeconds, force);
    }

    async waitUntilStarted(timeoutSeconds: number): Promise<void> {
        await this.sandbox.waitUntilStarted(timeoutSeconds);
    }

    async waitUntilStopped(timeoutSeconds: number): Promise<void> {
        await this.sandbox.waitUntilStopped(timeoutSeconds);
    }

    async refreshData(): Promise<void> {
        await this.sandbox.refreshData();
    }
}

function normalizeState(value: unknown): DaytonaSandboxState | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && 'value' in value) {
        return String((value as { value: unknown }).value).toLowerCase();
    }
    return String(value).toLowerCase();
}

function requireSdkPath(value: string | undefined, name: string): string {
    if (!value) throw new Error(`Daytona SDK did not return a ${name}.`);
    return value;
}
