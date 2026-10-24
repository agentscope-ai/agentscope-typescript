import type { ModelConfig } from '@shared/types/config';
import { formatProviderName } from '@shared/utils/common';
import { PlusCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { ModelCreateDrawer } from '@/components/drawer/ModelCreateDrawer';
import { ModelUpdateDrawer } from '@/components/drawer/ModelUpdateDrawer';
import { ProviderLogo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';

interface ModelSettingsProps {
    modelConfigs: Record<string, ModelConfig>;
    onChange: (modelKey: string, updatedModelConfig: ModelConfig) => void;
    onCreate: (modelKey: string, newModelConfig: ModelConfig) => void;
    onDelete: (modelKey: string) => void;
}

/**
 * Model settings component for managing AI model configurations.
 * @param root0 - Component props
 * @param root0.modelConfigs - Current model configurations
 * @param root0.onChange - Callback for updating a model configuration
 * @param root0.onCreate - Callback for creating a new model configuration
 * @param root0.onDelete - Callback for deleting a model configuration
 * @returns The model settings UI component
 */
export function ModelSettings({ modelConfigs, onChange, onCreate, onDelete }: ModelSettingsProps) {
    const { t } = useTranslation();
    const [editingConfigKey, setEditingConfigKey] = useState<string | null>(null);

    const handleCreate = async (modelKey: string, modelConfig: ModelConfig) => {
        // Check for duplicate key
        if (modelConfigs[modelKey]) {
            throw new Error(`${t('setting.modelConfigKeyExists')}`);
        }
        onCreate(modelKey, modelConfig);
        toast.success(t('setting.modelConfigCreateSuccess'), { position: 'top-center' });
    };

    const groupedModels: {
        [key: string]: (ModelConfig & { name: string })[];
    } = {};
    Object.entries(modelConfigs).forEach(([key, config]) => {
        if (!groupedModels[config.provider]) {
            groupedModels[config.provider] = [];
        }
        groupedModels[config.provider].push({ ...config, name: key });
    });

    return (
        <div className="flex flex-col size-full max-w-2xl max-h-full gap-y-8 overflow-hidden">
            {/* Main Title */}
            <div className="flex flex-row w-full justify-between items-center flex-shrink-0">
                <div className="flex font-bold text-2xl">{t('setting.models')}</div>
                <ModelCreateDrawer onCreate={handleCreate}>
                    <Button size="sm" variant="default">
                        <PlusCircle />
                        <span>{t('setting.createModelConfig')}</span>
                    </Button>
                </ModelCreateDrawer>
            </div>

            <div className="flex flex-col w-full flex-1 overflow-y-auto no-scrollbar gap-4 p-1">
                {/* Existing Model Configs */}
                {Object.entries(groupedModels).map(([provider, configs]) => {
                    return (
                        <div key={provider} className="bg-secondary ring ring-border rounded-xl">
                            <div className="px-4 py-2 ">
                                <div className="flex items-center gap-x-2 font-mono font-bold">
                                    {formatProviderName(provider as ModelConfig['provider'])}
                                </div>
                            </div>
                            <div className="m-2 mt-0 bg-white rounded-lg py-2 px-1">
                                <div className="px-2 text-xs text-muted-foreground font-medium pb-1">
                                    Total 10 configs
                                </div>
                                {configs.map(modelConfig => {
                                    return (
                                        <div
                                            key={modelConfig.name}
                                            className="group flex flex-row items-center justify-between font-mono text-sm hover:bg-secondary px-2 py-2 rounded-sm cursor-pointer"
                                            onClick={() => setEditingConfigKey(modelConfig.name)}
                                        >
                                            <div className="flex flex-row items-center gap-x-1">
                                                <ProviderLogo
                                                    provider={provider as ModelConfig['provider']}
                                                    className="size-4"
                                                />
                                                <span className="text-secondary-foreground">
                                                    {modelConfig.name}
                                                </span>
                                            </div>
                                            <div className="flex gap-2 items-center">
                                                <span className="text-muted-foreground">
                                                    {modelConfig.modelName}
                                                </span>
                                                <Button
                                                    size="icon-xs"
                                                    variant="outline"
                                                    className="invisible group-hover:visible"
                                                    onClick={() => {
                                                        onDelete(modelConfig.name);
                                                        toast.success(
                                                            t('setting.deleteModelConfigSuccess'),
                                                            { position: 'top-center' }
                                                        );
                                                    }}
                                                >
                                                    <Trash2 />
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
            {editingConfigKey && modelConfigs[editingConfigKey] ? (
                <ModelUpdateDrawer
                    modelKey={editingConfigKey}
                    setModelKey={setEditingConfigKey}
                    modelConfig={modelConfigs[editingConfigKey]}
                    onUpdate={async modelConfig => {
                        onChange(editingConfigKey, modelConfig);
                        toast.success(t('setting.updateModelConfigSuccess'), {
                            position: 'top-center',
                        });
                        setEditingConfigKey(null);
                    }}
                />
            ) : null}
        </div>
    );
}
