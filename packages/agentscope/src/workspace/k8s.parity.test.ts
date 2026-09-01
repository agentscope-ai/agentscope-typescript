/* eslint-disable jsdoc/require-jsdoc */

import { ExecResult } from '../tool';
import {
    DEFAULT_K8S_GATEWAY_PORT,
    DEFAULT_K8S_IMAGE,
    K8S_GATEWAY_HOME,
    K8S_POD_WORKDIR,
    K8sBackend,
    K8sWorkspace,
    type K8sWorkspaceOptions,
    k8sSafeName,
} from './k8s';
import type {
    K8sClientDriver,
    K8sExecOutput,
    K8sExecRequest,
    K8sPersistentVolumeClaim,
    K8sPod,
} from './k8s-driver';
import { createSingleFileTar } from './tar-buffer';

describe('K8sBackend Python parity', () => {
    test('wraps argv with an injection-safe cwd and preserves multiplexed output', async () => {
        const client = new FakeK8sClient();
        client.outputs.push({
            exitCode: 3,
            stdout: Buffer.from('out'),
            stderr: Buffer.from('err'),
        });
        const backend = backendFor(client);

        await expect(backend.execShell(['echo', 'a b'], { cwd: "/tmp/it's" })).resolves.toEqual(
            new ExecResult({ exitCode: 3, stdout: Buffer.from('out'), stderr: Buffer.from('err') })
        );
        await expect(backend.getCwd()).resolves.toBe(K8S_POD_WORKDIR);
        expect(client.execCalls).toEqual([
            {
                namespace: 'agentscope',
                podName: 'pod',
                containerName: 'workspace',
                command: ['sh', '-c', `cd '/tmp/it'"'"'s' && exec "$@"`, '--', 'echo', 'a b'],
            },
        ]);
    });

    test('returns timeout and abort sentinels', async () => {
        const client = new FakeK8sClient();
        client.hang = true;
        const backend = backendFor(client);
        await expect(backend.execShell(['sleep'], { timeout: 0.001 })).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('timed out') })
        );

        const controller = new AbortController();
        controller.abort();
        await expect(backend.execShell(['sleep'], { signal: controller.signal })).resolves.toEqual(
            new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') })
        );
        expect(client.execCalls).toHaveLength(1);
    });

    test('reads tar archives and maps command or archive failures to not-found', async () => {
        const client = new FakeK8sClient();
        client.outputs.push({
            exitCode: 0,
            stdout: createSingleFileTar('file.bin', Buffer.from([0, 1, 255])),
            stderr: Buffer.alloc(0),
        });
        const backend = backendFor(client);
        await expect(backend.readFile('/workspace/data/file.bin')).resolves.toEqual(
            Buffer.from([0, 1, 255])
        );
        expect(client.execCalls[0]?.command).toEqual([
            'sh',
            '-c',
            'cd / && exec "$@"',
            '--',
            'tar',
            'cf',
            '-',
            '-C',
            '/workspace/data',
            'file.bin',
        ]);

        client.outputs.push({
            exitCode: 2,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('tar: No such file'),
        });
        await expect(backend.readFile('/missing')).rejects.toThrow(
            'not found in Pod: /missing (tar stderr: tar: No such file)'
        );
        client.outputs.push({
            exitCode: 0,
            stdout: Buffer.from('not tar'),
            stderr: Buffer.alloc(0),
        });
        await expect(backend.readFile('/invalid')).rejects.toThrow('not found in Pod: /invalid');
    });

    test('writes buffered and streamed bytes through stdin and reports tar failures', async () => {
        const client = new FakeK8sClient();
        const backend = backendFor(client);
        await backend.writeFile('/workspace/nested/file.bin', Buffer.from([1, 2, 3]));

        async function* chunks(): AsyncGenerator<Buffer> {
            yield Buffer.from([4, 5]);
            yield Buffer.from([6]);
        }
        await backend.writeStream('/workspace/stream.bin', chunks());

        expect(client.execCalls.map(call => call.command)).toEqual([
            ['sh', '-c', 'cd /workspace && exec "$@"', '--', 'mkdir', '-p', '/workspace/nested'],
            ['tar', 'xf', '-', '-C', '/workspace/nested'],
            ['sh', '-c', 'cd /workspace && exec "$@"', '--', 'mkdir', '-p', '/workspace'],
            ['sh', '-c', 'cat > "$1"', 'sh', '/workspace/stream.bin'],
        ]);
        expect(client.stdin[0]?.length).toBeGreaterThan(1024);
        expect(client.stdin[1]).toEqual(Buffer.from([4, 5, 6]));

        client.outputs.push(success(), {
            exitCode: 2,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('denied'),
        });
        await expect(backend.writeFile('/bad/file', Buffer.from('x'))).rejects.toThrow(
            'write to "/bad/file" failed: tar exited 2: denied'
        );
    });
});

describe('K8sWorkspace Python parity', () => {
    test('matches defaults, copies mutable config, renders instructions, and sanitizes names', async () => {
        const env = { A: 'B' };
        const secrets = ['pull'];
        const tolerations = [{ key: 'dedicated', operator: 'Exists' }];
        const workspace = new TestK8sWorkspace({
            workspaceId: 'My_ID.With@Unsafe---',
            env,
            imagePullSecrets: secrets,
            tolerations,
            instructions: '{backend} at {workdir}',
            client: new FakeK8sClient(),
        });
        env.A = 'changed';
        secrets.push('changed');
        tolerations[0].key = 'changed';

        expect({
            workdir: workspace.workdir,
            image: workspace.image,
            policy: workspace.imagePullPolicy,
            namespace: workspace.namespace,
            port: workspace.gatewayPort,
            storage: workspace.storageSize,
            deletePvc: workspace.deletePvcOnClose,
            env: workspace.env,
            secrets: workspace.imagePullSecrets,
            tolerations: workspace.tolerations,
            persistent: workspace.isPersistent,
        }).toEqual({
            workdir: K8S_POD_WORKDIR,
            image: DEFAULT_K8S_IMAGE,
            policy: 'IfNotPresent',
            namespace: 'agentscope',
            port: DEFAULT_K8S_GATEWAY_PORT,
            storage: '1Gi',
            deletePvc: false,
            env: { A: 'B' },
            secrets: ['pull'],
            tolerations: [{ key: 'dedicated', operator: 'Exists' }],
            persistent: true,
        });
        await expect(workspace.getInstructions()).resolves.toBe('Kubernetes-based at /workspace');
        expect(k8sSafeName('My_ID.With@Unsafe---')).toBe('as-ws-my-id-with-unsafe');
        expect(k8sSafeName('X'.repeat(100))).toHaveLength(63);
    });

    test('creates the namespace, PVC, and Pod with exact Python-equivalent specs', async () => {
        const client = new FakeK8sClient();
        client.namespaceExists = false;
        const workspace = new TestK8sWorkspace({
            workspaceId: 'Demo_ID',
            namespace: 'custom',
            image: 'example/image:v1',
            imagePullPolicy: 'Never',
            imagePullSecrets: ['registry'],
            resources: { requests: { cpu: '100m' }, limits: { memory: '1Gi' } },
            nodeSelector: { pool: 'agents' },
            tolerations: [{ key: 'agents', effect: 'NoSchedule' }],
            serviceAccount: 'runner',
            storageClass: 'fast',
            storageSize: '2Gi',
            env: { API_KEY: 'secret' },
            client,
        });

        await workspace.initialize();
        await workspace.initialize();

        expect(client.createdNamespaces).toEqual([
            { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'custom' } },
        ]);
        expect(client.createdPvcs).toEqual([
            {
                namespace: 'custom',
                body: {
                    apiVersion: 'v1',
                    kind: 'PersistentVolumeClaim',
                    metadata: {
                        name: 'as-ws-demo-id',
                        namespace: 'custom',
                        labels: {
                            'app.kubernetes.io/managed-by': 'agentscope',
                            'agentscope.workspace.id': 'Demo_ID',
                        },
                    },
                    spec: {
                        accessModes: ['ReadWriteOnce'],
                        resources: { requests: { storage: '2Gi' } },
                        storageClassName: 'fast',
                    },
                },
            },
        ]);
        expect(client.createdPods).toEqual([
            {
                namespace: 'custom',
                body: {
                    apiVersion: 'v1',
                    kind: 'Pod',
                    metadata: {
                        name: 'as-ws-demo-id',
                        namespace: 'custom',
                        labels: {
                            'app.kubernetes.io/managed-by': 'agentscope',
                            'agentscope.workspace': 'true',
                            'agentscope.workspace.id': 'Demo_ID',
                        },
                    },
                    spec: {
                        restartPolicy: 'OnFailure',
                        containers: [
                            {
                                name: 'workspace',
                                image: 'example/image:v1',
                                imagePullPolicy: 'Never',
                                command: ['sleep', 'infinity'],
                                workingDir: '/workspace',
                                ports: [{ containerPort: 5600 }],
                                volumeMounts: [{ name: 'workspace-data', mountPath: '/workspace' }],
                                resources: {
                                    requests: { cpu: '100m' },
                                    limits: { memory: '1Gi' },
                                },
                                env: [{ name: 'API_KEY', value: 'secret' }],
                            },
                        ],
                        volumes: [
                            {
                                name: 'workspace-data',
                                persistentVolumeClaim: { claimName: 'as-ws-demo-id' },
                            },
                        ],
                        nodeSelector: { pool: 'agents' },
                        tolerations: [{ key: 'agents', effect: 'NoSchedule' }],
                        serviceAccountName: 'runner',
                        imagePullSecrets: [{ name: 'registry' }],
                    },
                },
            },
        ]);
        expect(workspace.getBackend()).toBeInstanceOf(K8sBackend);
        expect(client.execCalls.at(-1)?.command).toEqual([
            'sh',
            '-c',
            'cd /workspace && exec "$@"',
            '--',
            'mkdir',
            '-p',
            '/workspace',
            '/workspace/data',
            '/workspace/skills',
            '/workspace/sessions',
            '/root/.agentscope',
        ]);
    });

    test('reuses Running and Pending Pods without destructive recreation', async () => {
        for (const phase of ['Running', 'Pending']) {
            const client = new FakeK8sClient();
            client.pvc = { metadata: {} };
            if (phase === 'Pending') {
                client.podReads.push(
                    { metadata: {}, status: { phase: 'Pending' } },
                    { metadata: {}, status: { phase: 'Running' } }
                );
            } else {
                client.pod = { metadata: {}, status: { phase } };
            }
            const workspace = new TestK8sWorkspace({ workspaceId: phase, client });
            await workspace.initialize();
            expect(client.createdPvcs).toEqual([]);
            expect(client.createdPods).toEqual([]);
            expect(client.deletedPods).toEqual([]);
        }
    });

    test('waits out deleting resources and recreates terminal or unexpected Pods', async () => {
        const client = new FakeK8sClient();
        const workspace = new TestK8sWorkspace({ workspaceId: 'replace', client });
        workspace.prepare();
        client.pvcReads.push({ metadata: { deletionTimestamp: '2026-01-01' } }, notFound());
        await workspace.ensurePvcForTest();
        expect(client.createdPvcs).toHaveLength(1);

        for (const phase of ['Failed', 'Unknown', 'Succeeded', 'Odd']) {
            client.podReads.push({ metadata: {}, status: { phase } }, notFound());
            await workspace.ensurePodForTest();
        }
        expect(client.deletedPods).toEqual([
            ['as-ws-replace', 'agentscope'],
            ['as-ws-replace', 'agentscope'],
            ['as-ws-replace', 'agentscope'],
            ['as-ws-replace', 'agentscope'],
        ]);
        expect(client.createdPods).toHaveLength(4);
    });

    test.each([
        [
            {
                status: {
                    phase: 'Pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: { reason: 'ImagePullBackOff', message: 'image missing' },
                            },
                        },
                    ],
                },
            },
            'container is stuck: image missing',
        ],
        [
            {
                status: {
                    phase: 'Pending',
                    conditions: [
                        {
                            type: 'PodScheduled',
                            status: 'False',
                            reason: 'Unschedulable',
                            message: 'no nodes',
                        },
                    ],
                },
            },
            'is unschedulable: no nodes',
        ],
        [{ status: { phase: 'Failed' } }, 'entered Failed state'],
        [{ status: { phase: 'Unknown' } }, 'entered Unknown state'],
    ])('fails early for terminal Pod state %#', async (pod, message) => {
        const client = new FakeK8sClient();
        client.podReads.push(pod);
        const workspace = new TestK8sWorkspace({ workspaceId: 'bad', client });
        workspace.prepare();
        await expect(workspace.waitRunningForTest()).rejects.toThrow(message);
    });

    test('uses exponential readiness polling and enforces all deletion deadlines', async () => {
        const client = new FakeK8sClient();
        client.podReads.push(
            { status: { phase: 'Pending' } },
            { status: { phase: 'Pending' } },
            { status: { phase: 'Running' } }
        );
        const workspace = new TestK8sWorkspace({ workspaceId: 'poll', client });
        workspace.prepare();
        await workspace.waitRunningForTest();
        expect(workspace.sleeps).toEqual([500, 750]);

        client.podReads.push({ status: { phase: 'Pending' } });
        await expect(workspace.waitRunningForTest(0.001)).rejects.toThrow(
            'did not become Running within 0.001s'
        );
        client.podReads.push({ status: { phase: 'Running' } });
        await expect(workspace.waitPodDeletedForTest(0.001)).rejects.toThrow(
            'did not finish deleting within 0.001s'
        );
        client.pvcReads.push({ metadata: {} });
        await expect(workspace.waitPvcDeletedForTest(0.001)).rejects.toThrow(
            'did not finish deleting within 0.001s'
        );
    });

    test('deletes Pod, optionally deletes PVC, closes the client, and is idempotent', async () => {
        const client = new FakeK8sClient();
        const workspace = new TestK8sWorkspace({
            workspaceId: 'close',
            deletePvcOnClose: true,
            client,
        });
        await workspace.initialize();
        client.deletePodError = new Error('pod delete failed');
        client.deletePvcError = new Error('pvc delete failed');
        client.closeError = new Error('close failed');

        await expect(workspace.close()).resolves.toBeUndefined();
        await expect(workspace.close()).resolves.toBeUndefined();

        expect(client.deletedPods).toEqual([['as-ws-close', 'agentscope']]);
        expect(client.deletedPvcs).toEqual([['as-ws-close', 'agentscope']]);
        expect(client.closeCalls).toBe(1);
        expect(workspace.isAlive).toBe(false);
    });

    test('matches the five bootstrap commands and quotes unsafe packages', () => {
        const client = new FakeK8sClient();
        const workspace = new TestK8sWorkspace({
            extraPip: ['normal', 'unsafe; echo injected'],
            client,
        });
        workspace.bindBackend();
        expect(workspace.bootstrapForTest()).toEqual([
            'apt-get update -qq && apt-get install -y --no-install-recommends ' +
                'curl ca-certificates ripgrep && rm -rf /var/lib/apt/lists/*',
            'curl -LsSf https://astral.sh/uv/install.sh ' +
                '| env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh',
            `uv venv ${K8S_GATEWAY_HOME}/.venv`,
            `uv pip install --python ${K8S_GATEWAY_HOME}/.venv/bin/python ` +
                `'mcp<2.0.0' uvicorn fastapi httpx normal 'unsafe; echo injected'`,
            `uv pip install --python ${K8S_GATEWAY_HOME}/.venv/bin/python ` +
                `--no-deps 'agentscope'`,
        ]);
    });
});

class TestK8sWorkspace extends K8sWorkspace {
    readonly sleeps: number[] = [];
    private clock = 0;

    constructor(options: K8sWorkspaceOptions) {
        super(options);
    }

    prepare(): void {
        this.podName = k8sSafeName(this.workspaceId);
    }

    bindBackend(): void {
        this.prepare();
        this.backend = backendFor(this.client!);
    }

    async ensurePvcForTest(): Promise<void> {
        await this.ensurePvc();
    }

    async ensurePodForTest(): Promise<void> {
        await this.ensurePod();
    }

    async waitRunningForTest(timeout = 120): Promise<void> {
        await this.waitPodRunning(timeout);
    }

    async waitPodDeletedForTest(timeout: number): Promise<void> {
        await this.waitPodDeleted(timeout);
    }

    async waitPvcDeletedForTest(timeout: number): Promise<void> {
        await this.waitPvcDeleted(this.podName, timeout);
    }

    bootstrapForTest(): string[] {
        return this.bootstrapCommands();
    }

    protected override now(): number {
        return this.clock;
    }

    protected override async sleep(milliseconds: number): Promise<void> {
        this.sleeps.push(milliseconds);
        this.clock += milliseconds;
    }

    protected override async setupMcpGateway(): Promise<void> {}
    protected override async migrateSkillLayout(): Promise<void> {}
    protected override async setupSkillSeeds(): Promise<void> {}
}

class FakeK8sClient implements K8sClientDriver {
    namespaceExists = true;
    pvc: K8sPersistentVolumeClaim | null = null;
    pod: K8sPod | null = null;
    readonly pvcReads: Array<K8sPersistentVolumeClaim | Error> = [];
    readonly podReads: Array<K8sPod | Error> = [];
    readonly createdNamespaces: Record<string, unknown>[] = [];
    readonly createdPvcs: Array<{ namespace: string; body: Record<string, unknown> }> = [];
    readonly createdPods: Array<{ namespace: string; body: Record<string, unknown> }> = [];
    readonly deletedPods: string[][] = [];
    readonly deletedPvcs: string[][] = [];
    readonly execCalls: K8sExecRequest[] = [];
    readonly stdin: Buffer[] = [];
    readonly outputs: K8sExecOutput[] = [];
    hang = false;
    deletePodError: Error | null = null;
    deletePvcError: Error | null = null;
    closeError: Error | null = null;
    closeCalls = 0;

    async readNamespace(): Promise<Record<string, unknown>> {
        if (!this.namespaceExists) throw notFound();
        return { metadata: { name: 'agentscope' } };
    }

    async createNamespace(body: Record<string, unknown>): Promise<void> {
        this.createdNamespaces.push(body);
        this.namespaceExists = true;
    }

    async readPersistentVolumeClaim(): Promise<K8sPersistentVolumeClaim> {
        const queued = this.pvcReads.shift();
        if (queued instanceof Error) throw queued;
        if (queued) return queued;
        if (!this.pvc) throw notFound();
        return this.pvc;
    }

    async createPersistentVolumeClaim(
        namespace: string,
        body: Record<string, unknown>
    ): Promise<void> {
        this.createdPvcs.push({ namespace, body });
        this.pvc = body;
    }

    async deletePersistentVolumeClaim(name: string, namespace: string): Promise<void> {
        this.deletedPvcs.push([name, namespace]);
        if (this.deletePvcError) throw this.deletePvcError;
        this.pvc = null;
    }

    async readPod(): Promise<K8sPod> {
        const queued = this.podReads.shift();
        if (queued instanceof Error) throw queued;
        if (queued) return queued;
        if (!this.pod) throw notFound();
        return this.pod;
    }

    async createPod(namespace: string, body: Record<string, unknown>): Promise<void> {
        this.createdPods.push({ namespace, body });
        this.pod = { ...body, status: { phase: 'Running' } };
    }

    async deletePod(name: string, namespace: string): Promise<void> {
        this.deletedPods.push([name, namespace]);
        if (this.deletePodError) throw this.deletePodError;
        this.pod = null;
    }

    async exec(request: K8sExecRequest): Promise<K8sExecOutput> {
        this.execCalls.push(request);
        if (request.stdin) this.stdin.push(await collect(request.stdin));
        if (this.hang) return new Promise(() => undefined);
        return this.outputs.shift() ?? success();
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
        if (this.closeError) throw this.closeError;
    }
}

function backendFor(client: K8sClientDriver): K8sBackend {
    return new K8sBackend({
        client,
        namespace: 'agentscope',
        podName: 'pod',
        containerName: 'workspace',
        workdir: K8S_POD_WORKDIR,
    });
}

async function collect(input: Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
    if (input instanceof Uint8Array) return Buffer.from(input);
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

function success(): K8sExecOutput {
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
}

function notFound(): Error {
    return Object.assign(new Error('not found'), { code: 404 });
}
