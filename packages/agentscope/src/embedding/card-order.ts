/* eslint-disable jsdoc/require-jsdoc */

const ORDER: Record<string, string[]> = {
    openai: ['text-embedding-3-small', 'text-embedding-3-large'],
    gemini: ['gemini-embedding-2', 'gemini-embedding-001'],
    dashscope: [
        'multimodal-embedding-v1',
        'tongyi-embedding-vision-flash',
        'qwen2.5-vl-embedding',
        'qwen3-vl-embedding',
        'text-embedding-v4',
        'tongyi-embedding-vision-plus',
        'text-embedding-v3',
    ],
};

export function embeddingModelOrder(provider: string, model: string): number {
    const index = ORDER[provider]?.indexOf(model) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
