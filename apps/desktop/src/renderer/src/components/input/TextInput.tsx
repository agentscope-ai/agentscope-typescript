import { ContentBlock, TextBlock, DataBlock, URLSource } from '@agentscope-ai/agentscope/message';
import { isMac } from '@shared/utils/platform';
import { Paperclip, Send } from 'lucide-react';
import React, {
    useState,
    useRef,
    useMemo,
    KeyboardEvent,
    useImperativeHandle,
    forwardRef,
} from 'react';

import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

interface TextInputProps {
    onSend: (blocks: ContentBlock[]) => void;
    placeholder?: string;
    autoComplete?: (input: string) => string | null;
    disabled?: boolean;
    className?: string;
}

export interface TextInputRef {
    focus: () => void;
}

/**
 * A text input component with file attachment support and autocomplete functionality.
 *
 * @param root0 - The component props.
 * @param root0.onSend - Callback function to handle sending content blocks.
 * @param root0.placeholder - Placeholder text for the input field.
 * @param root0.autoComplete - Function to provide autocomplete suggestions.
 * @param root0.disabled - Whether the input is disabled.
 * @param root0.className - Additional CSS classes for styling.
 * @returns A TextInput component.
 */
export const TextInput = forwardRef<TextInputRef, TextInputProps>(
    ({ onSend, placeholder, autoComplete, disabled = false, className }, ref) => {
        const { t } = useTranslation();
        const defaultPlaceholder = placeholder || t('chat.inputPlaceholder');
        const [value, setValue] = useState('');
        const [files, setFiles] = useState<File[]>([]);
        const [isFocused, setIsFocused] = useState(false);
        const textareaRef = useRef<HTMLTextAreaElement>(null);
        const fileInputRef = useRef<HTMLInputElement>(null);
        const measureRef = useRef<HTMLSpanElement>(null);

        useImperativeHandle(ref, () => ({
            focus: () => textareaRef.current?.focus(),
        }));

        // Calculate autocomplete suggestion using useMemo
        const suggestion = useMemo(() => {
            if (autoComplete && value && isFocused) {
                const result = autoComplete(value);
                // Only return the part after the cursor
                if (result && result.startsWith(value)) {
                    return result.substring(value.length);
                }
                return result || '';
            }
            return '';
        }, [value, autoComplete, isFocused]);

        const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
            // Tab key to select autocomplete
            if (e.key === 'Tab' && suggestion) {
                e.preventDefault();
                setValue(value + suggestion);
                return;
            }

            // Enter to send message, Shift+Enter for new line
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
            }
        };

        const handleSend = () => {
            if (!value.trim() || disabled) return;

            const blocks: ContentBlock[] = [];

            // Add text block
            if (value.trim()) {
                const textBlock: TextBlock = {
                    id: crypto.randomUUID(),
                    type: 'text',
                    text: value.trim(),
                };
                blocks.push(textBlock);
            }

            // Add data blocks for files
            if (files.length > 0) {
                files.forEach(file => {
                    // In Electron, File objects have a path property
                    const filePath = (file as File & { path?: string }).path;
                    if (filePath) {
                        const urlSource: URLSource = {
                            type: 'url',
                            url: `file://${filePath}`,
                            media_type: file.type || 'application/octet-stream',
                        };
                        const dataBlock: DataBlock = {
                            id: crypto.randomUUID(),
                            type: 'data',
                            source: urlSource,
                            name: file.name,
                        };
                        blocks.push(dataBlock);
                    }
                });
            }

            onSend?.(blocks);
            setValue('');
            setFiles([]);
        };

        const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
            if (e.target.files) {
                setFiles(Array.from(e.target.files));
            }
        };

        const removeFile = (index: number) => {
            setFiles(files.filter((_, i) => i !== index));
        };

        return (
            <div
                className={cn(
                    'flex flex-col gap-2 rounded-2xl border bg-background p-3',
                    className
                )}
                data-tour="chat-input"
            >
                {/* File list */}
                {files.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {files.map((file, index) => (
                            <div
                                key={index}
                                className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-sm"
                            >
                                <span className="max-w-[200px] truncate">{file.name}</span>
                                <button
                                    onClick={() => removeFile(index)}
                                    className="text-muted-foreground hover:text-foreground"
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {/* Input area */}
                <div className="relative">
                    <div className="relative">
                        {/* Hidden measurement element */}
                        <span
                            ref={measureRef}
                            className="invisible absolute whitespace-pre text-sm"
                            style={{
                                font: 'inherit',
                                padding: '0.5rem 0.75rem',
                                lineHeight: '1.5em',
                            }}
                        >
                            {value}
                        </span>

                        <textarea
                            ref={textareaRef}
                            value={value}
                            onChange={e => setValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onFocus={() => setIsFocused(true)}
                            onBlur={() => setIsFocused(false)}
                            placeholder={defaultPlaceholder}
                            disabled={disabled}
                            rows={3}
                            className="w-full resize-none rounded-md border-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                            style={{
                                maxHeight: 'calc(1.5em * 6)',
                                lineHeight: '1.5em',
                                overflowY: 'auto',
                            }}
                            autoFocus={true}
                        />

                        {/* Autocomplete suggestion - using absolute positioning overlay */}
                        {suggestion && isFocused && (
                            <div
                                className="pointer-events-none absolute left-0 top-0 px-3 py-2 text-sm"
                                style={{
                                    lineHeight: '1.5em',
                                    whiteSpace: 'pre-wrap',
                                    wordWrap: 'break-word',
                                }}
                            >
                                {/* Invisible input text */}
                                <span className="invisible">{value}</span>
                                {/* Suggestion text */}
                                <span className="text-muted-foreground">{suggestion}</span>
                                {/* Tab hint */}
                                <span className="ml-2 text-xs text-muted-foreground/60">
                                    <Kbd>Tab</Kbd> {t('textInput.toComplete')}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Button row */}
                    <div className="mt-2 flex items-center justify-between">
                        <div>
                            <span
                                className={`text-muted-foreground text-sm ${!isFocused && 'hidden'}`}
                            >
                                <Kbd>{isMac() ? '⇧' : 'Shift'}</Kbd> + <Kbd>Enter</Kbd>{' '}
                                {t('textInput.newLine')}
                            </span>
                        </div>
                        <div className="flex gap-2">
                            {/* Attachment button */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={disabled}
                                        className="shrink-0 rounded-full"
                                    >
                                        <Paperclip className="h-4 w-4" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('textInput.attach')}</TooltipContent>
                            </Tooltip>

                            {/* Send button */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        type="button"
                                        onClick={handleSend}
                                        disabled={disabled || !value.trim()}
                                        size="icon-sm"
                                        className="shrink-0 rounded-full"
                                    >
                                        <Send className="h-4 w-4" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('textInput.send')}</TooltipContent>
                            </Tooltip>

                            {/* Hidden file input */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                onChange={handleFileSelect}
                                className="hidden"
                            />
                        </div>
                    </div>
                </div>
            </div>
        );
    }
);

TextInput.displayName = 'TextInput';
