/* eslint-disable jsdoc/require-jsdoc */

import { Readable, Writable } from 'node:stream';

export interface K8sObjectMetadata {
    deletionTimestamp?: string | Date | null;
    [key: string]: unknown;
}

export interface K8sContainerStatus {
    state?: {
        waiting?: { reason?: string | null; message?: string | null } | null;
    } | null;
}

export interface K8sPodCondition {
    type?: string | null;
    status?: string | null;
    reason?: string | null;
    message?: string | null;
}

export interface K8sPod {
    metadata?: K8sObjectMetadata | null;
    status?: {
        phase?: string | null;
        containerStatuses?: K8sContainerStatus[] | null;
        conditions?: K8sPodCondition[] | null;
    } | null;
    [key: string]: unknown;
}

export interface K8sPersistentVolumeClaim {
    metadata?: K8sObjectMetadata | null;
    [key: string]: unknown;
}

export interface K8sExecRequest {
    namespace: string;
    podName: string;
    containerName: string;
    command: string[];
    stdin?: Uint8Array | AsyncIterable<Uint8Array>;
}

export interface K8sExecOutput {
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
}

export interface K8sClientDriver {
    readNamespace(name: string): Promise<Record<string, unknown>>;
    createNamespace(body: Record<string, unknown>): Promise<void>;
    readPersistentVolumeClaim(name: string, namespace: string): Promise<K8sPersistentVolumeClaim>;
    createPersistentVolumeClaim(namespace: string, body: Record<string, unknown>): Promise<void>;
    deletePersistentVolumeClaim(name: string, namespace: string): Promise<void>;
    readPod(name: string, namespace: string): Promise<K8sPod>;
    createPod(namespace: string, body: Record<string, unknown>): Promise<void>;
    deletePod(name: string, namespace: string): Promise<void>;
    exec(request: K8sExecRequest): Promise<K8sExecOutput>;
    close(): Promise<void>;
}

interface RawCoreV1Api {
    readNamespace(input: { name: string }): Promise<unknown>;
    createNamespace(input: { body: Record<string, unknown> }): Promise<unknown>;
    readNamespacedPersistentVolumeClaim(input: {
        name: string;
        namespace: string;
    }): Promise<unknown>;
    createNamespacedPersistentVolumeClaim(input: {
        namespace: string;
        body: Record<string, unknown>;
    }): Promise<unknown>;
    deleteNamespacedPersistentVolumeClaim(input: {
        name: string;
        namespace: string;
    }): Promise<unknown>;
    readNamespacedPod(input: { name: string; namespace: string }): Promise<unknown>;
    createNamespacedPod(input: {
        namespace: string;
        body: Record<string, unknown>;
    }): Promise<unknown>;
    deleteNamespacedPod(input: { name: string; namespace: string }): Promise<unknown>;
}

interface RawSocket {
    once(event: 'close', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    readyState?: number;
}

interface RawStatus {
    status?: string;
    details?: { causes?: Array<{ message?: string }> };
}

interface RawExec {
    exec(
        namespace: string,
        podName: string,
        containerName: string,
        command: string[],
        stdout: Writable,
        stderr: Writable,
        stdin: Readable | null,
        tty: boolean,
        statusCallback: (status: RawStatus) => void
    ): Promise<RawSocket>;
}

interface RawKubeConfig {
    loadFromFile(filePath: string): void;
    loadFromCluster(): void;
    loadFromDefault(): void;
    makeApiClient(constructor: unknown): RawCoreV1Api;
}

interface KubernetesModule {
    KubeConfig: new () => RawKubeConfig;
    CoreV1Api: unknown;
    Exec: new (configuration: RawKubeConfig) => RawExec;
}

/**
 * Load the optional official Kubernetes JavaScript client.
 * @param kubeconfig Explicit kubeconfig path, or cluster/default discovery when omitted.
 * @returns A Kubernetes client driver.
 */
export async function createK8sClient(kubeconfig?: string | null): Promise<K8sClientDriver> {
    const moduleName = '@kubernetes/client-node';
    let sdk: KubernetesModule;
    try {
        sdk = (await import(moduleName)) as unknown as KubernetesModule;
    } catch (error) {
        throw new Error(
            `K8sWorkspace requires the optional "@kubernetes/client-node" dependency: ${String(error)}`
        );
    }
    return createK8sClientFromSdk(sdk, kubeconfig);
}

/**
 * Adapt one official Kubernetes SDK module to the stable workspace boundary.
 * @param sdk Loaded Kubernetes SDK module.
 * @param kubeconfig Explicit kubeconfig path, or cluster/default discovery when omitted.
 * @returns A Kubernetes client driver.
 */
export function createK8sClientFromSdk(
    sdk: KubernetesModule,
    kubeconfig?: string | null
): K8sClientDriver {
    const configuration = new sdk.KubeConfig();
    if (kubeconfig) configuration.loadFromFile(kubeconfig);
    else {
        try {
            configuration.loadFromCluster();
        } catch {
            configuration.loadFromDefault();
        }
    }
    return new KubernetesSdkClient(
        configuration.makeApiClient(sdk.CoreV1Api),
        new sdk.Exec(configuration)
    );
}

class KubernetesSdkClient implements K8sClientDriver {
    constructor(
        private readonly core: RawCoreV1Api,
        private readonly executor: RawExec
    ) {}

    async readNamespace(name: string): Promise<Record<string, unknown>> {
        return unwrapObject(await this.core.readNamespace({ name }));
    }

    async createNamespace(body: Record<string, unknown>): Promise<void> {
        await this.core.createNamespace({ body });
    }

    async readPersistentVolumeClaim(
        name: string,
        namespace: string
    ): Promise<K8sPersistentVolumeClaim> {
        return unwrapObject(
            await this.core.readNamespacedPersistentVolumeClaim({ name, namespace })
        ) as K8sPersistentVolumeClaim;
    }

    async createPersistentVolumeClaim(
        namespace: string,
        body: Record<string, unknown>
    ): Promise<void> {
        await this.core.createNamespacedPersistentVolumeClaim({ namespace, body });
    }

    async deletePersistentVolumeClaim(name: string, namespace: string): Promise<void> {
        await this.core.deleteNamespacedPersistentVolumeClaim({ name, namespace });
    }

    async readPod(name: string, namespace: string): Promise<K8sPod> {
        return unwrapObject(await this.core.readNamespacedPod({ name, namespace })) as K8sPod;
    }

    async createPod(namespace: string, body: Record<string, unknown>): Promise<void> {
        await this.core.createNamespacedPod({ namespace, body });
    }

    async deletePod(name: string, namespace: string): Promise<void> {
        await this.core.deleteNamespacedPod({ name, namespace });
    }

    async exec(request: K8sExecRequest): Promise<K8sExecOutput> {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let exitCode = 0;
        const stdin = request.stdin ? readableInput(request.stdin) : null;
        const socket = await this.executor.exec(
            request.namespace,
            request.podName,
            request.containerName,
            request.command,
            bufferSink(stdout),
            bufferSink(stderr),
            stdin,
            false,
            status => {
                exitCode = statusExitCode(status);
            }
        );
        await waitForSocket(socket);
        return {
            exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
        };
    }

    async close(): Promise<void> {}
}

function readableInput(input: Uint8Array | AsyncIterable<Uint8Array>): Readable {
    return input instanceof Uint8Array ? Readable.from([Buffer.from(input)]) : Readable.from(input);
}

function bufferSink(chunks: Buffer[]): Writable {
    return new Writable({
        write(chunk: Uint8Array, _encoding, callback): void {
            chunks.push(Buffer.from(chunk));
            callback();
        },
    });
}

async function waitForSocket(socket: RawSocket): Promise<void> {
    if (socket.readyState === 3) return;
    await new Promise<void>((resolve, reject) => {
        socket.once('close', resolve);
        socket.once('error', reject);
    });
}

function statusExitCode(status: RawStatus): number {
    if (status.status === 'Success') return 0;
    const raw = status.details?.causes?.[0]?.message;
    if (raw !== undefined) {
        const parsed = Number(raw);
        if (Number.isInteger(parsed)) return parsed;
    }
    return 1;
}

function unwrapObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') return {};
    const record = value as Record<string, unknown>;
    const body = record.body;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : record;
}

/**
 * Extract an HTTP status code from official-client and test-double errors.
 * @param error Unknown client error.
 * @returns The HTTP status code when present.
 */
export function k8sErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const record = error as Record<string, unknown>;
    const response = record.response as Record<string, unknown> | undefined;
    const value = record.code ?? record.statusCode ?? record.status ?? response?.statusCode;
    return typeof value === 'number' ? value : null;
}
