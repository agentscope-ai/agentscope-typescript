/* eslint-disable jsdoc/require-jsdoc */

import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import { createK8sClientFromSdk } from './k8s-driver';

describe('official Kubernetes SDK driver', () => {
    beforeEach(() => {
        FakeKubeConfig.instances.length = 0;
        FakeExec.instances.length = 0;
    });

    test('loads explicit kubeconfig and maps object-parameter CoreV1 calls', async () => {
        const client = createK8sClientFromSdk(fakeSdk(), '/tmp/config');
        const config = FakeKubeConfig.instances[0];

        await expect(client.readNamespace('agentscope')).resolves.toEqual({ kind: 'Namespace' });
        await client.createNamespace({ metadata: { name: 'agentscope' } });
        await expect(client.readPersistentVolumeClaim('pvc', 'ns')).resolves.toEqual({
            kind: 'PersistentVolumeClaim',
        });
        await client.createPersistentVolumeClaim('ns', { kind: 'PersistentVolumeClaim' });
        await client.deletePersistentVolumeClaim('pvc', 'ns');
        await expect(client.readPod('pod', 'ns')).resolves.toEqual({ kind: 'Pod' });
        await client.createPod('ns', { kind: 'Pod' });
        await client.deletePod('pod', 'ns');
        await client.close();

        expect(config.loads).toEqual([['file', '/tmp/config']]);
        expect(config.core.calls).toEqual([
            ['readNamespace', { name: 'agentscope' }],
            ['createNamespace', { body: { metadata: { name: 'agentscope' } } }],
            ['readPvc', { name: 'pvc', namespace: 'ns' }],
            ['createPvc', { namespace: 'ns', body: { kind: 'PersistentVolumeClaim' } }],
            ['deletePvc', { name: 'pvc', namespace: 'ns' }],
            ['readPod', { name: 'pod', namespace: 'ns' }],
            ['createPod', { namespace: 'ns', body: { kind: 'Pod' } }],
            ['deletePod', { name: 'pod', namespace: 'ns' }],
        ]);
    });

    test('prefers in-cluster config and falls back to the default kubeconfig', () => {
        createK8sClientFromSdk(fakeSdk());
        expect(FakeKubeConfig.instances[0].loads).toEqual([['cluster']]);

        FakeKubeConfig.throwCluster = true;
        createK8sClientFromSdk(fakeSdk());
        expect(FakeKubeConfig.instances[1].loads).toEqual([['cluster'], ['default']]);
        FakeKubeConfig.throwCluster = false;
    });

    test('collects binary streams, forwards stdin, and parses the exit status', async () => {
        const client = createK8sClientFromSdk(fakeSdk());
        const executor = FakeExec.instances[0];
        executor.status = { status: 'Failure', details: { causes: [{ message: '7' }] } };
        executor.stdout = Buffer.from([0, 1, 255]);
        executor.stderr = Buffer.from('bad');

        async function* input(): AsyncGenerator<Buffer> {
            yield Buffer.from([2, 3]);
            yield Buffer.from([4]);
        }

        await expect(
            client.exec({
                namespace: 'ns',
                podName: 'pod',
                containerName: 'workspace',
                command: ['cat'],
                stdin: input(),
            })
        ).resolves.toEqual({
            exitCode: 7,
            stdout: Buffer.from([0, 1, 255]),
            stderr: Buffer.from('bad'),
        });
        expect(executor.calls).toEqual([
            {
                namespace: 'ns',
                podName: 'pod',
                containerName: 'workspace',
                command: ['cat'],
                tty: false,
            },
        ]);
        expect(executor.stdin).toEqual(Buffer.from([2, 3, 4]));
    });

    test('maps successful and malformed failure statuses', async () => {
        const client = createK8sClientFromSdk(fakeSdk());
        const executor = FakeExec.instances[0];
        executor.status = { status: 'Success' };
        await expect(execTrue(client)).resolves.toMatchObject({ exitCode: 0 });
        executor.status = { status: 'Failure', details: { causes: [{ message: 'oops' }] } };
        await expect(execTrue(client)).resolves.toMatchObject({ exitCode: 1 });
    });
});

function fakeSdk(): Parameters<typeof createK8sClientFromSdk>[0] {
    return {
        KubeConfig: FakeKubeConfig,
        CoreV1Api: class {},
        Exec: FakeExec,
    };
}

async function execTrue(client: ReturnType<typeof createK8sClientFromSdk>) {
    return client.exec({
        namespace: 'ns',
        podName: 'pod',
        containerName: 'workspace',
        command: ['true'],
    });
}

class FakeKubeConfig {
    static readonly instances: FakeKubeConfig[] = [];
    static throwCluster = false;
    readonly loads: string[][] = [];
    readonly core = new FakeCore();

    constructor() {
        FakeKubeConfig.instances.push(this);
    }

    loadFromFile(filePath: string): void {
        this.loads.push(['file', filePath]);
    }

    loadFromCluster(): void {
        this.loads.push(['cluster']);
        if (FakeKubeConfig.throwCluster) throw new Error('not in cluster');
    }

    loadFromDefault(): void {
        this.loads.push(['default']);
    }

    makeApiClient(): FakeCore {
        return this.core;
    }
}

class FakeCore {
    readonly calls: Array<[string, Record<string, unknown>]> = [];

    async readNamespace(input: Record<string, unknown>) {
        this.calls.push(['readNamespace', input]);
        return { body: { kind: 'Namespace' } };
    }

    async createNamespace(input: Record<string, unknown>) {
        this.calls.push(['createNamespace', input]);
    }

    async readNamespacedPersistentVolumeClaim(input: Record<string, unknown>) {
        this.calls.push(['readPvc', input]);
        return { kind: 'PersistentVolumeClaim' };
    }

    async createNamespacedPersistentVolumeClaim(input: Record<string, unknown>) {
        this.calls.push(['createPvc', input]);
    }

    async deleteNamespacedPersistentVolumeClaim(input: Record<string, unknown>) {
        this.calls.push(['deletePvc', input]);
    }

    async readNamespacedPod(input: Record<string, unknown>) {
        this.calls.push(['readPod', input]);
        return { kind: 'Pod' };
    }

    async createNamespacedPod(input: Record<string, unknown>) {
        this.calls.push(['createPod', input]);
    }

    async deleteNamespacedPod(input: Record<string, unknown>) {
        this.calls.push(['deletePod', input]);
    }
}

class FakeExec {
    static readonly instances: FakeExec[] = [];
    readonly calls: Array<Record<string, unknown>> = [];
    status: Record<string, unknown> = { status: 'Success' };
    stdout = Buffer.alloc(0);
    stderr = Buffer.alloc(0);
    stdin = Buffer.alloc(0);

    constructor() {
        FakeExec.instances.push(this);
    }

    async exec(
        namespace: string,
        podName: string,
        containerName: string,
        command: string[],
        stdout: Writable,
        stderr: Writable,
        stdin: Readable | null,
        tty: boolean,
        statusCallback: (status: Record<string, unknown>) => void
    ): Promise<EventEmitter & { readyState: number }> {
        this.calls.push({ namespace, podName, containerName, command, tty });
        const socket = Object.assign(new EventEmitter(), { readyState: 1 });
        queueMicrotask(async () => {
            const chunks: Buffer[] = [];
            if (stdin) {
                for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
            }
            this.stdin = Buffer.concat(chunks);
            stdout.write(this.stdout);
            stderr.write(this.stderr);
            statusCallback(this.status);
            socket.readyState = 3;
            socket.emit('close');
        });
        return socket;
    }
}
