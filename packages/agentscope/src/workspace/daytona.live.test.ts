import { MCPClient, StdioMCPConfig } from '../mcp';
import { DAYTONA_WORKSPACE_ID_METADATA_KEY, DaytonaBackend, DaytonaWorkspace } from './daytona';

const describeDaytona = process.env.DAYTONA_API_KEY ? describe : describe.skip;

jest.setTimeout(20 * 60 * 1000);

describeDaytona('DaytonaWorkspace live contract', () => {
    const workspaceId = `live-${Date.now()}`;
    let workspace: DaytonaWorkspace;

    beforeAll(async () => {
        workspace = new DaytonaWorkspace({
            workspaceId,
            apiKey: process.env.DAYTONA_API_KEY,
            apiUrl: process.env.DAYTONA_API_URL,
            target: process.env.DAYTONA_TARGET,
        });
        await workspace.initialize();
    });

    afterAll(async () => {
        await workspace?.close();
        await deleteLiveWorkspace(workspaceId);
    });

    test('executes builtin tools and round-trips binary files', async () => {
        const backend = workspace.getBackend();
        expect(backend).toBeInstanceOf(DaytonaBackend);
        await expect(backend.execShell(['echo', 'hello daytona'])).resolves.toEqual(
            expect.objectContaining({ exitCode: 0, stdout: Buffer.from('hello daytona\n') })
        );
        const payload = Buffer.from([0, 1, 2, 255]);
        const filePath = `${workspace.workdir}/file.bin`;
        await backend.writeFile(filePath, payload);
        await expect(backend.readFile(filePath)).resolves.toEqual(payload);
        expect((await workspace.listTools()).map(tool => tool.name)).toEqual([
            'Bash',
            'Edit',
            'Glob',
            'Grep',
            'Read',
            'Write',
        ]);
    });

    test('registers and isolates a real stdio MCP through the gateway', async () => {
        const serverPath = `${workspace.workdir}/echo_mcp.py`;
        await workspace.getBackend().writeFile(serverPath, Buffer.from(ECHO_SERVER));
        await workspace.addMcp(
            new MCPClient({
                name: 'echo',
                isStateful: true,
                mcpConfig: new StdioMCPConfig({
                    command: (workspace as unknown as { gatewayPython: string }).gatewayPython,
                    args: [serverPath],
                }),
            }),
            { agentId: 'agent', sessionId: 'session' }
        );
        const clients = await workspace.listMcps({ agentId: 'agent', sessionId: 'session' });
        const tool = await clients[0].getTool('echo');
        expect(await tool.call({ message: 'hello' })).toEqual(
            expect.objectContaining({ state: 'success' })
        );
        expect(await workspace.listMcps({ agentId: 'agent', sessionId: 'other' })).toEqual([]);
    });
});

/**
 * Remove live Daytona resources created by this suite.
 * @param workspaceId Workspace label value to delete.
 */
async function deleteLiveWorkspace(workspaceId: string): Promise<void> {
    const moduleName = '@daytona/sdk';
    const { Daytona } = (await import(moduleName)) as {
        Daytona: new (options?: Record<string, string>) => {
            list(options: { labels: Record<string, string> }): AsyncIterable<{
                stop(timeout: number, force: boolean): Promise<void>;
                delete(timeout: number, wait: boolean): Promise<void>;
            }>;
            [Symbol.asyncDispose](): Promise<void>;
        };
    };
    const options = {
        ...(process.env.DAYTONA_API_KEY ? { apiKey: process.env.DAYTONA_API_KEY } : {}),
        ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
        ...(process.env.DAYTONA_TARGET ? { target: process.env.DAYTONA_TARGET } : {}),
    };
    const client = new Daytona(options);
    try {
        for await (const sandbox of client.list({
            labels: { [DAYTONA_WORKSPACE_ID_METADATA_KEY]: workspaceId },
        })) {
            await sandbox.stop(60, true).catch(() => undefined);
            await sandbox.delete(60, true);
        }
    } finally {
        await client[Symbol.asyncDispose]();
    }
}

const ECHO_SERVER = `from mcp.server.fastmcp import FastMCP
mcp = FastMCP("EchoServer")
@mcp.tool()
def echo(message: str) -> str:
    return f"ECHO: {message}"
if __name__ == "__main__":
    mcp.run(transport="stdio")
`;
