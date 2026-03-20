import {
    EventType,
    type AgentEvent,
    UserConfirmResultEvent,
    ExternalExecutionResultEvent,
} from '@agentscope-ai/agentscope/event';
import { ContentBlock, createMsg, ToolCallBlock } from '@agentscope-ai/agentscope/message';
import type { Document } from '@shared/types/document';
import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { applyAgentEvent, type StreamingMsg } from './agent-event-handler';
import {
    executeDocumentRead,
    executeDocumentWrite,
    executeDocumentEdit,
} from '@/pages/editor/frontend-tool';

/**
 * The documents hook manages the state and operations related to co-edited Markdown documents.
 * @returns An object containing the list of documents, current document content, agent messages, and functions to manipulate them.
 */
export function useDocuments() {
    // ── Document list ─────────────────────────────────────────────────────────
    const [documents, setDocuments] = useState<Document[]>([]);
    const [loading, setLoading] = useState<boolean>(false);

    // ── Current document ──────────────────────────────────────────────────────
    const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
    const [content, setContent] = useState('');

    // ── Agent state ───────────────────────────────────────────────────────────
    const [messages, setMessages] = useState<StreamingMsg[]>([]);
    const [sending, setSending] = useState(false);

    // Keep a ref to content so the useEffect closure always reads the latest value
    const contentRef = useRef(content);
    useEffect(() => {
        contentRef.current = content;
    }, [content]);

    // ── Select document: load content + messages ──────────────────────────────
    useEffect(() => {
        setMessages([]);
        setSending(false);
        if (currentDocumentId) {
            // Load document content and messages when a new document is selected
            window.api.editor
                .getContent(currentDocumentId)
                .then(docContent => setContent(docContent));
            window.api.editor.getMessages(currentDocumentId).then(msgs => setMessages(msgs));
            window.api.editor.isRunning(currentDocumentId).then(running => setSending(running));

            // Subscribe to agent events for the current document
            window.api.editor.subscribeAgentEvents(currentDocumentId, async (event: AgentEvent) => {
                if (event.type !== EventType.REQUIRE_EXTERNAL_EXECUTION) {
                    applyAgentEvent(event, setMessages, setSending);
                    return;
                }
                // Handle the REQUIRE_EXTERNAL_EXECUTION event by executing the requested tools and sending back the results
                const results = event.toolCalls.map(toolCall => {
                    const input = JSON.parse(toolCall.input || '{}');
                    switch (toolCall.name) {
                        case 'DocumentRead':
                            return executeDocumentRead(toolCall.id, contentRef.current, input);
                        case 'DocumentWrite':
                            return executeDocumentWrite(toolCall.id, setContent, input);
                        case 'DocumentEdit':
                            return executeDocumentEdit(toolCall.id, setContent, input);
                        default:
                            return {
                                type: 'tool_result' as const,
                                id: toolCall.id,
                                name: toolCall.name,
                                output: [
                                    {
                                        id: crypto.randomUUID(),
                                        type: 'text' as const,
                                        text: `Unknown tool: ${toolCall.name}`,
                                    },
                                ],
                                state: 'error' as const,
                            };
                    }
                });
                await window.api.editor.sendMessage(currentDocumentId, 'friday', undefined, {
                    type: EventType.EXTERNAL_EXECUTION_RESULT,
                    id: crypto.randomUUID(),
                    createdAt: new Date().toISOString(),
                    replyId: event.replyId,
                    executionResults: results,
                } as ExternalExecutionResultEvent);
            });
        }
    }, [currentDocumentId]);

    // ── Initialize: load list then select latest (or create one) ─────────────
    useEffect(() => {
        setLoading(true);
        try {
            window.api.editor
                .getDocuments()
                .then(result => {
                    if (result.length > 0) {
                        setDocuments(result);
                        setCurrentDocumentId(result[0].id);
                    } else {
                        // No documents, create a default document
                        window.api.editor.createDocument().then(newDoc => {
                            setDocuments([newDoc]);
                            setCurrentDocumentId(newDoc.id);
                        });
                    }
                })
                .finally(() => setLoading(false));
        } catch (e) {
            toast.error(String(e));
        }
    }, []);

    // ── Document CRUD ─────────────────────────────────────────────────────────
    const createDocument = async () => {
        const newDoc = await window.api.editor.createDocument();
        setDocuments(prev => [newDoc, ...prev]);
        setCurrentDocumentId(newDoc.id);
    };

    const renameDocument = async (id: string, name: string) => {
        await window.api.editor.renameDocument(id, name);
        setDocuments(prev => prev.map(d => (d.id === id ? { ...d, name } : d)));
    };

    const pinDocument = async (id: string) => {
        await window.api.editor.pinDocument(id);
        setDocuments(prev => {
            const updated = prev.map(d => {
                if (d.id === id) {
                    return { ...d, pinned: !d.pinned };
                }
                return d;
            });
            return [...updated];
        });
    };

    const deleteDocument = async (id: string) => {
        await window.api.editor.deleteDocument(id);
        setDocuments(prev => {
            const remaining = prev.filter(d => d.id !== id);
            setCurrentDocumentId(currId => {
                if (currId === id) {
                    return remaining.length > 0 ? remaining[0].id : null;
                }
                return currId;
            });
            return remaining;
        });
    };

    // ── Content save ──────────────────────────────────────────────────────────
    const saveContent = async (docId: string, markdown: string) => {
        await window.api.editor.saveContent(docId, markdown);
        setContent(markdown);
    };

    // ── Agent messaging ───────────────────────────────────────────────────────
    const sendMessage = async (docId: string, msgContent: ContentBlock[]) => {
        if (!docId || msgContent.length === 0) return;
        setSending(true);
        const message = createMsg({
            id: crypto.randomUUID(),
            role: 'user',
            name: 'user',
            content: msgContent,
        });
        setMessages(prev => [...prev, message]);
        await window.api.editor.sendMessage(docId, 'friday', message);
    };

    const sendUserConfirm = async (
        docId: string,
        toolCall: ToolCallBlock,
        confirm: boolean,
        replyId: string
    ) => {
        await window.api.editor.sendMessage(docId, 'friday', undefined, {
            type: EventType.USER_CONFIRM_RESULT,
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            replyId,
            confirmResults: [{ confirmed: confirm, toolCall }],
        } as UserConfirmResultEvent);
    };

    return {
        documents,
        loading,
        createDocument,
        renameDocument,
        pinDocument,
        deleteDocument,
        currentDocumentId,
        content,
        saveContent,
        setCurrentDocumentId,
        messages,
        sending,
        sendMessage,
        sendUserConfirm,
    };
}
