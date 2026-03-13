import { ModelProvider } from '@shared/types/config';

import googleLogo from '@/assets/images/logo-google.svg';
import ollamaLogo from '@/assets/images/logo-ollama.svg';
import openAILogo from '@/assets/images/logo-openai.svg';
import qwenLogo from '@/assets/images/logo-qwen.svg';
import { cn } from '@/lib/utils';

/**
 * Displays the logo for a given model provider.
 *
 * @param root0 - The component props.
 * @param root0.provider - The model provider type.
 * @param root0.className - Optional CSS class name.
 * @returns A provider logo image component.
 */
export function ProviderLogo({
    provider,
    className,
}: {
    provider: ModelProvider;
    className?: string;
}) {
    let logoSrc: string;
    switch (provider) {
        case 'dashscope':
            logoSrc = qwenLogo;
            break;
        case 'openai':
            logoSrc = openAILogo;
            break;
        case 'ollama':
            logoSrc = ollamaLogo;
            break;
        case 'deepseek':
            logoSrc = googleLogo;
            break;
    }

    return <img src={logoSrc} alt="logo" className={cn('bg-white rounded-full', className)} />;
}
