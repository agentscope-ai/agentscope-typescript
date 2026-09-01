/* eslint-disable jsdoc/require-jsdoc */

export interface E2BCommandOutput {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface E2BSandboxInfo {
    sandboxId: string;
    startedAt: Date;
}

export interface E2BRunOptions {
    cwd: string;
    timeoutSeconds?: number;
    signal?: AbortSignal;
}

export interface E2BSandboxDriver {
    readonly sandboxId: string;
    run(commandLine: string, options: E2BRunOptions): Promise<E2BCommandOutput>;
    readFile(filePath: string): Promise<Uint8Array>;
    writeFile(filePath: string, data: Uint8Array): Promise<void>;
    isRunning(): Promise<boolean>;
    pause(): Promise<boolean | void>;
}

export interface E2BApiOptions {
    apiKey?: string;
    domain?: string;
}

export interface E2BListOptions extends E2BApiOptions {
    metadata: Record<string, string>;
    state: Array<'paused' | 'running'>;
}

export interface E2BListResult {
    sandboxes: E2BSandboxInfo[];
    error?: unknown;
}

export interface E2BConnectOptions extends E2BApiOptions {
    timeoutSeconds: number;
}

export interface E2BCreateOptions extends E2BConnectOptions {
    template: string;
    metadata: Record<string, string>;
    env?: Record<string, string>;
}

export interface E2BClientDriver {
    list(options: E2BListOptions): Promise<E2BListResult>;
    connect(sandboxId: string, options: E2BConnectOptions): Promise<E2BSandboxDriver>;
    create(options: E2BCreateOptions): Promise<E2BSandboxDriver>;
}

interface RawCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

interface RawSandbox {
    readonly sandboxId: string;
    readonly commands: {
        run(
            commandLine: string,
            options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }
        ): Promise<RawCommandResult>;
    };
    readonly files: {
        read(filePath: string, options: { format: 'bytes' }): Promise<Uint8Array>;
        write(filePath: string, data: ArrayBuffer): Promise<unknown>;
    };
    isRunning(): Promise<boolean>;
    pause(): Promise<boolean>;
}

interface RawPaginator {
    readonly hasNext: boolean;
    nextItems(): Promise<Array<{ sandboxId: string; startedAt: Date }>>;
}

interface RawSandboxConstructor {
    list(options: {
        query: {
            metadata: Record<string, string>;
            state: Array<'paused' | 'running'>;
        };
        apiKey?: string;
        domain?: string;
    }): RawPaginator;
    connect(
        sandboxId: string,
        options: { timeoutMs: number; apiKey?: string; domain?: string }
    ): Promise<RawSandbox>;
    create(
        template: string,
        options: {
            timeoutMs: number;
            metadata: Record<string, string>;
            envs?: Record<string, string>;
            apiKey?: string;
            domain?: string;
        }
    ): Promise<RawSandbox>;
}

/**
 * Load the optional E2B SDK and adapt it to the stable workspace boundary.
 * @returns An E2B client driver.
 */
export async function createE2BClient(): Promise<E2BClientDriver> {
    const moduleName = 'e2b';
    let imported: { Sandbox?: RawSandboxConstructor; default?: RawSandboxConstructor };
    try {
        imported = (await import(moduleName)) as {
            Sandbox?: RawSandboxConstructor;
            default?: RawSandboxConstructor;
        };
    } catch (error) {
        throw new Error(`E2BWorkspace requires the optional "e2b" dependency: ${String(error)}`);
    }
    const Sandbox = imported.Sandbox ?? imported.default;
    if (!Sandbox) throw new Error('The installed "e2b" package does not export Sandbox.');
    return new E2BSdkClient(Sandbox);
}

class E2BSdkClient implements E2BClientDriver {
    constructor(private readonly Sandbox: RawSandboxConstructor) {}

    async list(options: E2BListOptions): Promise<E2BListResult> {
        const paginator = this.Sandbox.list({
            query: { metadata: options.metadata, state: options.state },
            ...apiOptions(options),
        });
        const candidates: E2BSandboxInfo[] = [];
        while (paginator.hasNext) {
            try {
                candidates.push(...(await paginator.nextItems()));
            } catch (error) {
                return { sandboxes: candidates, error };
            }
        }
        return { sandboxes: candidates };
    }

    async connect(sandboxId: string, options: E2BConnectOptions): Promise<E2BSandboxDriver> {
        const sandbox = await this.Sandbox.connect(sandboxId, {
            timeoutMs: secondsToMilliseconds(options.timeoutSeconds),
            ...apiOptions(options),
        });
        return new E2BSdkSandbox(sandbox);
    }

    async create(options: E2BCreateOptions): Promise<E2BSandboxDriver> {
        const sandbox = await this.Sandbox.create(options.template, {
            timeoutMs: secondsToMilliseconds(options.timeoutSeconds),
            metadata: options.metadata,
            ...(options.env ? { envs: options.env } : {}),
            ...apiOptions(options),
        });
        return new E2BSdkSandbox(sandbox);
    }
}

class E2BSdkSandbox implements E2BSandboxDriver {
    constructor(private readonly sandbox: RawSandbox) {}

    get sandboxId(): string {
        return this.sandbox.sandboxId;
    }

    async run(commandLine: string, options: E2BRunOptions): Promise<E2BCommandOutput> {
        return this.sandbox.commands.run(commandLine, {
            cwd: options.cwd,
            ...(options.timeoutSeconds === undefined
                ? {}
                : { timeoutMs: secondsToMilliseconds(options.timeoutSeconds) }),
            ...(options.signal ? { signal: options.signal } : {}),
        });
    }

    async readFile(filePath: string): Promise<Uint8Array> {
        return this.sandbox.files.read(filePath, { format: 'bytes' });
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const copy = new Uint8Array(data);
        await this.sandbox.files.write(filePath, copy.buffer);
    }

    async isRunning(): Promise<boolean> {
        return this.sandbox.isRunning();
    }

    async pause(): Promise<boolean> {
        return this.sandbox.pause();
    }
}

function secondsToMilliseconds(seconds: number): number {
    return seconds * 1000;
}

function apiOptions(options: E2BApiOptions): E2BApiOptions {
    return {
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.domain ? { domain: options.domain } : {}),
    };
}
