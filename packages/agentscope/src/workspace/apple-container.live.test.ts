import { MCPClient, StdioMCPConfig } from '../mcp';
import { AppleContainerBackend, AppleContainerWorkspace } from './apple-container';

const live = process.env.APPLE_CONTAINER_LIVE === '1' && process.platform === 'darwin';
const describeAppleContainer = live ? describe : describe.skip;

jest.setTimeout(20 * 60 * 1000);

describeAppleContainer('AppleContainerWorkspace live contract', () => {
    test('bootstraps, executes tools, and round-trips files', async () => {
        const workspace = new AppleContainerWorkspace();
        await workspace.initialize();
        try {
            const backend = workspace.getBackend();
            expect(backend).toBeInstanceOf(AppleContainerBackend);
            for (const command of [
                ['rg', '--version'],
                ['uv', '--version'],
                ['python3', '--version'],
            ]) {
                expect((await backend.execShell(command)).ok()).toBe(true);
            }
            const payload = Buffer.from([0, 1, 2, 255]);
            await backend.writeFile('/workspace/file.bin', payload);
            expect(await backend.readFile('/workspace/file.bin')).toEqual(payload);
            expect((await workspace.listTools()).map(tool => tool.name)).toEqual([
                'Bash',
                'Edit',
                'Glob',
                'Grep',
                'Read',
                'Write',
            ]);
        } finally {
            await workspace.close();
        }
    });

    test('registers and isolates a real stdio MCP through the gateway', async () => {
        const workspace = new AppleContainerWorkspace();
        await workspace.initialize();
        try {
            const serverPath = '/tmp/echo_mcp.py';
            await workspace.getBackend().writeFile(serverPath, Buffer.from(ECHO_SERVER));
            await workspace.addMcp(
                new MCPClient({
                    name: 'echo',
                    isStateful: true,
                    mcpConfig: new StdioMCPConfig({
                        command: '/root/.agentscope/.venv/bin/python',
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
        } finally {
            await workspace.close();
        }
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
