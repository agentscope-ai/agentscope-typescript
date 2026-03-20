import type { ModelConfig } from '@shared/types/config';
import { Plus } from 'lucide-react';
import { useState, useEffect } from 'react';
import { toast } from 'sonner';

import { ModelCreateDrawer } from '@/components/drawer/ModelCreateDrawer';
import { ProviderLogo } from '@/components/logo';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldGroup,
    FieldLabel,
    FieldLegend,
    FieldSeparator,
    FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfig } from '@/hooks/use-config';
import { useTranslation } from '@/i18n/useI18n';

/**
 * Agent configuration page for managing agent settings and models.
 *
 * @returns An AgentPage component.
 */
export function AgentPage() {
    const { t } = useTranslation();
    const { config, updateConfig } = useConfig();
    const [selectedAgent] = useState<string>('friday');
    const [instruction, setInstruction] = useState<string>('');
    const [modelKey, setModelKey] = useState<string>('');
    const [maxIters, setMaxIters] = useState<number>(20);
    const [compressionTrigger, setCompressionTrigger] = useState<number>(10000);

    const agentConfig = config?.agents?.[selectedAgent];

    const handleModelConfigCreate = async (modelKey: string, newModelConfig: ModelConfig) => {
        const modelConfigs = config ? config.models : {};

        if (modelConfigs[modelKey]) {
            throw new Error(
                `Model key "${modelKey}" already exists. Please choose a different name.`
            );
        }

        await updateConfig({
            models: {
                ...modelConfigs,
                [modelKey]: newModelConfig,
            },
        });

        toast.success(t('setting.modelConfigCreateSuccess'), { position: 'top-center' });
    };

    useEffect(() => {
        if (agentConfig) {
            setInstruction(agentConfig.instruction);
            setMaxIters(agentConfig.maxIters);
            setCompressionTrigger(agentConfig.compressionTrigger);

            // If modelKey is empty and there are models available, select the first one
            if (!agentConfig.modelKey && config?.models && Object.keys(config.models).length > 0) {
                const firstModelKey = Object.keys(config.models)[0];
                setModelKey(firstModelKey);
            } else {
                setModelKey(agentConfig.modelKey);
            }
        }
    }, [agentConfig, config?.models]);

    const handleSave = async () => {
        if (!config || !agentConfig) return;
        await updateConfig({
            agents: {
                ...config.agents,
                [selectedAgent]: {
                    ...agentConfig,
                    instruction,
                    modelKey,
                    maxIters,
                    compressionTrigger,
                },
            },
        });
        toast.success(t('agent.saveSuccess'), {
            position: 'top-center',
        });
    };

    return (
        <div className="flex flex-row h-full w-full">
            <Sidebar collapsible="none" className="w-64">
                <SidebarHeader className="my-2">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button size="sm" variant="default">
                                {t('agent.addCustomAgent')}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent align="center">{t('common.comingSoon')}</TooltipContent>
                    </Tooltip>
                </SidebarHeader>
                <SidebarContent className="flex flex-1">
                    <SidebarGroup>
                        <SidebarGroupLabel>{t('agent.builtin')}</SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <SidebarMenuButton isActive={selectedAgent === 'friday'}>
                                        Friday
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                    <SidebarGroup>
                        <SidebarGroupLabel>{t('agent.custom')}</SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <SidebarMenuButton disabled>
                                        {t('common.comingSoon')}
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </SidebarContent>
            </Sidebar>
            <div className="flex flex-col h-full max-w-2xl min-w-xl 2xl:w-2xl flex-1 p-6 gap-y-5">
                <div>
                    <div className="flex items-center justify-between">
                        <h1 className="text-2xl font-bold">
                            {t('common.agent')}: {agentConfig?.name}
                        </h1>
                        <Avatar className="border-muted border">
                            <AvatarImage
                                src={`/src/assets/avatars/${agentConfig?.avatar || 'friday'}.png`}
                            />
                            <AvatarFallback>{agentConfig?.name?.[0]?.toUpperCase()}</AvatarFallback>
                        </Avatar>
                    </div>
                    <p className="text-muted-foreground text-sm mt-1">{t('agent.description')}</p>
                </div>
                <FieldSet>
                    <FieldLegend>{t('common.model')}</FieldLegend>
                    <FieldDescription>{t('agent.modelDescription')}</FieldDescription>
                    <FieldGroup className="flex flex-row gap-x-2">
                        <Field>
                            <FieldLabel>{t('common.llm')}</FieldLabel>
                            <div className="flex w-full gap-x-2">
                                <Select value={modelKey} onValueChange={setModelKey}>
                                    <SelectTrigger size="sm" className="w-full">
                                        <SelectValue placeholder={t('agent.llmPlaceholder')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(config?.models || {}).map(
                                            ([key, config]) => (
                                                <SelectItem value={key} key={key}>
                                                    <ProviderLogo
                                                        provider={config.provider}
                                                        className="size-4"
                                                    />
                                                    {key}
                                                </SelectItem>
                                            )
                                        )}
                                    </SelectContent>
                                </Select>
                                <ModelCreateDrawer onCreate={handleModelConfigCreate}>
                                    <Button size="icon-sm">
                                        <Plus />
                                    </Button>
                                </ModelCreateDrawer>
                            </div>
                        </Field>
                    </FieldGroup>
                </FieldSet>
                <FieldSeparator />
                <FieldSet>
                    <FieldLegend>{t('agent.context')}</FieldLegend>
                    <FieldDescription>{t('agent.contextDescription')}</FieldDescription>
                    <FieldGroup>
                        <Field>
                            <FieldLabel>{t('agent.instruction')}</FieldLabel>
                            <Textarea
                                value={instruction}
                                onChange={e => setInstruction(e.target.value)}
                                placeholder={t('agent.instructionPlaceholder')}
                                className="h-[150px]! min-h-[150px]! bg-muted border-none shadow-none"
                            />
                        </Field>
                        <Field orientation="horizontal">
                            <FieldContent>
                                <FieldLabel>{t('agent.compressionTrigger')}</FieldLabel>
                                <FieldDescription>
                                    {t('agent.compressionTriggerDesc')}
                                </FieldDescription>
                            </FieldContent>
                            <Input
                                type="number"
                                value={compressionTrigger}
                                onChange={e => setCompressionTrigger(Number(e.target.value))}
                                className="h-8 text-sm w-50 bg-muted border-none shadow-none"
                            />
                        </Field>
                        <Field orientation="horizontal">
                            <FieldContent>
                                <FieldLabel>{t('agent.maxIters')}</FieldLabel>
                                <FieldDescription>{t('agent.maxItersDesc')}</FieldDescription>
                            </FieldContent>
                            <Input
                                type="number"
                                value={maxIters}
                                onChange={e => setMaxIters(Number(e.target.value))}
                                max={10}
                                className="h-8 text-sm w-50 bg-muted border-none shadow-none"
                            />
                        </Field>
                    </FieldGroup>
                </FieldSet>
                <div className="flex">
                    <Button size="sm" onClick={handleSave}>
                        {t('common.save')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
