import type { MCPServerCreateConfig, MCPServerState } from '@shared/types/mcp';
import { AlertCircleIcon, Loader2, Upload } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n/useI18n';

interface ImportDialogProps {
    onImport: (config: MCPServerCreateConfig) => Promise<MCPServerState>;
}

/**
 * Dialog component for importing MCP server configurations from JSON.
 * @param root0 - The component props
 * @param root0.onImport - Callback function to handle the import of a server configuration
 * @returns An import dialog component
 */
export function ImportDialog({ onImport }: ImportDialogProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [jsonInput, setJsonInput] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const target = e.currentTarget;
            const start = target.selectionStart;
            const end = target.selectionEnd;
            const value = target.value;

            // Insert tab character (or 2 spaces)
            const newValue = value.substring(0, start) + '  ' + value.substring(end);
            setJsonInput(newValue);

            // Set cursor position after the inserted tab
            setTimeout(() => {
                target.selectionStart = target.selectionEnd = start + 2;
            }, 0);
        }
    };

    const handleImport = async () => {
        setError(null);
        setSubmitting(true);
        try {
            const parsed = JSON.parse(jsonInput);

            // Auto-detect protocol based on fields
            const hasUrl = 'url' in parsed;
            const hasCommand = 'command' in parsed;

            if (hasUrl && hasCommand) {
                setError(t('mcp.conflictingFields'));
                setSubmitting(false);
                return;
            }

            if (!hasUrl && !hasCommand) {
                setError(t('mcp.missingRequiredFields'));
                setSubmitting(false);
                return;
            }

            // Add protocol field based on detection
            const config = {
                ...parsed,
                protocol: hasUrl ? 'streamable-http' : 'stdio',
            };

            await onImport(config);
            setOpen(false);
            setJsonInput('');
        } catch (err) {
            if (err instanceof SyntaxError) {
                setError(t('mcp.jsonParseError'));
            } else {
                setError(err instanceof Error ? err.message : t('mcp.importError'));
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleOpenChange = (newOpen: boolean) => {
        setOpen(newOpen);
        if (!newOpen) {
            setError(null);
            setJsonInput('');
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild>
                <Button size="sm">
                    <Upload data-icon="inline-start" />
                    <span>{t('mcp.import')}</span>
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t('mcp.importServer')}</DialogTitle>
                    <DialogDescription>{t('mcp.importServerDesc')}</DialogDescription>
                </DialogHeader>
                <Field>
                    <FieldLabel>{t('mcp.jsonConfig')}</FieldLabel>
                    <FieldDescription>{t('mcp.jsonConfigDesc')}</FieldDescription>
                    <Textarea
                        className="h-[500px] font-mono resize-none"
                        value={jsonInput}
                        onChange={e => setJsonInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={`// STDIO Example:
{
  "name": "My STDIO Server",
  "command": "node",
  "args": ["server.js"],
  "env": {
    "NODE_ENV": "production"
  }
}

// Streamable HTTP Example:
{
  "name": "My HTTP Server",
  "url": "https://example.com/mcp",
  "timeout": 30000
}`}
                    />
                </Field>
                {error && (
                    <Alert variant="destructive" className="bg-red-50 border-red-400!">
                        <AlertCircleIcon />
                        <AlertTitle>{t('mcp.parseError')}</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}
                <div className="flex justify-end gap-2 mt-4">
                    <Button variant="secondary" onClick={() => handleOpenChange(false)}>
                        {t('common.cancel')}
                    </Button>
                    <Button onClick={handleImport} disabled={submitting || !jsonInput.trim()}>
                        {submitting && <Loader2 className="animate-spin" />}
                        {t('mcp.import')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
