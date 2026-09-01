import { HubBase } from '../base';
import type { MCPCard, MCPHubPage } from './card';

/** Base contract for MCP catalog providers. */
export abstract class MCPHubBase extends HubBase {
    abstract listMCPs(
        userId: string,
        query?: string | null,
        cursor?: string | null,
        limit?: number
    ): Promise<MCPHubPage>;

    abstract getMCP(userId: string, cardId: string): Promise<MCPCard>;
}
