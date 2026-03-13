import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';

import { AppSidebar } from '@/components/layout/AppSidebar';
import { AppStatusbar } from '@/components/layout/AppStatusbar';
import { AppTitlebar } from '@/components/layout/AppTitlebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

/**
 * The main application layout component that provides the sidebar and content structure.
 *
 * @returns An AppLayout component.
 */
export function AppLayout() {
    const navigate = useNavigate();

    useEffect(() => {
        const handler = (_: unknown, path: string) => navigate(path);
        window.electron.ipcRenderer.on('navigate', handler);
        return () => {
            window.electron.ipcRenderer.removeListener('navigate', handler);
        };
    }, [navigate]);

    return (
        <div className="h-full flex flex-col">
            <SidebarProvider className="flex-1 flex flex-col overflow-hidden">
                <AppTitlebar />
                <div className="flex flex-1 overflow-hidden">
                    <AppSidebar />
                    <SidebarInset className="overflow-hidden">
                        <Outlet />
                    </SidebarInset>
                </div>
                <AppStatusbar />
            </SidebarProvider>
        </div>
    );
}
