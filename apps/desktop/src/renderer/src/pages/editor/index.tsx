import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { listenerCtx } from '@milkdown/kit/plugin/listener';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { replaceAll } from '@milkdown/utils';
import './frame.css';
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/common/table.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/image-block.css';
import '@milkdown/crepe/theme/common/latex.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/prosemirror.css';
import './toolbar.css';
import './slash-menu.css';
import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { FC, useState, useRef, useEffect, CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router-dom';
import { toast } from 'sonner';

import { ChatContent } from '@/components/chat/ChatContent';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useTitlebar } from '@/contexts/LayoutContext';
import { useDocuments } from '@/hooks/use-documents';
import { EditorSidebar } from '@/pages/editor/editor-sidebar';

interface Props {
    value?: string;
    readonly?: boolean;
    placeholder?: string;
    onChange?: (markdown: string) => void;
}

export const MilkdownEditor: FC<Props> = ({ value, readonly, placeholder, onChange }) => {
    const onChangeRef = useRef(onChange);
    const crepeRef = useRef<Crepe | null>(null);
    const prevExternalValue = useRef(value);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        if (crepeRef.current) {
            crepeRef.current.setReadonly(readonly ?? false);
        }
    }, [readonly]);

    useEditor(root => {
        const crepe = new Crepe({
            root,
            defaultValue: value ?? '',
            featureConfigs: {
                [CrepeFeature.ImageBlock]: {
                    proxyDomURL: (url: string) => url,
                },
                [CrepeFeature.Placeholder]: {
                    text: placeholder ?? 'Please enter...',
                },
            },
        });
        crepe.setReadonly(readonly ?? false);
        crepe.editor.config(ctx => {
            ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
                if (markdown !== prevMarkdown) {
                    prevExternalValue.current = markdown;
                    onChangeRef.current?.(markdown);
                }
            });
        });
        crepeRef.current = crepe;
        return crepe;
    }, []);

    useEffect(() => {
        if (value === undefined || value === prevExternalValue.current) return;
        prevExternalValue.current = value;
        crepeRef.current?.editor.action(replaceAll(value));
    }, [value]);

    return <Milkdown />;
};

/**
 * The main editor page component.
 * @returns A React element representing the editor page, including the sidebar, markdown editor, and chat content.
 */
export function EditorPage() {
    const { t } = useTranslation();
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const { setTitlebarContent } = useTitlebar();

    const {
        documents,
        loading,
        createDocument,
        renameDocument,
        pinDocument,
        deleteDocument,
        content,
        updateContent,
        saveContent,
        isDirty,
        currentDocumentId,
        setCurrentDocumentId,
        messages,
        sending,
        sendMessage,
        sendUserConfirm,
    } = useDocuments();

    // Pending navigation action when agent is running and user tries to switch/create
    const [pendingNavAction, setPendingNavAction] = useState<(() => void) | null>(null);

    const blocker = useBlocker(sending || isDirty);

    // Auto-save and proceed when blocked only due to unsaved changes (agent not running)
    useEffect(() => {
        if (blocker.state === 'blocked' && !sending) {
            const proceed = async () => {
                if (currentDocumentId && isDirty) {
                    await saveContent(currentDocumentId, content);
                }
                blocker.proceed?.();
            };
            proceed();
        }
    }, [blocker, sending, currentDocumentId, isDirty, saveContent, content]);

    // Save on Ctrl+S / Cmd+S
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (currentDocumentId && isDirty) {
                    saveContent(currentDocumentId, content)
                        .then(() => {
                            // TODO: Move this to the app statusbar once it supports transient messages
                            toast.success('Document saved', { position: 'top-center' });
                        })
                        .catch(err => {
                            toast.error(`Failed to save: ${err}`, { position: 'top-center' });
                        });
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentDocumentId, content, isDirty, saveContent]);

    // Save before switching documents
    const prevDocumentId = useRef(currentDocumentId);
    useEffect(() => {
        const prev = prevDocumentId.current;
        if (prev && prev !== currentDocumentId && isDirty) {
            saveContent(prev, content).catch(err => {
                console.error('Failed to save on document switch:', err);
            });
        }
        prevDocumentId.current = currentDocumentId;
    }, [currentDocumentId, content, isDirty, saveContent]);

    // Set title bar button to close the sidebar
    useEffect(() => {
        setTitlebarContent(
            <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSidebarOpen(prev => !prev)}
                style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            >
                {sidebarOpen ? (
                    <PanelLeftClose className="size-4" />
                ) : (
                    <PanelLeft className="size-4" />
                )}
            </Button>
        );
        return () => setTitlebarContent(null);
    }, [sidebarOpen, setTitlebarContent]);

    return (
        <div className="flex h-full w-full">
            <Dialog open={blocker.state === 'blocked' && sending}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {t('editor.leaveWhileRunning.title', 'Agent is still running')}
                        </DialogTitle>
                        <DialogDescription>
                            {t(
                                'editor.leaveWhileRunning.description',
                                'The agent is currently processing your document. If you leave now, any pending tool calls will be deferred until you return to this document.'
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => blocker.reset?.()}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={async () => {
                                if (currentDocumentId && isDirty) {
                                    await saveContent(currentDocumentId, content);
                                }
                                blocker.proceed?.();
                            }}
                        >
                            {t('editor.leaveWhileRunning.confirm', 'Leave anyway')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={pendingNavAction !== null}
                onOpenChange={open => {
                    if (!open) setPendingNavAction(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {t('editor.leaveWhileRunning.title', 'Agent is still running')}
                        </DialogTitle>
                        <DialogDescription>
                            {t(
                                'editor.leaveWhileRunning.description',
                                'The agent is currently processing your document. If you leave now, any pending tool calls will be deferred until you return to this document.'
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPendingNavAction(null)}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={async () => {
                                if (currentDocumentId && isDirty) {
                                    await saveContent(currentDocumentId, content);
                                }
                                pendingNavAction?.();
                                setPendingNavAction(null);
                            }}
                        >
                            {t('editor.leaveWhileRunning.confirm', 'Leave anyway')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {sidebarOpen && (
                <EditorSidebar
                    items={documents}
                    loading={loading}
                    selectedItemId={currentDocumentId}
                    onItemClick={doc => {
                        if (sending) {
                            setPendingNavAction(() => () => setCurrentDocumentId(doc.id));
                        } else {
                            setCurrentDocumentId(doc.id);
                        }
                    }}
                    onCreateClick={() => {
                        if (sending) {
                            setPendingNavAction(() => () => createDocument());
                        } else {
                            createDocument();
                        }
                    }}
                    onPinClick={pinDocument}
                    onRenameClick={renameDocument}
                    onDeleteClick={deleteDocument}
                    locale={{
                        createButton: t('editor.createDocument'),
                        itemsTitle: t('editor.documents'),
                        loadMore: t('common.loadMore'),
                        renameTitle: t('common.rename'),
                        renameDescription: t('editor.renameDescription'),
                        deleteTitle: t('common.delete'),
                        deleteDescription: t('editor.deleteConfirm'),
                    }}
                />
            )}
            <div className="flex bg-white h-full overflow-y-auto overflow-x-hidden flex-1 min-w-0 border-r">
                <MilkdownProvider>
                    <MilkdownEditor
                        value={content}
                        readonly={sending}
                        placeholder={t('editor.placeholder', 'Please enter...')}
                        onChange={newContent => {
                            if (currentDocumentId) {
                                updateContent(newContent);
                            } else {
                                toast.error(
                                    `No documents exists, please create or select a document first`,
                                    { position: 'top-center' }
                                );
                            }
                        }}
                    />
                </MilkdownProvider>
            </div>
            <div className="flex flex-0.5 max-w-xl w-xl min-w-xl h-full overflow-hidden">
                <ChatContent
                    msgs={messages}
                    sending={sending}
                    onSend={async content => {
                        try {
                            if (currentDocumentId) {
                                await sendMessage(currentDocumentId, content);
                            } else {
                                toast.error(
                                    `No documents exists, please create or select a document first`,
                                    {
                                        position: 'top-center',
                                    }
                                );
                            }
                        } catch (e) {
                            toast.error(String(e), {
                                position: 'top-center',
                            });
                        }
                    }}
                    onUserConfirm={async (toolCall, confirm, replyId) => {
                        if (currentDocumentId) {
                            await sendUserConfirm(currentDocumentId, toolCall, confirm, replyId);
                        } else {
                            toast.error(
                                `No documents exists, please create or select a document first`,
                                {
                                    position: 'top-center',
                                }
                            );
                        }
                    }}
                />
            </div>
        </div>
    );
}
