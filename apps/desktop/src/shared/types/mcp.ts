export type MCPServerStatus = 'disconnected' | 'connected' | 'error';

interface MCPServerConfigBase {
    id: string;
    name: string;
    createdAt: number;
}

export interface SSEMCPServerConfig extends MCPServerConfigBase {
    protocol: 'sse';
    url: string;
    timeout?: number;
}

export interface HTTPMCPServerConfig extends MCPServerConfigBase {
    protocol: 'streamable-http';
    url: string;
    timeout?: number;
}

export interface StdioMCPServerConfig extends MCPServerConfigBase {
    protocol: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export type MCPServerConfig = SSEMCPServerConfig | HTTPMCPServerConfig | StdioMCPServerConfig;
export type MCPServerCreateConfig =
    | Omit<SSEMCPServerConfig, 'id' | 'createdAt'>
    | Omit<HTTPMCPServerConfig, 'id' | 'createdAt'>
    | Omit<StdioMCPServerConfig, 'id' | 'createdAt'>;

export interface MCPServerState {
    config: MCPServerConfig;
    status: MCPServerStatus;
    error?: string;
    tools?: string[];
}
