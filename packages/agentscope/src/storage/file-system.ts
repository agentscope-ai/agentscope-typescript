import fs from 'fs';
import path from 'path';

import * as mime from 'mime-types';

import { Msg } from '../message';
import { AgentState, StorageBase } from './base';

/**
 * Local file system storage implementation.
 * Stores agent state in JSON files with support for incremental context updates.
 */
export class LocalFileStorage extends StorageBase {
    saveDir: string;
    offloadDir?: string;

    /**
     * Internal metadata key prefix for storage-layer fields.
     * Fields with this prefix are managed by storage and filtered out when returning to agent layer.
     */
    private readonly INTERNAL_PREFIX = '_storage_';

    /**
     * Initialize a LocalFileStorage instance.
     * @param root0
     * @param root0.pathSegments - Path segments to determine the directory for saving agent state (e.g. ['rootDir', '{sessionId}'])
     * @param root0.offloadPathSegments - Optional path segments for offloading compressed context for agentic search (e.g. ['rootDir', 'offload'])
     */
    constructor({
        pathSegments = [],
        offloadPathSegments = [],
    }: {
        pathSegments?: string[];
        offloadPathSegments?: string[];
    }) {
        super();
        this.saveDir = path.join(...pathSegments);
        this.offloadDir =
            offloadPathSegments.length > 0 ? path.join(...offloadPathSegments) : undefined;
    }

    /**
     * Load the complete agent state including context and metadata.
     * @param options
     * @param options.agentId - The agent identifier
     * @returns The agent state with context and metadata (internal fields filtered out)
     */
    async loadAgentState(options?: { agentId?: string }): Promise<AgentState> {
        const agentDir = path.join(this.saveDir, options?.agentId || '');

        // If the agent directory doesn't exist, return empty state
        if (!fs.existsSync(agentDir)) {
            console.log(`Agent directory ${agentDir} does not exist. Returning empty state.`);
            return {
                context: [],
                metadata: {},
            };
        }
        console.log(`Loading agent state from directory: ${agentDir}`);

        const contextFile = path.join(agentDir, 'context.jsonl');
        const stateFile = path.join(agentDir, 'state.json');

        // Load metadata
        let metadata: Record<string, unknown> = {};
        if (fs.existsSync(stateFile)) {
            const content = fs.readFileSync(stateFile, 'utf-8');
            metadata = JSON.parse(content);
        }

        // Extract internal compression boundary ID
        const compressionBoundaryMsgId = metadata[
            `${this.INTERNAL_PREFIX}compressionBoundaryMsgId`
        ] as string | undefined;

        // Load context (incrementally if compression boundary exists)
        let context: Msg[] = [];
        if (fs.existsSync(contextFile)) {
            const content = fs.readFileSync(contextFile, 'utf-8');
            const allMsgs = content
                .trim()
                .split('\n')
                .filter(line => line.length > 0)
                .map(line => JSON.parse(line));

            if (compressionBoundaryMsgId) {
                // Load only messages after the compression boundary
                const boundaryIndex = allMsgs.findIndex(msg => msg.id === compressionBoundaryMsgId);
                if (boundaryIndex !== -1) {
                    // Include the boundary message itself
                    context = allMsgs.slice(boundaryIndex);
                } else {
                    // Boundary not found, load all messages
                    context = allMsgs;
                }
            } else {
                // No compression, load all messages
                context = allMsgs;
            }
        }

        // Filter out internal fields from metadata before returning
        const publicMetadata = this._filterInternalFields(metadata);

        return {
            context,
            metadata: publicMetadata,
        };
    }

    /**
     * Save the complete agent state including context and metadata.
     * @param options
     * @param options.agentId - The agent identifier
     * @param options.context - The conversation context to save
     * @param options.metadata - The agent metadata to save
     */
    async saveAgentState(options: {
        agentId?: string;
        context: Msg[];
        metadata: Record<string, unknown>;
    }): Promise<void> {
        const agentDir = path.join(this.saveDir, options.agentId || '');
        const contextFile = path.join(agentDir, 'context.jsonl');
        const stateFile = path.join(agentDir, 'state.json');

        // Ensure directory exists
        if (!fs.existsSync(agentDir)) {
            fs.mkdirSync(agentDir, { recursive: true });
        }

        // Determine compression boundary (first message in current context)
        const compressionBoundaryMsgId = options.context[0]?.id;

        // Save context with incremental append optimization
        if (!fs.existsSync(contextFile)) {
            // First time: write all messages
            const content = options.context.map(msg => JSON.stringify(msg)).join('\n');
            if (content) {
                fs.writeFileSync(contextFile, content + '\n', 'utf-8');
            }
        } else {
            // File exists: append only new messages
            const existingContent = fs.readFileSync(contextFile, 'utf-8');
            const existingLines = existingContent
                .trim()
                .split('\n')
                .filter(line => line.length > 0);

            if (existingLines.length > 0) {
                const lastLine = existingLines[existingLines.length - 1];
                const lastMsg = JSON.parse(lastLine);

                // Find new messages that need to be saved (including the last saved message to overwrite it)
                const lastMsgIndex = options.context.findIndex(msg => msg.id === lastMsg.id);
                const newMsgs =
                    lastMsgIndex >= 0 ? options.context.slice(lastMsgIndex) : options.context;

                if (newMsgs.length > 0) {
                    // Combine existing messages (without last line) with new messages
                    const allLines = [
                        ...existingLines.slice(0, -1),
                        ...newMsgs.map(msg => JSON.stringify(msg)),
                    ];
                    const content = allLines.join('\n') + '\n';
                    fs.writeFileSync(contextFile, content, 'utf-8');
                }
            } else {
                // File is empty, write all messages
                const content = options.context.map(msg => JSON.stringify(msg)).join('\n');
                if (content) {
                    fs.writeFileSync(contextFile, content + '\n', 'utf-8');
                }
            }
        }

        // Save metadata with internal compression boundary
        const internalMetadata = {
            ...options.metadata,
            [`${this.INTERNAL_PREFIX}compressionBoundaryMsgId`]: compressionBoundaryMsgId,
        };
        fs.writeFileSync(stateFile, JSON.stringify(internalMetadata, null, 2), 'utf-8');
    }

    /**
     * Filter out internal storage fields from metadata.
     * @param metadata - The metadata object
     * @returns Metadata with internal fields removed
     */
    private _filterInternalFields(metadata: Record<string, unknown>): Record<string, unknown> {
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(metadata)) {
            if (!key.startsWith(this.INTERNAL_PREFIX)) {
                filtered[key] = value;
            }
        }
        return filtered;
    }

    /**
     * Offload the compressed context to external storage for agentic search if needed.
     * @param options
     * @param options.agentId - The agent identifier
     * @param options.msgs - The messages to offload
     * @returns The file path of the offloaded context, or undefined if offloading is not implemented or not needed
     */
    async offloadContext(options: { agentId?: string; msgs: Msg[] }): Promise<string | undefined> {
        if (!this.offloadDir) {
            return;
        }

        // Offload the compressed context to the text file
        // e.g. 2026-03-01.txt
        const fileName = `${new Date().toISOString().split('T')[0]}.txt`;
        const offloadFile = path.join(this.offloadDir, options.agentId || '', fileName);
        const offloadDataDir = path.join(this.offloadDir, options.agentId || '', 'data');

        // Create the dir if it doesn't exist
        const offloadAgentDir = path.dirname(offloadFile);
        if (!fs.existsSync(offloadAgentDir)) {
            fs.mkdirSync(offloadAgentDir, { recursive: true });
        }

        // Append the new context to the offload file
        let appendContent = '';
        for (const msg of options.msgs) {
            const msgContent: string[] = [];
            for (const block of msg.content) {
                switch (block.type) {
                    case 'text':
                        msgContent.push(`${msg.name}: ${block.text}`);
                        break;
                    case 'data':
                        if (block.source.type === 'url') {
                            msgContent.push(
                                `${msg.name}: <data src={${block.source.url}} type={${block.source.mediaType}} />`
                            );
                        } else if (block.source.type === 'base64') {
                            // Save the base64 data to a file and add a reference to the file in the offload content
                            const mainType = block.source.mediaType.split('/')[0];
                            const extension = mime.extension(block.source.mediaType) || 'bin';
                            const filePath = path.join(
                                offloadDataDir,
                                `${mainType}-${Date.now()}.${extension}`
                            );
                            if (!fs.existsSync(offloadDataDir)) {
                                fs.mkdirSync(offloadDataDir, { recursive: true });
                            }
                            const buffer = Buffer.from(block.source.data, 'base64');
                            fs.writeFileSync(filePath, buffer);
                            msgContent.push(
                                `${msg.name}: <data src={${filePath}} type={${block.source.mediaType}} />`
                            );
                        }
                        break;
                    case 'tool_call':
                        msgContent.push(`${msg.name}: Calling tool ${block.name} ...`);
                        break;
                }
            }
            appendContent += msgContent.join('\n') + '\n';
        }

        // Append to the offload file
        fs.appendFileSync(offloadFile, appendContent, 'utf-8');

        return offloadFile;
    }
}
