/* eslint-disable jsdoc/require-jsdoc */

import * as path from 'node:path';

import { logger } from '../logger';
import { BackendBase, ExecResult } from '../tool';
import type { WorkspaceBaseOptions } from './base';
import {
    createK8sClient,
    k8sErrorStatus,
    type K8sClientDriver,
    type K8sExecRequest,
    type K8sPod,
} from './k8s-driver';
import { SandboxedWorkspaceBase } from './sandboxed';
import { createSingleFileTar, readFirstFileFromTar } from './tar-buffer';
import { DEFAULT_WORKSPACE_INSTRUCTIONS, formatWorkspaceInstructions } from './utils';

export const DEFAULT_K8S_IMAGE = 'python:3.11-slim';
export const DEFAULT_K8S_GATEWAY_PORT = 5600;
export const K8S_POD_WORKDIR = '/workspace';
export const K8S_GATEWAY_HOME = '/root/.agentscope';
export const K8S_SYSTEM_DEPS = ['curl', 'ca-certificates', 'ripgrep'] as const;

export function k8sSafeName(workspaceId: string, prefix = 'as-ws-'): string {
    return `${prefix}${workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
        .slice(0, 63)
        .replace(/-+$/, '');
}

export interface K8sBackendOptions {
    client: K8sClientDriver;
    namespace: string;
    podName: string;
    containerName: string;
    workdir: string;
}

/** Backend that delegates argv execution and tar-stream I/O to a Kubernetes Pod. */
export class K8sBackend extends BackendBase {
    readonly client: K8sClientDriver;
    readonly namespace: string;
    readonly podName: string;
    readonly containerName: string;
    readonly workdir: string;

    constructor(options: K8sBackendOptions) {
        super();
        this.client = options.client;
        this.namespace = options.namespace;
        this.podName = options.podName;
        this.containerName = options.containerName;
        this.workdir = options.workdir;
    }

    override async getCwd(): Promise<string> {
        return this.workdir;
    }

    async execShell(
        command: string[],
        options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}
    ): Promise<ExecResult> {
        if (options.signal?.aborted) {
            return new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') });
        }
        const cwd = options.cwd ?? this.workdir;
        const operation = this.client
            .exec({
                ...this.execTarget(),
                command: [
                    'sh',
                    '-c',
                    `cd ${quotePosixShellArgument(cwd)} && exec "$@"`,
                    '--',
                    ...command,
                ],
            })
            .then(output => new ExecResult(output));
        return raceExecution(operation, options.timeout, options.signal);
    }

    async readFile(filePath: string): Promise<Buffer> {
        const directory = path.posix.dirname(filePath) || '/';
        const name = path.posix.basename(filePath);
        const result = await this.execShell(['tar', 'cf', '-', '-C', directory, name], {
            cwd: '/',
        });
        if (!result.ok()) {
            const detail = result.stderr.toString('utf8');
            const suffix = detail ? ` (tar stderr: ${detail})` : '';
            throw new Error(`not found in Pod: ${filePath}${suffix}`);
        }
        try {
            const content = await readFirstFileFromTar(result.stdout);
            if (content !== null) return content;
        } catch {}
        throw new Error(`not found in Pod: ${filePath}`);
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const parent = path.posix.dirname(filePath) || '/';
        const name = path.posix.basename(filePath);
        await this.execShell(['mkdir', '-p', parent]);
        await this.execStdin(
            ['tar', 'xf', '-', '-C', parent],
            createSingleFileTar(name, data),
            filePath
        );
    }

    override async writeStream(filePath: string, stream: AsyncIterable<Uint8Array>): Promise<void> {
        const parent = path.posix.dirname(filePath) || '/';
        await this.execShell(['mkdir', '-p', parent]);
        await this.execStdin(['sh', '-c', 'cat > "$1"', 'sh', filePath], stream, filePath);
    }

    private execTarget(): Pick<K8sExecRequest, 'namespace' | 'podName' | 'containerName'> {
        return {
            namespace: this.namespace,
            podName: this.podName,
            containerName: this.containerName,
        };
    }

    private async execStdin(
        command: string[],
        stdin: Uint8Array | AsyncIterable<Uint8Array>,
        filePath: string
    ): Promise<void> {
        const result = await this.client.exec({ ...this.execTarget(), command, stdin });
        if (result.exitCode !== 0) {
            throw new Error(
                `write to ${JSON.stringify(filePath)} failed: ${command[0]} exited ` +
                    `${result.exitCode}: ${result.stderr.toString('utf8')}`
            );
        }
    }
}

export interface K8sWorkspaceOptions extends WorkspaceBaseOptions {
    kubeconfig?: string | null;
    namespace?: string;
    image?: string;
    imagePullPolicy?: string;
    imagePullSecrets?: string[];
    resources?: Record<string, unknown> | null;
    nodeSelector?: Record<string, string> | null;
    tolerations?: Array<Record<string, unknown>> | null;
    serviceAccount?: string | null;
    gatewayPort?: number;
    extraPip?: string[];
    storageClass?: string | null;
    storageSize?: string;
    deletePvcOnClose?: boolean;
    env?: Record<string, string>;
    instructions?: string;
    client?: K8sClientDriver;
    clientFactory?: (kubeconfig?: string | null) => Promise<K8sClientDriver>;
}

/** Kubernetes Pod workspace with PVC-backed state. */
export class K8sWorkspace extends SandboxedWorkspaceBase {
    readonly workdir = K8S_POD_WORKDIR;
    readonly kubeconfig: string | null;
    readonly namespace: string;
    readonly image: string;
    readonly imagePullPolicy: string;
    readonly imagePullSecrets: string[];
    readonly resources: Record<string, unknown> | null;
    readonly nodeSelector: Record<string, string> | null;
    readonly tolerations: Array<Record<string, unknown>> | null;
    readonly serviceAccount: string | null;
    readonly gatewayPort: number;
    readonly extraPip: string[];
    readonly storageClass: string | null;
    readonly storageSize: string;
    readonly deletePvcOnClose: boolean;
    readonly env: Record<string, string>;
    readonly instructions: string;
    protected readonly gatewayHome = K8S_GATEWAY_HOME;
    protected client: K8sClientDriver | null;
    protected podName = '';
    private readonly clientFactory: (kubeconfig?: string | null) => Promise<K8sClientDriver>;

    constructor(options: K8sWorkspaceOptions = {}) {
        super(options);
        this.kubeconfig = options.kubeconfig ?? null;
        this.namespace = options.namespace ?? 'agentscope';
        this.image = options.image ?? DEFAULT_K8S_IMAGE;
        this.imagePullPolicy = options.imagePullPolicy ?? 'IfNotPresent';
        this.imagePullSecrets = [...(options.imagePullSecrets ?? [])];
        this.resources = options.resources ? structuredClone(options.resources) : null;
        this.nodeSelector = options.nodeSelector ? { ...options.nodeSelector } : null;
        this.tolerations = options.tolerations
            ? options.tolerations.map(item => structuredClone(item))
            : null;
        this.serviceAccount = options.serviceAccount ?? null;
        this.gatewayPort = options.gatewayPort ?? DEFAULT_K8S_GATEWAY_PORT;
        this.extraPip = [...(options.extraPip ?? [])];
        this.storageClass = options.storageClass ?? null;
        this.storageSize = options.storageSize ?? '1Gi';
        this.deletePvcOnClose = options.deletePvcOnClose ?? false;
        this.env = { ...(options.env ?? {}) };
        this.instructions = formatWorkspaceInstructions(
            options.instructions ?? DEFAULT_WORKSPACE_INSTRUCTIONS,
            { backend: 'Kubernetes-based', workdir: this.workdir }
        );
        this.client = options.client ?? null;
        this.clientFactory = options.clientFactory ?? createK8sClient;
    }

    async getInstructions(): Promise<string> {
        return this.instructions;
    }

    protected async provisionBackend(): Promise<void> {
        this.client ??= await this.clientFactory(this.kubeconfig);
        this.podName = k8sSafeName(this.workspaceId);
        await this.ensureNamespace();
        await this.ensurePvc();
        await this.ensurePod();
        await this.waitPodRunning();
        this.backend = new K8sBackend({
            client: this.client,
            namespace: this.namespace,
            podName: this.podName,
            containerName: 'workspace',
            workdir: this.workdir,
        });
    }

    protected async teardownBackend(): Promise<void> {
        const client = this.client;
        if (client && this.podName) {
            await client
                .deletePod(this.podName, this.namespace)
                .catch(error =>
                    logger.warning('K8sWorkspace: Pod delete failed: %s', String(error))
                );
            if (this.deletePvcOnClose) {
                await client
                    .deletePersistentVolumeClaim(this.podName, this.namespace)
                    .catch(error =>
                        logger.warning('K8sWorkspace: PVC delete failed: %s', String(error))
                    );
            }
        }
        if (client) await client.close().catch(() => undefined);
        this.client = null;
        this.backend = null;
    }

    protected async ensureNamespace(): Promise<void> {
        const client = this.requireClient();
        try {
            await client.readNamespace(this.namespace);
        } catch (error) {
            if (k8sErrorStatus(error) !== 404) throw error;
            await client.createNamespace({
                apiVersion: 'v1',
                kind: 'Namespace',
                metadata: { name: this.namespace },
            });
        }
    }

    protected async ensurePvc(): Promise<void> {
        const client = this.requireClient();
        try {
            const pvc = await client.readPersistentVolumeClaim(this.podName, this.namespace);
            if (pvc.metadata?.deletionTimestamp != null) {
                await this.waitPvcDeleted(this.podName);
                await this.createPvc(this.podName);
            }
        } catch (error) {
            if (k8sErrorStatus(error) !== 404) throw error;
            await this.createPvc(this.podName);
        }
    }

    protected async createPvc(name: string): Promise<void> {
        const spec: Record<string, unknown> = {
            accessModes: ['ReadWriteOnce'],
            resources: { requests: { storage: this.storageSize } },
        };
        if (this.storageClass !== null) spec.storageClassName = this.storageClass;
        await this.requireClient().createPersistentVolumeClaim(this.namespace, {
            apiVersion: 'v1',
            kind: 'PersistentVolumeClaim',
            metadata: {
                name,
                namespace: this.namespace,
                labels: {
                    'app.kubernetes.io/managed-by': 'agentscope',
                    'agentscope.workspace.id': this.workspaceId,
                },
            },
            spec,
        });
    }

    protected async ensurePod(): Promise<void> {
        const client = this.requireClient();
        try {
            const pod = await client.readPod(this.podName, this.namespace);
            const phase = pod.status?.phase ?? null;
            if (pod.metadata?.deletionTimestamp != null) {
                await this.waitPodDeleted();
                await this.createPod();
                return;
            }
            if (phase === 'Running' || phase === 'Pending') return;
            logger.info(
                'K8sWorkspace: Pod %s has phase %s, deleting and recreating',
                JSON.stringify(this.podName),
                JSON.stringify(phase)
            );
            await client.deletePod(this.podName, this.namespace).catch(() => undefined);
            await this.waitPodDeleted();
            await this.createPod();
        } catch (error) {
            if (k8sErrorStatus(error) !== 404) throw error;
            await this.createPod();
        }
    }

    protected async createPod(): Promise<void> {
        const container: Record<string, unknown> = {
            name: 'workspace',
            image: this.image,
            imagePullPolicy: this.imagePullPolicy,
            command: ['sleep', 'infinity'],
            workingDir: this.workdir,
            ports: [{ containerPort: this.gatewayPort }],
            volumeMounts: [{ name: 'workspace-data', mountPath: this.workdir }],
        };
        if (this.resources) container.resources = structuredClone(this.resources);
        if (Object.keys(this.env).length) {
            container.env = Object.entries(this.env).map(([name, value]) => ({ name, value }));
        }
        const spec: Record<string, unknown> = {
            restartPolicy: 'OnFailure',
            containers: [container],
            volumes: [
                {
                    name: 'workspace-data',
                    persistentVolumeClaim: { claimName: this.podName },
                },
            ],
        };
        if (this.nodeSelector) spec.nodeSelector = { ...this.nodeSelector };
        if (this.tolerations)
            spec.tolerations = this.tolerations.map(item => structuredClone(item));
        if (this.serviceAccount) spec.serviceAccountName = this.serviceAccount;
        if (this.imagePullSecrets.length) {
            spec.imagePullSecrets = this.imagePullSecrets.map(name => ({ name }));
        }
        await this.requireClient().createPod(this.namespace, {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
                name: this.podName,
                namespace: this.namespace,
                labels: {
                    'app.kubernetes.io/managed-by': 'agentscope',
                    'agentscope.workspace': 'true',
                    'agentscope.workspace.id': this.workspaceId,
                },
            },
            spec,
        });
    }

    protected async waitPodRunning(timeoutSeconds = 120): Promise<void> {
        const deadline = this.now() + timeoutSeconds * 1000;
        let delay = 500;
        while (this.now() < deadline) {
            const pod = await this.requireClient().readPod(this.podName, this.namespace);
            const phase = pod.status?.phase ?? null;
            if (phase === 'Running') return;
            if (phase === 'Failed' || phase === 'Unknown') {
                throw new Error(`Pod ${JSON.stringify(this.podName)} entered ${phase} state`);
            }
            if (phase === 'Pending') this.raisePendingFailure(pod);
            await this.sleep(delay);
            delay = Math.min(delay * 1.5, 3000);
        }
        throw new Error(
            `Pod ${JSON.stringify(this.podName)} did not become Running within ${timeoutSeconds}s`
        );
    }

    protected async waitPodDeleted(timeoutSeconds = 30): Promise<void> {
        const deadline = this.now() + timeoutSeconds * 1000;
        while (this.now() < deadline) {
            try {
                await this.requireClient().readPod(this.podName, this.namespace);
            } catch (error) {
                if (k8sErrorStatus(error) === 404) return;
                throw error;
            }
            await this.sleep(1000);
        }
        throw new Error(
            `Pod ${JSON.stringify(this.podName)} did not finish deleting within ${timeoutSeconds}s`
        );
    }

    protected async waitPvcDeleted(name: string, timeoutSeconds = 60): Promise<void> {
        const deadline = this.now() + timeoutSeconds * 1000;
        while (this.now() < deadline) {
            try {
                await this.requireClient().readPersistentVolumeClaim(name, this.namespace);
            } catch (error) {
                if (k8sErrorStatus(error) === 404) return;
                throw error;
            }
            await this.sleep(1000);
        }
        throw new Error(
            `PVC ${JSON.stringify(name)} did not finish deleting within ${timeoutSeconds}s`
        );
    }

    protected bootstrapCommands(): string[] {
        const packages = ['mcp<2.0.0', 'uvicorn', 'fastapi', 'httpx', ...this.extraPip]
            .map(quotePosixShellArgument)
            .join(' ');
        const dependencies = K8S_SYSTEM_DEPS.map(quotePosixShellArgument).join(' ');
        return [
            `apt-get update -qq && apt-get install -y --no-install-recommends ${dependencies} ` +
                '&& rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh ' +
                '| env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh',
            `uv venv ${this.gatewayVenv}`,
            `uv pip install --python ${this.gatewayPython} ${packages}`,
            `uv pip install --python ${this.gatewayPython} --no-deps 'agentscope'`,
        ];
    }

    protected now(): number {
        return performance.now();
    }

    protected async sleep(milliseconds: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    private requireClient(): K8sClientDriver {
        if (!this.client) throw new Error('Kubernetes client is not initialized.');
        return this.client;
    }

    private raisePendingFailure(pod: K8sPod): void {
        const terminal = new Set([
            'ImagePullBackOff',
            'ErrImagePull',
            'InvalidImageName',
            'CrashLoopBackOff',
        ]);
        for (const status of pod.status?.containerStatuses ?? []) {
            const waiting = status.state?.waiting;
            const reason = waiting?.reason ?? '';
            if (terminal.has(reason)) {
                throw new Error(
                    `Pod ${JSON.stringify(this.podName)} container is stuck: ` +
                        `${waiting?.message || reason}`
                );
            }
        }
        for (const condition of pod.status?.conditions ?? []) {
            if (
                condition.type === 'PodScheduled' &&
                condition.status === 'False' &&
                condition.reason === 'Unschedulable'
            ) {
                throw new Error(
                    `Pod ${JSON.stringify(this.podName)} is unschedulable: ${condition.message}`
                );
            }
        }
    }
}

async function raceExecution(
    operation: Promise<ExecResult>,
    timeoutSeconds?: number,
    signal?: AbortSignal
): Promise<ExecResult> {
    if (signal?.aborted) {
        return new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') });
    }
    const promises = [operation];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    if (timeoutSeconds !== undefined) {
        promises.push(
            new Promise(resolve => {
                timer = setTimeout(
                    () =>
                        resolve(new ExecResult({ exitCode: -1, stderr: Buffer.from('timed out') })),
                    timeoutSeconds * 1000
                );
            })
        );
    }
    if (signal) {
        promises.push(
            new Promise(resolve => {
                abort = () =>
                    resolve(new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') }));
                signal.addEventListener('abort', abort, { once: true });
            })
        );
    }
    try {
        return await Promise.race(promises);
    } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener('abort', abort);
    }
}

function quotePosixShellArgument(value: string): string {
    if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
