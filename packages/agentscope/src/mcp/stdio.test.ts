import * as fs from 'fs';
import * as path from 'path';

import { StdioMCPClient } from './stdio';
import { Toolkit } from '../tool';

// Skip these tests on Windows due to npx/npm cache issues with MCP server packages
const describeUnlessWindows = process.platform === 'win32' ? describe.skip : describe;

describeUnlessWindows('StdIOMCPClient', () => {
    const testDir = path.join(__dirname, 'test-data');
    const testFilePath = path.join(testDir, 'test-file.txt');
    const testContent = 'Hello, this is a test file for MCP filesystem server!';

    beforeAll(() => {
        // Create test directory and file
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }
        fs.writeFileSync(testFilePath, testContent, 'utf-8');
    });

    afterAll(() => {
        // Clean up test directory and all its contents
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test('Create StdIOMCPClient, list and execute tools', async () => {
        const client = new StdioMCPClient({
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', testDir],
        });

        await client.connect();

        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);

        const tool = await client.getCallableFunction({ name: 'read_file' });
        const res = await tool.call({ path: testFilePath });
        expect(res.content.length).toBeGreaterThan(0);
        expect(res.content[0].type).toBe('text');
        if (res.content[0].type === 'text') {
            expect(res.content[0].text).toContain(testContent);
        }

        await client.close();

        await client.connect();
        const tools2 = await client.listTools();
        expect(tools2.length).toBeGreaterThan(0);
        await client.close();
    }, 20000);

    test('Test toolkit works with StdioMCPClient', async () => {
        const client = new StdioMCPClient({
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', testDir],
        });
        await client.connect();

        const toolkit = new Toolkit();
        await toolkit.registerMCPClient({ client: client, enabledTools: ['read_file'] });

        const schema = toolkit.getJSONSchemas();
        expect(schema.length).toBe(2);
        expect(schema[1].type).toBe('function');
        expect(schema[1].function.name).toBe('read_file');
        expect(schema[1].function.parameters).toBeDefined();

        const res = toolkit.callToolFunction({
            id: '123',
            name: 'read_file',
            type: 'tool_call',
            input: `{"path": "${testFilePath}"}`,
        });
        for await (const item of res) {
            expect(item.content.length).toBeGreaterThan(0);
            expect(item.content[0].type).toBe('text');
            if (item.content[0].type === 'text') {
                expect(item.content[0].text).toContain(testContent);
            }
        }

        await client.close();
    }, 30000);
});
