import {
    EventType,
    type AgentEvent,
    UserConfirmResultEvent,
    ExternalExecutionResultEvent,
} from '@agentscope-ai/agentscope/event';
import { ContentBlock, createMsg, ToolCallBlock } from '@agentscope-ai/agentscope/message';
import type { Document } from '@shared/types/document';
import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';

import { applyAgentEvent, type StreamingMsg } from './agent-event-handler';
import { executeDocumentRead, executeDocumentEdit } from '@/pages/editor/frontend-tool';

const TYPEWRITER_INTERVAL = 50; // ms per tick
const TYPEWRITER_CHARS_PER_TICK = 10; // characters revealed per tick

const BACKSLASH_PLACEHOLDER = '\u{E000}BACKSLASH\u{E000}';

/**
 * Unescape a JSON string value (the raw text captured between quotes in partial JSON).
 * Handles \\, \n, \r, \t, \", \/ and \uXXXX sequences.
 * @param raw - The raw escaped string from JSON (without the surrounding quotes)
 * @returns The unescaped string with actual characters
 */
function unescapeJsonString(raw: string): string {
    return raw
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\//g, '/')
        .replace(new RegExp(BACKSLASH_PLACEHOLDER, 'g'), '\\');
}

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
    const [content, setContentInternal] = useState('');
    const [isDirty, setIsDirty] = useState(false);

    // ── Agent state ───────────────────────────────────────────────────────────
    const [messages, setMessages] = useState<StreamingMsg[]>([]);
    const [sending, setSending] = useState(false);

    // Keep a ref to content so the useEffect closure always reads the latest value
    const contentRef = useRef(content);
    useEffect(() => {
        contentRef.current = content;
    }, [content]);

    // ── Typewriter effect refs ────────────────────────────────────────────────
    const targetContentRef = useRef<string>('');
    const displayedLengthRef = useRef<number>(0);
    const typewriterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // Accumulates raw delta strings for each in-flight tool call input
    const toolCallInputsRef = useRef<Map<string, string>>(new Map());

    /**
     * setContent: reveals newContent gradually via a typewriter timer.
     * External callers use this for agent-streamed writes.
     */
    const setContent = useCallback((newContent: string) => {
        targetContentRef.current = newContent;
        if (!typewriterTimerRef.current) {
            displayedLengthRef.current = contentRef.current.length;
            typewriterTimerRef.current = setInterval(() => {
                const target = targetContentRef.current;
                const displayed = displayedLengthRef.current;
                if (displayed < target.length) {
                    const nextLength = Math.min(
                        displayed + TYPEWRITER_CHARS_PER_TICK,
                        target.length
                    );
                    displayedLengthRef.current = nextLength;
                    const partial = target.slice(0, nextLength);
                    setContentInternal(partial);
                    contentRef.current = partial;
                } else {
                    clearInterval(typewriterTimerRef.current!);
                    typewriterTimerRef.current = null;
                }
            }, TYPEWRITER_INTERVAL);
        }
    }, []);

    /**
     * setContentImmediate: sets content instantly, skipping the typewriter effect.
     * Use for initial document load, user edits, and tool results that need exact state.
     */
    const setContentImmediate = useCallback((newContent: string) => {
        if (typewriterTimerRef.current) {
            clearInterval(typewriterTimerRef.current);
            typewriterTimerRef.current = null;
        }
        targetContentRef.current = newContent;
        displayedLengthRef.current = newContent.length;
        setContentInternal(newContent);
        contentRef.current = newContent;
    }, []);

    // ── Select document: load content + messages ──────────────────────────────
    useEffect(() => {
        // Cancel any in-progress typewriter and clear accumulated tool call inputs
        if (typewriterTimerRef.current) {
            clearInterval(typewriterTimerRef.current);
            typewriterTimerRef.current = null;
        }
        toolCallInputsRef.current.clear();

        setMessages([]);
        setSending(false);
        setIsDirty(false);

        let unsubscribe: (() => void) | undefined;
        if (currentDocumentId) {
            // Load document content and messages when a new document is selected
            window.api.editor.getContent(currentDocumentId).then(docContent => {
                setContentImmediate(docContent);
            });
            window.api.editor.getMessages(currentDocumentId).then(msgs => setMessages(msgs));
            window.api.editor.isRunning(currentDocumentId).then(running => setSending(running));

            // Subscribe to agent events for the current document
            unsubscribe = window.api.editor.subscribeAgentEvents(
                currentDocumentId,
                async (event: AgentEvent) => {
                    // Intercept TOOL_CALL_DELTA to stream DocumentWrite content via typewriter
                    if (event.type === EventType.TOOL_CALL_DELTA) {
                        const prev = toolCallInputsRef.current.get(event.toolCallId) ?? '';
                        const accumulated = prev + event.delta;
                        toolCallInputsRef.current.set(event.toolCallId, accumulated);

                        // Extract the partial value of the "content" field from incomplete JSON
                        const match = /"content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(accumulated);
                        if (match) {
                            const extractedContent = unescapeJsonString(match[1]);
                            setContent(extractedContent);
                        }

                        applyAgentEvent(event, setMessages, setSending);
                        return;
                    }

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
                            case 'DocumentWrite': {
                                // Content was already streamed via typewriter — flush any remaining characters instantly
                                toolCallInputsRef.current.delete(toolCall.id);
                                setContentImmediate(input.content ?? '');
                                const lineCount = (input.content ?? '').split('\n').length;
                                return {
                                    type: 'tool_result' as const,
                                    id: toolCall.id,
                                    name: toolCall.name,
                                    output: [
                                        {
                                            id: crypto.randomUUID(),
                                            type: 'text' as const,
                                            text: `The document has been written successfully (${lineCount} lines).`,
                                        },
                                    ],
                                    state: 'success' as const,
                                };
                            }
                            case 'DocumentEdit':
                                return executeDocumentEdit(toolCall.id, setContentInternal, input);
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
                }
            );
        }

        // Cleanup typewriter timer when document changes or component unmounts
        return () => {
            if (typewriterTimerRef.current) {
                clearInterval(typewriterTimerRef.current);
                typewriterTimerRef.current = null;
            }
            if (unsubscribe) {
                unsubscribe();
            }
        };
    }, [currentDocumentId, setContent, setContentImmediate]);

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

    // ── Dirty tracking ────────────────────────────────────────────────────────
    const updateContent = (markdown: string) => {
        setContentImmediate(markdown);
        setIsDirty(true);
    };

    // ── Content save ──────────────────────────────────────────────────────────
    const saveContent = async (docId: string, markdown: string) => {
        await window.api.editor.saveContent(docId, markdown);
        setIsDirty(false);
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
        updateContent,
        saveContent,
        isDirty,
        setCurrentDocumentId,
        messages,
        sending,
        sendMessage,
        sendUserConfirm,
    };
}
