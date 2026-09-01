import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ALLOWED_STATUSES = new Set(['mapped', 'contracted', 'implemented', 'verified']);
const STATUS_ORDER = [...ALLOWED_STATUSES];

const CORE_ROOT = 'packages/agentscope/src';
const SERVICE_ROOT = 'packages/agentscope-service/src';

/**
 * List tracked files below a repository path in stable order.
 *
 * @param {string} repositoryRoot Git repository root.
 * @param {string} repositoryPath Repository-relative path.
 * @returns {string[]} Absolute tracked file paths.
 */
export function listTrackedFiles(repositoryRoot, repositoryPath) {
    const output = execFileSync(
        'git',
        ['-C', repositoryRoot, 'ls-files', '-z', '--', repositoryPath],
        { encoding: 'utf8' }
    );
    return output
        .split('\0')
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map(filePath => path.join(repositoryRoot, filePath));
}

/**
 * Calculate a SHA-256 digest for a buffer.
 *
 * @param {Buffer} content File content.
 * @returns {string} Hex digest.
 */
export function hashContent(content) {
    return createHash('sha256').update(content).digest('hex');
}

/**
 * Calculate a stable aggregate digest from path/content pairs.
 *
 * @param {{ path: string; content: Buffer }[]} files Files to hash.
 * @returns {string} Hex digest.
 */
export function hashFileSet(files) {
    const digest = createHash('sha256');
    const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));

    for (const file of sortedFiles) {
        digest.update(file.path);
        digest.update('\0');
        digest.update(file.content);
    }

    return digest.digest('hex');
}

/**
 * Convert an operating-system path to a repository path.
 *
 * @param {string} value Path to normalize.
 * @returns {string} POSIX-style path.
 */
export function toRepositoryPath(value) {
    return value.split(path.sep).join('/');
}

/**
 * Resolve a Python source file to its logical module.
 *
 * @param {string} sourcePath Repository-relative source path.
 * @returns {string} Python module group.
 */
export function sourceModule(sourcePath) {
    const relativePath = sourcePath.replace(/^src\/agentscope\/?/, '');
    if (!relativePath.includes('/')) {
        return 'root';
    }
    const firstPart = relativePath.split('/')[0];

    if (!firstPart) {
        return 'root';
    }

    return firstPart;
}

/**
 * Map a Python source file to its planned TypeScript implementation area.
 *
 * @param {string} sourcePath Repository-relative source path.
 * @returns {string} TypeScript target directory or file.
 */
export function typescriptTarget(sourcePath) {
    const relativePath = sourcePath.replace(/^src\/agentscope\/?/, '');
    const parts = relativePath.split('/');
    const firstPart = parts[0];

    if (firstPart === 'app') {
        const appPath = parts.slice(1, -1).join('/').replaceAll('_', '-');
        return appPath ? `${SERVICE_ROOT}/${appPath}` : SERVICE_ROOT;
    }

    if (firstPart === '__init__.py') {
        return `${CORE_ROOT}/index.ts`;
    }

    if (firstPart === '_logging.py') {
        return `${CORE_ROOT}/logger`;
    }

    if (firstPart === '_version.py') {
        return `${CORE_ROOT}/version.ts`;
    }

    if (firstPart === 'types') {
        return `${CORE_ROOT}/type`;
    }

    if (!relativePath.includes('/')) {
        return 'packages/agentscope';
    }

    const moduleName = firstPart.replace(/^_/, '').replaceAll('_', '-').replace(/\.py$/, '');
    return `${CORE_ROOT}/${moduleName}`;
}

/**
 * Infer the broad behavior area represented by a Python test file.
 *
 * @param {string} testPath Repository-relative test path.
 * @returns {string} Behavior area.
 */
export function testArea(testPath) {
    const filename = path.posix.basename(testPath).replace(/\.py$/, '');
    const normalized = filename.replace(/^test_/, '').replace(/_test$/, '');
    return normalized.split('_')[0] || 'root';
}

/**
 * Read and describe selected files relative to a repository root.
 *
 * @param {string} repositoryRoot Python repository root.
 * @param {string[]} absolutePaths Files to describe.
 * @returns {Promise<{ path: string; sha256: string; content: Buffer }[]>} File descriptions.
 */
export async function describeFiles(repositoryRoot, absolutePaths) {
    return Promise.all(
        absolutePaths.map(async filePath => {
            const content = await readFile(filePath);
            return {
                path: toRepositoryPath(path.relative(repositoryRoot, filePath)),
                sha256: hashContent(content),
                content,
            };
        })
    );
}

/**
 * Validate the static structure and invariants of a parity manifest.
 *
 * @param {unknown} value Parsed manifest value.
 * @returns {string[]} Validation errors.
 */
export function validateManifest(value) {
    const errors = [];
    if (!value || typeof value !== 'object') {
        return ['Manifest must be an object.'];
    }

    const manifest = value;
    if (manifest.schemaVersion !== 1) {
        errors.push('schemaVersion must be 1.');
    }
    if (!/^[0-9a-f]{40}$/.test(manifest.pythonCommit ?? '')) {
        errors.push('pythonCommit must be a full Git SHA.');
    }

    const collections = [
        ['sourceFiles', manifest.sourceFiles],
        ['contractDataFiles', manifest.contractDataFiles],
        ['testFiles', manifest.testFiles],
    ];

    for (const [name, entries] of collections) {
        if (!Array.isArray(entries)) {
            errors.push(`${name} must be an array.`);
            continue;
        }

        const paths = new Set();
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') {
                errors.push(`${name} contains a non-object entry.`);
                continue;
            }
            if (typeof entry.path !== 'string' || !entry.path) {
                errors.push(`${name} contains an entry without a path.`);
            } else if (paths.has(entry.path)) {
                errors.push(`${name} contains duplicate path ${entry.path}.`);
            } else {
                paths.add(entry.path);
            }
            if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
                errors.push(`${name} contains an invalid digest for ${entry.path ?? '<unknown>'}.`);
            }
        }
    }

    for (const entry of [
        ...(Array.isArray(manifest.sourceFiles) ? manifest.sourceFiles : []),
        ...(Array.isArray(manifest.contractDataFiles) ? manifest.contractDataFiles : []),
    ]) {
        if (!ALLOWED_STATUSES.has(entry.status)) {
            errors.push(`Invalid parity status ${entry.status} for ${entry.path}.`);
        }
        if (typeof entry.typescriptTarget !== 'string' || !entry.typescriptTarget) {
            errors.push(`Missing TypeScript target for ${entry.path}.`);
        }
    }

    const summary = manifest.summary;
    if (!summary || typeof summary !== 'object') {
        errors.push('summary must be an object.');
    } else {
        const expectedCounts = {
            sourceFiles: Array.isArray(manifest.sourceFiles) ? manifest.sourceFiles.length : 0,
            contractDataFiles: Array.isArray(manifest.contractDataFiles)
                ? manifest.contractDataFiles.length
                : 0,
            testFiles: Array.isArray(manifest.testFiles) ? manifest.testFiles.length : 0,
        };
        for (const [name, count] of Object.entries(expectedCounts)) {
            if (summary[name]?.count !== count) {
                errors.push(`summary.${name}.count must equal ${count}.`);
            }
            if (!/^[0-9a-f]{64}$/.test(summary[name]?.sha256 ?? '')) {
                errors.push(`summary.${name}.sha256 must be a SHA-256 digest.`);
            }
        }
    }

    return errors;
}

/**
 * Advance one manifest entry and merge its test references.
 *
 * @param {object} entry Manifest source entry.
 * @param {string} status New parity status.
 * @param {string[]} pythonTests Python test paths.
 * @param {string[]} typescriptTests TypeScript test paths.
 */
export function updateParityEntry(entry, status, pythonTests = [], typescriptTests = []) {
    if (!ALLOWED_STATUSES.has(status)) {
        throw new Error(`Unsupported parity status ${status}.`);
    }
    const currentIndex = STATUS_ORDER.indexOf(entry.status);
    const nextIndex = STATUS_ORDER.indexOf(status);
    if (currentIndex === -1 || nextIndex < currentIndex) {
        throw new Error(`Cannot move ${entry.path} from ${entry.status} to ${status}.`);
    }

    entry.status = status;
    if ('pythonTests' in entry) {
        entry.pythonTests = [...new Set([...(entry.pythonTests ?? []), ...pythonTests])].sort();
    }
    if ('typescriptTests' in entry) {
        entry.typescriptTests = [
            ...new Set([...(entry.typescriptTests ?? []), ...typescriptTests]),
        ].sort();
    }
}
