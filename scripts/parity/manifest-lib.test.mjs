import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    contractTestMappings,
    hashFileSet,
    sourceModule,
    synchronizeTestMappings,
    testArea,
    typescriptTarget,
    updateParityEntry,
    validateManifest,
} from './manifest-lib.mjs';

test('maps core and service source paths', () => {
    assert.equal(sourceModule('src/agentscope/message/_base.py'), 'message');
    assert.equal(
        typescriptTarget('src/agentscope/message/_base.py'),
        'packages/agentscope/src/message'
    );
    assert.equal(
        typescriptTarget('src/agentscope/app/message_bus/_base.py'),
        'packages/agentscope-service/src/message-bus'
    );
    assert.equal(
        typescriptTarget('src/agentscope/app/channel/_dingtalk/_tools/_send_message.py'),
        'packages/agentscope-service/src/channel/dingtalk'
    );
    assert.equal(typescriptTarget('src/agentscope/_logging.py'), 'packages/agentscope/src/logger');
    assert.equal(sourceModule('src/agentscope/py.typed'), 'root');
    assert.equal(typescriptTarget('src/agentscope/py.typed'), 'packages/agentscope');
    assert.equal(
        typescriptTarget('src/agentscope/types/_reply.py'),
        'packages/agentscope/src/type'
    );
    assert.equal(
        typescriptTarget('src/agentscope/workspace/_docker/Dockerfile.template'),
        'packages/agentscope/src/workspace'
    );
});

test('maps Python routers and utility modules onto existing TypeScript architecture areas', () => {
    assert.equal(
        typescriptTarget('src/agentscope/app/_router/_schema/_channel.py'),
        'packages/agentscope-service/src/http/schemas'
    );
    assert.equal(
        typescriptTarget('src/agentscope/app/_router/_channel.py'),
        'packages/agentscope-service/src/http/routes'
    );
    assert.equal(
        typescriptTarget('src/agentscope/_utils/_common.py'),
        'packages/agentscope/src/_utils'
    );
});

test('infers behavior areas from both Python test naming conventions', () => {
    assert.equal(testArea('tests/agent_basic_test.py'), 'agent');
    assert.equal(testArea('tests/test_e2e_api.py'), 'e2e');
});

test('maps every model-card family to Python and TypeScript loaders', () => {
    for (const module of ['model', 'embedding', 'tts']) {
        const mapping = contractTestMappings(module);
        assert.ok(mapping.pythonTests.length > 0);
        assert.ok(mapping.typescriptTests.includes('packages/agentscope/src/model/card.test.ts'));
    }
});

test('aggregate hashing is independent of input order', () => {
    const first = { path: 'a.py', content: Buffer.from('a') };
    const second = { path: 'b.py', content: Buffer.from('b') };
    assert.equal(hashFileSet([first, second]), hashFileSet([second, first]));
});

test('validates complete manifest structure', () => {
    const digest = '0'.repeat(64);
    const manifest = {
        schemaVersion: 1,
        pythonCommit: '0'.repeat(40),
        sourceFiles: [
            {
                path: 'src/agentscope/message/_base.py',
                sha256: digest,
                status: 'mapped',
                typescriptTarget: 'packages/agentscope/src/message',
            },
        ],
        contractDataFiles: [],
        testFiles: [],
        summary: {
            sourceFiles: { count: 1, sha256: digest },
            contractDataFiles: { count: 0, sha256: digest },
            testFiles: { count: 0, sha256: digest },
        },
    };

    assert.deepEqual(validateManifest(manifest), []);
});

test('rejects duplicate paths and unsupported statuses', () => {
    const digest = '0'.repeat(64);
    const manifest = {
        schemaVersion: 1,
        pythonCommit: '0'.repeat(40),
        sourceFiles: [
            {
                path: 'same.py',
                sha256: digest,
                status: 'skipped',
                typescriptTarget: 'target',
            },
            {
                path: 'same.py',
                sha256: digest,
                status: 'mapped',
                typescriptTarget: 'target',
            },
        ],
        contractDataFiles: [],
        testFiles: [],
        summary: {
            sourceFiles: { count: 2, sha256: digest },
            contractDataFiles: { count: 0, sha256: digest },
            testFiles: { count: 0, sha256: digest },
        },
    };

    assert.deepEqual(validateManifest(manifest), [
        'sourceFiles contains duplicate path same.py.',
        'Invalid parity status skipped for same.py.',
    ]);
});

test('advances parity entries and merges test references', () => {
    const entry = {
        path: 'src/agentscope/types/_json.py',
        status: 'mapped',
        pythonTests: [],
        typescriptTests: ['existing.test.ts'],
    };

    updateParityEntry(
        entry,
        'implemented',
        ['tests/types_test.py'],
        ['types.test.ts', 'existing.test.ts']
    );

    assert.deepEqual(entry, {
        path: 'src/agentscope/types/_json.py',
        status: 'implemented',
        pythonTests: ['tests/types_test.py'],
        typescriptTests: ['existing.test.ts', 'types.test.ts'],
    });
    assert.throws(() => updateParityEntry(entry, 'mapped'), /Cannot move/);
});

test('builds reverse Python-test mappings from sources and standalone overrides', () => {
    const manifest = {
        sourceFiles: [
            {
                pythonTests: ['tests/source_test.py'],
                typescriptTests: ['packages/source.test.ts'],
            },
        ],
        testFiles: [
            { path: 'tests/source_test.py', typescriptTests: [] },
            { path: 'tests/helper.py', typescriptTests: [] },
        ],
    };
    synchronizeTestMappings(manifest, {
        'tests/helper.py': ['packages/helper.test.ts'],
    });
    assert.deepEqual(manifest.testFiles, [
        { path: 'tests/source_test.py', typescriptTests: ['packages/source.test.ts'] },
        { path: 'tests/helper.py', typescriptTests: ['packages/helper.test.ts'] },
    ]);
});

test('strict manifests reject unverified or unmapped entries', () => {
    const digest = '0'.repeat(64);
    const manifest = {
        schemaVersion: 2,
        requireCompleteParity: true,
        pythonCommit: '0'.repeat(40),
        sourceFiles: [
            {
                path: 'source.py',
                sha256: digest,
                status: 'mapped',
                typescriptTarget: 'target',
                typescriptTests: [],
            },
        ],
        contractDataFiles: [],
        testFiles: [
            {
                path: 'test.py',
                sha256: digest,
                status: 'mapped',
                typescriptTests: [],
            },
        ],
        summary: {
            sourceFiles: { count: 1, sha256: digest },
            contractDataFiles: { count: 0, sha256: digest },
            testFiles: { count: 1, sha256: digest },
        },
    };
    assert.deepEqual(validateManifest(manifest), [
        'Complete parity requires verified status for source.py.',
        'Complete parity requires verified status for test.py.',
        'Complete parity requires TypeScript tests for source.py.',
        'Complete parity requires a TypeScript mapping for test.py.',
    ]);
});
