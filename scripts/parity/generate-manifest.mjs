import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import {
    describeFiles,
    hashFileSet,
    listTrackedFiles,
    sourceModule,
    testArea,
    typescriptTarget,
    validateManifest,
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

let previousManifest;
try {
    previousManifest = JSON.parse(await readFile(outputPath, 'utf8'));
} catch (error) {
    if (error?.code !== 'ENOENT') throw error;
}

/**
 * Return prior progress when a baseline file has not changed.
 *
 * @param {string} collection Manifest collection name.
 * @param {string} filePath Repository-relative file path.
 * @param {string} sha256 Current file digest.
 * @returns {object} Fields that are safe to preserve.
 */
function previousProgress(collection, filePath, sha256) {
    const entry = previousManifest?.[collection]?.find(candidate => candidate.path === filePath);
    if (!entry || entry.sha256 !== sha256) return {};
    return {
        status: entry.status,
        ...(entry.pythonTests ? { pythonTests: entry.pythonTests } : {}),
        ...(entry.typescriptTests ? { typescriptTests: entry.typescriptTests } : {}),
    };
}

const pythonCommit = execFileSync('git', ['-C', pythonRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
}).trim();

const allSourcePaths = listTrackedFiles(pythonRoot, 'src/agentscope');
const contractDataPaths = allSourcePaths.filter(filePath => filePath.endsWith('.yaml'));
const sourcePaths = allSourcePaths.filter(filePath => !filePath.endsWith('.yaml'));
const testPaths = listTrackedFiles(pythonRoot, 'tests');

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
        ...previousProgress('sourceFiles', sourcePath, sha256),
    })),
    contractDataFiles: contractDataFiles.map(({ path: sourcePath, sha256 }) => ({
        path: sourcePath,
        sha256,
        module: sourceModule(sourcePath),
        typescriptTarget: typescriptTarget(sourcePath),
        status: 'mapped',
        ...previousProgress('contractDataFiles', sourcePath, sha256),
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
