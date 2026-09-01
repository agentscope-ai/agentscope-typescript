/* eslint-disable jsdoc/require-jsdoc */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { K8S_GATEWAY_HOME, K8S_POD_WORKDIR, K8sWorkspace } from './k8s';

const image = process.env.K8S_TEST_IMAGE ?? '';
const namespace = process.env.K8S_TEST_NAMESPACE ?? 'agentscope';
const kubectlAvailable =
    process.platform === 'linux' &&
    spawnSync('kubectl', ['version', '--client'], { stdio: 'ignore' }).status === 0;
const describeLive = image && kubectlAvailable ? describe : describe.skip;

describeLive('K8sWorkspace live contract', () => {
    jest.setTimeout(300_000);

    test('initializes a real Pod and exposes binary-safe backend operations', async () => {
        const workspace = liveWorkspace();
        try {
            await workspace.initialize();
            const backend = workspace.getBackend();
            await expect(workspace.getInstructions()).resolves.toContain(K8S_POD_WORKDIR);
            await expect(backend.execShell(['echo', 'hello'])).resolves.toMatchObject({
                exitCode: 0,
                stdout: Buffer.from('hello\n'),
            });
            const filePath = `${K8S_POD_WORKDIR}/data/live.bin`;
            const content = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
            await backend.writeFile(filePath, content);
            await expect(backend.readFile(filePath)).resolves.toEqual(content);
        } finally {
            await workspace.close();
            await workspace.close();
        }
    });

    test('reset clears workspace state without removing gateway artifacts', async () => {
        const workspace = liveWorkspace();
        try {
            await workspace.initialize();
            const backend = workspace.getBackend();
            await backend.writeFile(
                `${K8S_POD_WORKDIR}/sessions/session/context.jsonl`,
                Buffer.from('{"message":"hello"}\n')
            );
            await workspace.reset();
            await expect(backend.fileExists(`${K8S_POD_WORKDIR}/sessions`)).resolves.toBe(false);
            await expect(
                backend.fileExists(`${K8S_GATEWAY_HOME}/_mcp_gateway_app.py`)
            ).resolves.toBe(true);
        } finally {
            await workspace.close();
        }
    });
});

function liveWorkspace(): K8sWorkspace {
    return new K8sWorkspace({
        workspaceId: `test-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
        image,
        imagePullPolicy: 'Never',
        namespace,
        storageSize: '100Mi',
        deletePvcOnClose: true,
    });
}
