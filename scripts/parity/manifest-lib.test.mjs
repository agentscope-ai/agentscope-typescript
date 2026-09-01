import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    hashFileSet,
    sourceModule,
    testArea,
    typescriptTarget,
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
    assert.equal(typescriptTarget('src/agentscope/_logging.py'), 'packages/agentscope/src/logger');
    assert.equal(sourceModule('src/agentscope/py.typed'), 'root');
    assert.equal(typescriptTarget('src/agentscope/py.typed'), 'packages/agentscope');
    assert.equal(
        typescriptTarget('src/agentscope/workspace/_docker/Dockerfile.template'),
        'packages/agentscope/src/workspace'
    );
});

test('infers behavior areas from both Python test naming conventions', () => {
    assert.equal(testArea('tests/agent_basic_test.py'), 'agent');
    assert.equal(testArea('tests/test_e2e_api.py'), 'e2e');
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
