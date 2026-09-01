import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { synchronizeTestMappings, updateParityEntry, validateManifest } from './manifest-lib.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

/**
 * Read every value supplied for a repeatable CLI option.
 *
 * @param {string} name Option name.
 * @returns {string[]} Option values.
 */
function readOptions(name) {
    return process.argv.flatMap((value, index) => {
        return value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [];
    });
}

const manifestPath = path.resolve(
    readOptions('--manifest')[0] ??
        path.join(repositoryRoot, 'parity/agentscope-python-61cdeae4.json')
);
const status = readOptions('--status')[0];
const sourcePaths = readOptions('--source');
const contractDataPaths = readOptions('--contract-data');
const testPaths = readOptions('--test');
const pythonTests = readOptions('--python-test');
const typescriptTests = readOptions('--typescript-test');
const allTests = process.argv.includes('--all-tests');
const finalize = process.argv.includes('--finalize');

if (
    !status ||
    (sourcePaths.length + contractDataPaths.length + testPaths.length === 0 && !allTests)
) {
    throw new Error(
        'A status and at least one --source, --contract-data, --test, or --all-tests are required.'
    );
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const testMappings = JSON.parse(
    await readFile(path.join(repositoryRoot, 'parity/test-mapping-overrides.json'), 'utf8')
);
const sourceByPath = new Map(manifest.sourceFiles.map(entry => [entry.path, entry]));
const contractDataByPath = new Map(manifest.contractDataFiles.map(entry => [entry.path, entry]));
const testByPath = new Map(manifest.testFiles.map(entry => [entry.path, entry]));

for (const sourcePath of sourcePaths) {
    const entry = sourceByPath.get(sourcePath);
    if (!entry) throw new Error(`Manifest source entry not found: ${sourcePath}.`);
    updateParityEntry(entry, status, pythonTests, typescriptTests);
}

for (const contractDataPath of contractDataPaths) {
    const entry = contractDataByPath.get(contractDataPath);
    if (!entry) {
        throw new Error(`Manifest contract-data entry not found: ${contractDataPath}.`);
    }
    updateParityEntry(entry, status, pythonTests, typescriptTests);
}

synchronizeTestMappings(manifest, testMappings);

for (const testPath of testPaths) {
    const entry = testByPath.get(testPath);
    if (!entry) throw new Error(`Manifest test entry not found: ${testPath}.`);
    updateParityEntry(entry, status, [], typescriptTests);
}

if (allTests) {
    for (const entry of manifest.testFiles) {
        updateParityEntry(entry, status);
    }
}

if (finalize) manifest.requireCompleteParity = true;

const errors = validateManifest(manifest);
if (errors.length > 0) throw new Error(`Updated manifest is invalid:\n${errors.join('\n')}`);

const prettierOptions = (await resolveConfig(manifestPath)) ?? {};
const manifestContent = await format(JSON.stringify(manifest), {
    ...prettierOptions,
    parser: 'json',
});
await writeFile(manifestPath, manifestContent, 'utf8');
process.stdout.write(
    `Updated ${sourcePaths.length} source, ${contractDataPaths.length} contract-data, and ` +
        `${allTests ? manifest.testFiles.length : testPaths.length} test entries to ${status}.\n`
);
