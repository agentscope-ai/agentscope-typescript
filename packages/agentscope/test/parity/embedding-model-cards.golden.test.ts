import { readFileSync } from 'fs';
import path from 'path';

import {
    DashScopeEmbeddingModel,
    GeminiEmbeddingModel,
    OllamaEmbeddingModel,
    OpenAIEmbeddingModel,
} from '../../src/embedding';

interface Fixture {
    python_commit: string;
    classes: Record<string, Array<Record<string, unknown>>>;
}

const fixture = JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures/embedding-model-cards.python.json'), 'utf8')
) as Fixture;

describe('embedding model-card Python golden', () => {
    test('is pinned to the selected Python commit', () => {
        expect(fixture.python_commit).toBe('61cdeae4ffe63182f3343229aa6fbd868e30b0c5');
    });

    test.each([
        ['OpenAIEmbeddingModel', OpenAIEmbeddingModel],
        ['OllamaEmbeddingModel', OllamaEmbeddingModel],
        ['GeminiEmbeddingModel', GeminiEmbeddingModel],
        ['DashScopeEmbeddingModel', DashScopeEmbeddingModel],
    ] as const)('%s matches every Python card', (name, modelClass) => {
        expect(modelClass.listModels().map(card => card.toJSON())).toEqual(fixture.classes[name]);
    });
});
