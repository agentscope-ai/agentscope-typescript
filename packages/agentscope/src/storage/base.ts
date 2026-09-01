import type { Msg } from '../message/message';

/**
 * The complete agent state including both conversation context and metadata.
 */
export interface AgentState {
    /**
     * The conversation context (message history).
     */
    context: Msg[];
    /**
     * Agent metadata (replyId, curIter, curSummary, etc.).
     */
    metadata: Record<string, unknown>;
}

/**
 * The base storage class that responsible for
 * - loading/saving agent context and state, and
 * - offloading compressed context to external storage for agentic search if needed
 */
export abstract class StorageBase {
    /**
     * Load the complete agent state including context and metadata.
     * @param options.agentId - The agent identifier
     * @returns The agent state with context and metadata
     */
    abstract loadAgentState(options?: { agentId?: string }): Promise<AgentState>;

    /**
     * Save the complete agent state including context and metadata.
     * @param options.agentId - The agent identifier
     * @param options.context - The conversation context to save
     * @param options.metadata - The agent metadata to save
     */
    abstract saveAgentState(options: {
        agentId?: string;
        context: Msg[];
        metadata: Record<string, unknown>;
    }): Promise<void>;

    /**
     * Offload the compressed context to external storage for agentic search if needed.
     * @param _options.msgs
     * @param _options
     * @returns The identifier or URL of the offloaded context, or undefined if offloading is not implemented or not needed
     */
    async offloadContext(_options: { msgs: Msg[] }): Promise<string | undefined> {
        console.log('Offloading context is not implemented for this storage. Skipping offloading.');
        return undefined;
    }
}
