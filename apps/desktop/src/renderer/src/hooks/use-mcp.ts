import type { MCPServerCreateConfig, MCPServerState } from '@shared/types/mcp';
import { useState, useEffect, useCallback } from 'react';

/**
 * A custom hook for managing MCP servers and their connections.
 *
 * @returns An object containing MCP server data and management functions.
 */
export function useMcp() {
    const [servers, setServers] = useState<MCPServerState[]>([]);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        const data = await window.api.mcp.getAll();
        setServers(data);
    }, []);

    useEffect(() => {
        refresh().finally(() => setLoading(false));
    }, [refresh]);

    const add = useCallback(async (config: MCPServerCreateConfig) => {
        const state = await window.api.mcp.add(config);
        setServers(prev => [...prev, state]);
        return state;
    }, []);

    const remove = useCallback(async (id: string) => {
        await window.api.mcp.remove(id);
        setServers(prev => prev.filter(s => s.config.id !== id));
    }, []);

    const connect = useCallback(async (id: string) => {
        const state = await window.api.mcp.connect(id);
        setServers(prev => prev.map(s => (s.config.id === id ? state : s)));
        return state;
    }, []);

    const disconnect = useCallback(async (id: string) => {
        const state = await window.api.mcp.disconnect(id);
        setServers(prev => prev.map(s => (s.config.id === id ? state : s)));
        return state;
    }, []);

    return { servers, loading, refresh, add, remove, connect, disconnect };
}
