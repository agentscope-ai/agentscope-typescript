import type { BaseListItem } from '@shared/types/common';
import {
    ArrowDownToLine,
    ArrowUpToLine,
    CornerDownLeft,
    Ellipsis,
    Loader2,
    PencilLine,
    Trash2,
    AlertCircle,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
} from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';

interface EditorSidebarProps<T extends BaseListItem> {
    selectedItemId: string | null;
    items: T[];
    loading: boolean;
    onItemClick: (item: T) => void;
    onCreateClick: () => void;
    onPinClick: (id: string) => void;
    onRenameClick: (id: string, newName: string) => Promise<void>;
    onDeleteClick: (id: string) => Promise<void>;
    locale: {
        createButton: string;
        itemsTitle: string;
        loadMore: string;
        renameTitle: string;
        renameDescription: string;
        deleteTitle: string;
        deleteDescription: string;
    };
}

/**
 * A reusable sidebar component for displaying and managing a list of items.
 *
 * @param root0 - The component props.
 * @param root0.items - Array of items to display in the sidebar.
 * @param root0.selectedItemId
 * @param root0.loading - Whether items are currently being loaded.
 * @param root0.onItemClick - Callback when an item is clicked.
 * @param root0.onCreateClick - Callback when the create button is clicked.
 * @param root0.onPinClick - Callback when an item is pinned/unpinned.
 * @param root0.onRenameClick - Callback when an item is renamed.
 * @param root0.onDeleteClick - Callback when an item is deleted.
 * @param root0.locale - Localization strings for the sidebar.
 * @returns A EditorSidebar component.
 */
export function EditorSidebar<T extends BaseListItem>({
    items,
    selectedItemId,
    loading,
    onItemClick,
    onCreateClick,
    onPinClick,
    onRenameClick,
    onDeleteClick,
    locale,
}: EditorSidebarProps<T>) {
    const { t } = useTranslation();
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [renameValue, setRenameValue] = useState('');
    const [renameLoading, setRenameLoading] = useState(false);
    const [toDeleteItemId, setToDeleteItemId] = useState<string | null>(null);
    const [deleteLoading, setDeleteLoading] = useState(false);
    const [renameError, setRenameError] = useState<string | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const handleRenameClick = (item: T) => {
        setRenameValue(item.name);
        setRenameError(null);
        setRenameDialogOpen(true);
    };

    const handleRenameConfirm = async () => {
        if (!selectedItemId || !renameValue.trim()) return;
        // No change, close directly
        const selectedItem = items.find(it => it.id === selectedItemId);
        if (!selectedItem) return;
        if (renameValue.trim() === selectedItem.name) {
            setRenameDialogOpen(false);
            return;
        }

        setRenameLoading(true);
        setRenameError(null);

        try {
            await onRenameClick(selectedItemId, renameValue.trim());
            setRenameDialogOpen(false);
            setRenameValue('');
        } catch (error) {
            setRenameError(error instanceof Error ? error.message : 'Failed to rename');
        } finally {
            setRenameLoading(false);
        }
    };

    const handleDeleteClick = (item: T) => {
        setToDeleteItemId(item.id);
        setDeleteError(null);
        setDeleteDialogOpen(true);
    };

    const handleDeleteConfirm = async () => {
        if (!toDeleteItemId) return;

        setDeleteLoading(true);
        setDeleteError(null);

        try {
            await onDeleteClick(toDeleteItemId);
            setDeleteDialogOpen(false);
        } catch (error) {
            setDeleteError(error instanceof Error ? error.message : 'Failed to delete');
        } finally {
            setDeleteLoading(false);
        }
    };

    return (
        <>
            <Sidebar collapsible="none" className="w-64">
                <SidebarHeader className="my-2">
                    <Button size="sm" variant="default" onClick={onCreateClick}>
                        {locale.createButton}
                    </Button>
                </SidebarHeader>
                <SidebarContent className="flex flex-col flex-1">
                    <SidebarGroup className="flex flex-col flex-1 overflow-hidden">
                        <SidebarGroupLabel>{locale.itemsTitle}</SidebarGroupLabel>
                        <SidebarGroupContent className="flex-1 overflow-hidden">
                            <div className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                                {loading ? (
                                    <div className="size-full">
                                        <Spinner />
                                    </div>
                                ) : (
                                    items.map(item => (
                                        <Button
                                            key={item.id}
                                            variant={
                                                item.id === selectedItemId ? 'secondary' : 'ghost'
                                            }
                                            className="group flex w-full h-9 text-sm items-center px-3 rounded-sm justify-between"
                                            onClick={() => onItemClick(item)}
                                        >
                                            <div className="flex items-center gap-2 truncate">
                                                {item.pinned && (
                                                    <ArrowUpToLine className="h-3 w-3 flex-shrink-0" />
                                                )}
                                                <span className="truncate">{item.name}</span>
                                            </div>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger>
                                                    <Button
                                                        className="hidden group-hover:flex"
                                                        size="icon-sm"
                                                        variant="ghost"
                                                        onClick={e => e.stopPropagation()}
                                                    >
                                                        <Ellipsis />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent>
                                                    <DropdownMenuItem
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            onPinClick(item.id);
                                                        }}
                                                    >
                                                        {item.pinned ? (
                                                            <>
                                                                <ArrowDownToLine />
                                                                <span>{t('common.unpin')}</span>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <ArrowUpToLine />
                                                                <span>{t('common.pin')}</span>
                                                            </>
                                                        )}
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleRenameClick(item);
                                                        }}
                                                    >
                                                        <PencilLine />
                                                        <span>{t('common.rename')}</span>
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleDeleteClick(item);
                                                        }}
                                                    >
                                                        <Trash2 />
                                                        <span>{t('common.delete')}</span>
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </Button>
                                    ))
                                )}
                            </div>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </SidebarContent>
            </Sidebar>

            {/* Rename Dialog */}
            <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{locale.renameTitle}</DialogTitle>
                        <DialogDescription>{locale.renameDescription}</DialogDescription>
                    </DialogHeader>
                    <Input
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') handleRenameConfirm();
                        }}
                        placeholder={t('common.name')}
                        autoFocus
                        disabled={renameLoading}
                    />
                    {renameError && (
                        <Alert variant="destructive">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>{renameError}</AlertDescription>
                        </Alert>
                    )}
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setRenameDialogOpen(false)}
                            disabled={renameLoading}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button onClick={handleRenameConfirm} disabled={renameLoading}>
                            {t('common.rename')}
                            {renameLoading ? (
                                <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                            ) : (
                                <CornerDownLeft className="ml-2 h-4 w-4" />
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Dialog */}
            <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{locale.deleteTitle}</DialogTitle>
                        <DialogDescription>{locale.deleteDescription}</DialogDescription>
                    </DialogHeader>
                    {deleteError && (
                        <Alert variant="destructive">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>{deleteError}</AlertDescription>
                        </Alert>
                    )}
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setDeleteDialogOpen(false)}
                            disabled={deleteLoading}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleDeleteConfirm}
                            disabled={deleteLoading}
                        >
                            {deleteLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {t('common.delete')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
