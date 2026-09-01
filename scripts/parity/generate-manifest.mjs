import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import {
    describeFiles,
    contractTestMappings,
    hashFileSet,
    listTrackedFiles,
    sourceModule,
    synchronizeTestMappings,
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
    readOption('--output', path.join(repositoryRoot, 'parity/agentscope-python-61cdeae4.json'))
);
const previousManifestPath = path.resolve(readOption('--previous-manifest', outputPath));
const testMappingsPath = path.resolve(
    readOption('--test-mappings', path.join(repositoryRoot, 'parity/test-mapping-overrides.json'))
);

let previousManifest;
try {
    previousManifest = JSON.parse(await readFile(previousManifestPath, 'utf8'));
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
    if (!entry) return {};
    return {
        ...(entry.sha256 === sha256 && entry.status ? { status: entry.status } : {}),
        ...(entry.pythonTests ? { pythonTests: entry.pythonTests } : {}),
        ...(entry.typescriptTests ? { typescriptTests: entry.typescriptTests } : {}),
    };
}

/**
 * Keep generated targets honest even when Python nesting has no one-to-one TS directory.
 *
 * @param {string} target Proposed repository-relative path.
 * @returns {string} Nearest existing implementation area.
 */
function existingTypescriptTarget(target) {
    let candidate = target;
    while (!existsSync(path.resolve(repositoryRoot, candidate))) {
        const parent = path.posix.dirname(candidate);
        if (parent === candidate || !candidate.startsWith('packages/')) break;
        candidate = parent;
    }
    return candidate;
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
const testMappingOverrides = JSON.parse(await readFile(testMappingsPath, 'utf8'));

const manifest = {
    schemaVersion: 2,
    requireCompleteParity: false,
    pythonRepository: 'https://github.com/agentscope-ai/agentscope.git',
    pythonCommit,
    sourceFiles: sourceFiles.map(({ path: sourcePath, sha256 }) => ({
        path: sourcePath,
        sha256,
        module: sourceModule(sourcePath),
        typescriptTarget: existingTypescriptTarget(typescriptTarget(sourcePath)),
        status: 'mapped',
        pythonTests: [],
        typescriptTests: [],
        ...previousProgress('sourceFiles', sourcePath, sha256),
    })),
    contractDataFiles: contractDataFiles.map(({ path: sourcePath, sha256 }) => {
        const module = sourceModule(sourcePath);
        return {
            path: sourcePath,
            sha256,
            module,
            typescriptTarget: existingTypescriptTarget(typescriptTarget(sourcePath)),
            status: 'mapped',
            ...contractTestMappings(module),
            ...previousProgress('contractDataFiles', sourcePath, sha256),
        };
    }),
    testFiles: testFiles.map(({ path: testPath, sha256 }) => ({
        path: testPath,
        sha256,
        area: testArea(testPath),
        status: 'mapped',
        typescriptTests: [],
        ...previousProgress('testFiles', testPath, sha256),
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

synchronizeTestMappings(manifest, testMappingOverrides);

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
