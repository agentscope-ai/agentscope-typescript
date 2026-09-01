import { MCPClient, StdioMCPConfig } from '../mcp';
import { E2BBackend, E2BWorkspace } from './e2b';

const describeE2B = process.env.E2B_API_KEY ? describe : describe.skip;

jest.setTimeout(20 * 60 * 1000);

describeE2B('E2BWorkspace live contract', () => {
    let workspace: E2BWorkspace;

    beforeAll(async () => {
        workspace = new E2BWorkspace({ workspaceId: `live-${Date.now()}` });
        await workspace.initialize();
    });

    afterAll(async () => {
        await workspace?.close();
    });

    test('executes tools and round-trips binary files', async () => {
        const backend = workspace.getBackend();
        expect(backend).toBeInstanceOf(E2BBackend);
        await expect(backend.execShell(['echo', 'hello world'])).resolves.toEqual(
            expect.objectContaining({ exitCode: 0, stdout: Buffer.from('hello world\n') })
        );
        const payload = Buffer.from([0, 1, 2, 255]);
        await backend.writeFile('/home/user/workspace/file.bin', payload);
        await expect(backend.readFile('/home/user/workspace/file.bin')).resolves.toEqual(payload);
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
        const serverPath = '/home/user/workspace/echo_mcp.py';
        await workspace.getBackend().writeFile(serverPath, Buffer.from(ECHO_SERVER));
        await workspace.addMcp(
            new MCPClient({
                name: 'echo',
                isStateful: true,
                mcpConfig: new StdioMCPConfig({
                    command: '/home/user/.agentscope/.venv/bin/python',
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

const ECHO_SERVER = `from mcp.server.fastmcp import FastMCP
mcp = FastMCP("EchoServer")
@mcp.tool()
def echo(message: str) -> str:
    return f"ECHO: {message}"
if __name__ == "__main__":
    mcp.run(transport="stdio")
`;
