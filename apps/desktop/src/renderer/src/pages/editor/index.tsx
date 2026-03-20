import { Editor, rootCtx, defaultValueCtx } from '@milkdown/kit/core';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { indent } from '@milkdown/kit/plugin/indent';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { automd } from '@milkdown/plugin-automd';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { replaceAll } from '@milkdown/utils';
import '@milkdown/crepe/theme/frame.css';
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
import '@milkdown/crepe/theme/common/toolbar.css';
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
    onChange?: (markdown: string) => void;
}

export const MilkdownEditor: FC<Props> = ({ value, onChange }) => {
    const onChangeRef = useRef(onChange);
    const editorRef = useRef<Editor | null>(null);
    const prevExternalValue = useRef(value);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEditor(root => {
        const editor = Editor.make()
            // 挂载编辑器的 DOM 根节点
            .config(ctx => ctx.set(rootCtx, root))
            // 设置初始 markdown 内容（受控模式下只用于首次渲染）
            .config(ctx => ctx.set(defaultValueCtx, value ?? ''))
            // 监听 markdown 变化，实现受控模式的 onChange 回调
            .config(ctx => {
                ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
                    if (markdown !== prevMarkdown) {
                        prevExternalValue.current = markdown;
                        onChangeRef.current?.(markdown);
                    }
                });
            })
            // commonmark：基础 markdown 语法支持（标题、粗体、斜体、列表、代码块等）
            .use(commonmark)
            // gfm：GitHub Flavored Markdown 扩展（表格、任务列表、删除线等）
            .use(gfm)
            // listener：提供 markdownUpdated 等事件监听能力，受控模式必须
            .use(listener)
            // history：撤销/重做支持（Ctrl+Z / Ctrl+Shift+Z）
            .use(history)
            // indent：Tab 键缩进支持，可配置缩进类型（space/tab）和大小
            .use(indent)
            // trailing：确保文档末尾始终有一个空段落，方便光标定位
            .use(trailing)
            // clipboard：处理复制粘贴，支持从外部粘贴 markdown/html 内容
            .use(clipboard)
            .use(automd);

        editorRef.current = editor;
        return editor;
    }, []);

    // 受控模式：外部 value 变化时，用 replaceAll 同步到编辑器
    useEffect(() => {
        if (value === undefined || value === prevExternalValue.current) return;
        prevExternalValue.current = value;
        editorRef.current?.action(replaceAll(value));
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
        saveContent,
        currentDocumentId,
        setCurrentDocumentId,
        messages,
        sending,
        sendMessage,
        sendUserConfirm,
    } = useDocuments();

    const blocker = useBlocker(sending);

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
            <Dialog open={blocker.state === 'blocked'}>
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
                        <Button variant="destructive" onClick={() => blocker.proceed?.()}>
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
                    onItemClick={doc => setCurrentDocumentId(doc.id)}
                    onCreateClick={() => createDocument()}
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
            <div className="flex flex-rowbg-white h-full overflow-y-auto flex-1 border-r">
                <MilkdownProvider>
                    <MilkdownEditor
                        value={content}
                        onChange={async content => {
                            try {
                                if (currentDocumentId) {
                                    await saveContent(currentDocumentId, content);
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
                    />
                </MilkdownProvider>
            </div>
            <div className="flex flex-0.5 max-w-xl h-full overflow-hidden">
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
