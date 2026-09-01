import type { Session } from '@shared/types/chat';
import { useState, useEffect, useCallback } from 'react';

const PAGE_SIZE = 20;

/**
 * A custom hook for managing chat sessions and their operations.
 *
 * @returns An object containing chat session data and management functions.
 */
export function useChat() {
    const [pinnedSessions, setPinnedSessions] = useState<Session[]>([]);
    const [unpinnedSessions, setUnpinnedSessions] = useState<Session[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [offset, setOffset] = useState(0);

    const loadSessions = useCallback(async (currentOffset: number) => {
        setLoading(true);
        try {
            const result = await window.api.chat.getSessions({
                offset: currentOffset,
                limit: PAGE_SIZE,
            });

            if (currentOffset === 0) {
                setPinnedSessions(result.pinned);
                setUnpinnedSessions(result.items);
                setOffset(result.items.length);
            } else {
                setUnpinnedSessions(prev => [...prev, ...result.items]);
                setOffset(prev => prev + result.items.length);
            }

            setHasMore(result.hasMore);
        } catch (error) {
            console.error('Failed to load sessions:', error);
        } finally {
            setLoading(false);
        }
    }, []);

    const refresh = useCallback(() => {
        loadSessions(0);
    }, [loadSessions]);

    const loadMore = useCallback(() => {
        if (!loading && hasMore) {
            loadSessions(offset);
        }
    }, [loading, hasMore, offset, loadSessions]);

    const createSession = useCallback(async (agentKey = 'friday', name?: string) => {
        try {
            const newSession = await window.api.chat.createSession(agentKey, name);
            // Optimistic update: add new session to the top of the list
            setUnpinnedSessions(prev => [newSession, ...prev]);
            return newSession;
        } catch (error) {
            console.error('Failed to create session:', error);
            throw error;
        }
    }, []);

    const renameSession = useCallback(async (id: string, name: string) => {
        try {
            await window.api.chat.renameSession(id, name);
            // Optimistic update: directly modify frontend data
            const updateName = (sessions: Session[]) =>
                sessions.map(s => (s.id === id ? { ...s, name } : s));
            setPinnedSessions(updateName);
            setUnpinnedSessions(updateName);
        } catch (error) {
            console.error('Failed to rename session:', error);
            throw error;
        }
    }, []);

    const pinSession = useCallback(
        async (id: string) => {
            try {
                // Find the session
                const allSessions = [...pinnedSessions, ...unpinnedSessions];
                const session = allSessions.find(s => s.id === id);
                if (!session) return;

                const newPinnedState = !session.pinned;
                await window.api.chat.pinSession(id, newPinnedState);

                // Optimistic update: move between two lists
                if (newPinnedState) {
                    // Pin: move from unpinned to pinned
                    setUnpinnedSessions(prev => prev.filter(s => s.id !== id));
                    setPinnedSessions(prev => [...prev, { ...session, pinned: true }]);
                } else {
                    // Unpin: move from pinned to unpinned
                    setPinnedSessions(prev => prev.filter(s => s.id !== id));
                    setUnpinnedSessions(prev => [{ ...session, pinned: false }, ...prev]);
                }
            } catch (error) {
                console.error('Failed to pin session:', error);
                throw error;
            }
        },
        [pinnedSessions, unpinnedSessions]
    );

    const deleteSession = useCallback(async (id: string) => {
        try {
            await window.api.chat.deleteSession(id);
            // Optimistic update: directly remove from frontend list
            setPinnedSessions(prev => prev.filter(s => s.id !== id));
            setUnpinnedSessions(prev => prev.filter(s => s.id !== id));
        } catch (error) {
            console.error('Failed to delete session:', error);
            throw error;
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    return {
        pinnedSessions,
        unpinnedSessions,
        allSessions: [...pinnedSessions, ...unpinnedSessions],
        hasMore,
        loading,
        loadMore,
        refresh,
        createSession,
        renameSession,
        pinSession,
        deleteSession,
    };
}
