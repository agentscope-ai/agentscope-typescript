import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import {
    describeFiles,
    hashFileSet,
    sourceModule,
    testArea,
    typescriptTarget,
    validateManifest,
    walkFiles,
} from './manifest-lib.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

/**
 * Read a named CLI option.
 *
 * @param {string} name Option name.
 * @param {string} fallback Default value.
 * @returns {string} Option value.
 */
function readOption(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const pythonRoot = path.resolve(
    readOption('--python-root', path.join(repositoryRoot, '../agentscope-python'))
);
const outputPath = path.resolve(
    readOption('--output', path.join(repositoryRoot, 'parity/agentscope-python-de163b34.json'))
);

const pythonCommit = execFileSync('git', ['-C', pythonRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
}).trim();

const allSourcePaths = await walkFiles(path.join(pythonRoot, 'src/agentscope'));
const contractDataPaths = allSourcePaths.filter(filePath => filePath.endsWith('.yaml'));
const sourcePaths = allSourcePaths.filter(filePath => !filePath.endsWith('.yaml'));
const testPaths = await walkFiles(path.join(pythonRoot, 'tests'));

const sourceFiles = await describeFiles(pythonRoot, sourcePaths);
const contractDataFiles = await describeFiles(pythonRoot, contractDataPaths);
const testFiles = await describeFiles(pythonRoot, testPaths);

const manifest = {
    schemaVersion: 1,
    pythonRepository: 'https://github.com/agentscope-ai/agentscope.git',
    pythonCommit,
    sourceFiles: sourceFiles.map(({ path: sourcePath, sha256 }) => ({
        path: sourcePath,
        sha256,
        module: sourceModule(sourcePath),
        typescriptTarget: typescriptTarget(sourcePath),
        status: 'mapped',
        pythonTests: [],
        typescriptTests: [],
    })),
    contractDataFiles: contractDataFiles.map(({ path: sourcePath, sha256 }) => ({
        path: sourcePath,
        sha256,
        module: sourceModule(sourcePath),
        typescriptTarget: typescriptTarget(sourcePath),
        status: 'mapped',
    })),
    testFiles: testFiles.map(({ path: testPath, sha256 }) => ({
        path: testPath,
        sha256,
        area: testArea(testPath),
        typescriptTests: [],
    })),
    summary: {
        sourceFiles: {
            count: sourceFiles.length,
            sha256: hashFileSet(sourceFiles),
        },
        contractDataFiles: {
            count: contractDataFiles.length,
            sha256: hashFileSet(contractDataFiles),
        },
        testFiles: {
            count: testFiles.length,
            sha256: hashFileSet(testFiles),
        },
    },
};

const errors = validateManifest(manifest);
if (errors.length > 0) {
    throw new Error(`Generated manifest is invalid:\n${errors.join('\n')}`);
}

await mkdir(path.dirname(outputPath), { recursive: true });
const prettierOptions = (await resolveConfig(outputPath)) ?? {};
const manifestContent = await format(JSON.stringify(manifest), {
    ...prettierOptions,
    parser: 'json',
});
await writeFile(outputPath, manifestContent, 'utf8');

process.stdout.write(
    `Generated ${path.relative(repositoryRoot, outputPath)} for ${pythonCommit}: ` +
        `${sourceFiles.length} source files, ${contractDataFiles.length} contract data files, ` +
        `${testFiles.length} test files.\n`
);
