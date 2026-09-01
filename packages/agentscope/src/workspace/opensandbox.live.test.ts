/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';

import { OPENSANDBOX_WORKDIR, OpenSandboxWorkspace } from './opensandbox';

const domain = process.env.OPENSANDBOX_DOMAIN ?? '';
const apiKey = process.env.OPENSANDBOX_API_KEY ?? '';
const describeLive = domain ? describe : describe.skip;

describeLive('OpenSandboxWorkspace live contract', () => {
    jest.setTimeout(1_200_000);

    test('executes commands and exposes binary-safe filesystem helpers', async () => {
        const workspace = liveWorkspace();
        try {
            await workspace.initialize();
            const backend = workspace.getBackend();
            await expect(backend.execShell(['echo', 'hello world'])).resolves.toMatchObject({
                exitCode: 0,
                stdout: Buffer.from('hello world\n'),
            });
            const filePath = `${OPENSANDBOX_WORKDIR}/nested/file.bin`;
            const content = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
            await backend.writeFile(filePath, content);
            await expect(backend.readFile(filePath)).resolves.toEqual(content);
            await expect(backend.fileExists(filePath)).resolves.toBe(true);
            await backend.deletePath(`${OPENSANDBOX_WORKDIR}/nested`);
            await expect(backend.fileExists(filePath)).resolves.toBe(false);
        } finally {
            await workspace.close();
        }
    });

    test('pauses and resumes the same metadata-linked sandbox with persisted files', async () => {
        const workspace = liveWorkspace();
        try {
            await workspace.initialize();
            const firstId = workspace.sandboxId;
            const filePath = `${OPENSANDBOX_WORKDIR}/data/persisted.txt`;
            await workspace.getBackend().writeFile(filePath, Buffer.from('persisted'));
            await workspace.close();

            await workspace.initialize();
            expect(workspace.sandboxId).toBe(firstId);
            await expect(workspace.getBackend().readFile(filePath)).resolves.toEqual(
                Buffer.from('persisted')
            );
        } finally {
            await workspace.close();
        }
    });
});

function liveWorkspace(): OpenSandboxWorkspace {
    return new OpenSandboxWorkspace({
        workspaceId: `test-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        domain,
        apiKey,
    });
}
