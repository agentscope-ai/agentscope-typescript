/* eslint-disable jsdoc/require-jsdoc */

import type { ChildProcess, StdioOptions } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readlinkSync,
    realpathSync,
    statSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { logger } from '../logger';
import { BackendBase, ExecResult } from '../tool';
import type { WorkspaceBaseOptions } from './base';
import { GatewayClient } from './gateway';
import { GATEWAY_PYTHON_SCRIPT } from './gateway-script';
import { SandboxedWorkspaceBase } from './sandboxed';

export const BUBBLEWRAP_WORKDIR = '/workspace';
export const BUBBLEWRAP_TMPDIR = '/tmp';
export const BUBBLEWRAP_CACHE_DIR = '/tmp/.agentscope-cache';
export const BUBBLEWRAP_GATEWAY_HOME = '/workspace/.agentscope';

interface DirectoryIdentity {
    dev: number;
    ino: number;
}

export interface BubblewrapBackendOptions {
    hostWorkdir: string;
    hostTmpdir: string;
    hostCacheDir?: string;
    workdir?: string;
    shareNet?: boolean;
    env?: Record<string, string>;
}

/** Linux Bubblewrap backend with two writable mount roots. */
export class BubblewrapBackend extends BackendBase {
    readonly hostWorkdir: string;
    readonly hostTmpdir: string;
    readonly hostCacheDir: string | null;
    readonly workdir: string;
    readonly shareNet: boolean;
    readonly env: Record<string, string>;
    private readonly identities: Array<[string, string, DirectoryIdentity]>;

    constructor(options: BubblewrapBackendOptions) {
        super();
        if (!options.hostWorkdir.trim()) throw new Error('hostWorkdir must not be empty.');
        if (!options.hostTmpdir.trim()) throw new Error('hostTmpdir must not be empty.');
        if (options.hostCacheDir !== undefined && !options.hostCacheDir.trim()) {
            throw new Error('hostCacheDir must not be empty.');
        }
        this.hostWorkdir = createPrivateDirectory(options.hostWorkdir, 'hostWorkdir');
        this.hostTmpdir = createPrivateDirectory(options.hostTmpdir, 'hostTmpdir');
        if (options.hostCacheDir && isSymbolicLink(options.hostCacheDir)) {
            throw new Error('hostCacheDir must not be a symbolic link.');
        }
        this.hostCacheDir = options.hostCacheDir
            ? createPrivateDirectory(options.hostCacheDir, 'hostCacheDir')
            : null;
        const mounts = [
            this.hostWorkdir,
            this.hostTmpdir,
            ...(this.hostCacheDir ? [this.hostCacheDir] : []),
        ];
        for (let left = 0; left < mounts.length; left += 1) {
            for (let right = left + 1; right < mounts.length; right += 1) {
                if (pathsOverlap(mounts[left], mounts[right])) {
                    throw new Error('Bubblewrap mount sources must not overlap.');
                }
            }
        }
        this.workdir = options.workdir ?? BUBBLEWRAP_WORKDIR;
        this.shareNet = options.shareNet ?? true;
        this.env = { ...(options.env ?? {}) };
        this.identities = [
            ['hostWorkdir', this.hostWorkdir, directoryIdentity(this.hostWorkdir)],
            ['hostTmpdir', this.hostTmpdir, directoryIdentity(this.hostTmpdir)],
        ];
        if (this.hostCacheDir) {
            this.identities.push([
                'hostCacheDir',
                this.hostCacheDir,
                directoryIdentity(this.hostCacheDir),
            ]);
        }
    }

    override async getCwd(): Promise<string> {
        return this.workdir;
    }

    override async expandUser(filePath: string): Promise<string> {
        if (filePath === '~') return BUBBLEWRAP_WORKDIR;
        if (filePath.startsWith('~/')) return `${BUBBLEWRAP_WORKDIR}/${filePath.slice(2)}`;
        return filePath;
    }

    async execShell(
        command: string[],
        options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}
    ): Promise<ExecResult> {
        if (!command.length) {
            return new ExecResult({ exitCode: 127, stderr: Buffer.from('empty command') });
        }
        let child: ChildProcess;
        try {
            child = this.startProcess(command, {
                cwd: options.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            return new ExecResult({ exitCode: 127, stderr: Buffer.from(String(error)) });
        }
        return collectProcess(child, options.timeout, options.signal);
    }

    startProcess(
        command: string[],
        options: { cwd?: string; stdio?: StdioOptions } = {}
    ): ChildProcess {
        const argv = this.buildArgv(command, options.cwd);
        return spawn(argv[0], argv.slice(1), {
            detached: true,
            stdio: options.stdio ?? 'ignore',
            windowsHide: true,
        });
    }

    buildArgv(command: string[], cwd?: string): string[] {
        this.validateMountSources();
        const argv = [
            'bwrap',
            '--die-with-parent',
            '--new-session',
            '--unshare-all',
            '--proc',
            '/proc',
            '--dev',
            '/dev',
            '--bind',
            this.hostWorkdir,
            BUBBLEWRAP_WORKDIR,
            '--bind',
            this.hostTmpdir,
            BUBBLEWRAP_TMPDIR,
            '--tmpfs',
            '/run',
            '--dir',
            '/var',
            '--tmpfs',
            '/var/tmp',
        ];
        if (this.hostCacheDir) {
            argv.push('--bind', this.hostCacheDir, BUBBLEWRAP_CACHE_DIR);
        }
        if (this.shareNet) argv.push('--share-net');
        argv.push(...readOnlySystemMounts());
        const sandboxCwd = cwd ?? this.workdir;
        argv.push('--clearenv');
        for (const [key, value] of Object.entries({
            ...this.env,
            ...baseEnvironment(),
            PWD: sandboxCwd,
        })) {
            argv.push('--setenv', key, value);
        }
        argv.push('--chdir', sandboxCwd, '--', ...command);
        return argv;
    }

    async readFile(filePath: string): Promise<Buffer> {
        const hostPath = await this.resolveExistingHostPath(filePath);
        return fs.readFile(hostPath);
    }

    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
        const hostPath = await this.resolveWritableHostPath(filePath);
        await fs.writeFile(hostPath, data);
    }

    override async writeStream(filePath: string, stream: AsyncIterable<Uint8Array>): Promise<void> {
        const hostPath = await this.resolveWritableHostPath(filePath);
        const handle = await fs.open(hostPath, 'w');
        try {
            for await (const chunk of stream) await handle.write(chunk);
        } finally {
            await handle.close();
        }
    }

    override async fileExists(filePath: string): Promise<boolean> {
        try {
            await this.resolveExistingHostPath(filePath);
            return true;
        } catch {
            return false;
        }
    }

    override async isDirectory(filePath: string): Promise<boolean> {
        try {
            return (await fs.stat(await this.resolveExistingHostPath(filePath))).isDirectory();
        } catch {
            return false;
        }
    }

    override async listDirectory(filePath: string, recursive = false): Promise<string[]> {
        const hostRoot = await this.resolveExistingHostPath(filePath);
        if (!recursive) return fs.readdir(hostRoot);
        const files: string[] = [];
        const visit = async (hostDirectory: string, sandboxDirectory: string): Promise<void> => {
            for (const entry of await fs.readdir(hostDirectory, { withFileTypes: true })) {
                const hostChild = path.join(hostDirectory, entry.name);
                const sandboxChild = path.posix.join(sandboxDirectory, entry.name);
                if (entry.isDirectory()) await visit(hostChild, sandboxChild);
                else if (entry.isFile()) files.push(sandboxChild);
            }
        };
        await visit(hostRoot, path.posix.normalize(filePath));
        return files;
    }

    override async stat(filePath: string) {
        try {
            const hostPath = await this.resolveExistingHostPath(filePath);
            const info = await fs.stat(hostPath);
            return {
                name: path.posix.basename(filePath),
                isDir: info.isDirectory(),
                sizeBytes: info.isDirectory() ? null : info.size,
                mtime: info.mtimeMs / 1000,
            };
        } catch {
            return null;
        }
    }

    override async deletePath(filePath: string): Promise<void> {
        const mapped = this.mapSandboxPath(filePath);
        const relative = path.relative(mapped.root, mapped.hostPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Refusing to delete Bubblewrap mount root: ${filePath}`);
        }
        await fs.rm(mapped.hostPath, { recursive: true, force: true });
    }

    private validateMountSources(): void {
        for (const [label, directory, identity] of this.identities) {
            let current: DirectoryIdentity;
            try {
                current = directoryIdentity(directory);
            } catch {
                throw new Error(`${label} was removed or replaced before execution.`);
            }
            if (current.dev !== identity.dev || current.ino !== identity.ino) {
                throw new Error(`${label} was replaced before execution.`);
            }
        }
    }

    private mapSandboxPath(filePath: string): { root: string; hostPath: string } {
        if (!path.posix.isAbsolute(filePath)) {
            throw new Error(`Sandbox path must be absolute: ${JSON.stringify(filePath)}`);
        }
        const normalized = path.posix.normalize(filePath);
        const mounts: Array<[string, string]> = [
            ...(this.hostCacheDir
                ? ([[BUBBLEWRAP_CACHE_DIR, this.hostCacheDir]] as Array<[string, string]>)
                : []),
            [BUBBLEWRAP_WORKDIR, this.hostWorkdir],
            [BUBBLEWRAP_TMPDIR, this.hostTmpdir],
        ];
        for (const [sandboxRoot, hostRoot] of mounts) {
            if (normalized === sandboxRoot || normalized.startsWith(`${sandboxRoot}/`)) {
                const suffix = path.posix.relative(sandboxRoot, normalized);
                return { root: hostRoot, hostPath: path.join(hostRoot, ...suffix.split('/')) };
            }
        }
        throw new Error(`Bubblewrap file access is limited to /workspace and /tmp: ${filePath}`);
    }

    private async resolveExistingHostPath(filePath: string): Promise<string> {
        const mapped = this.mapSandboxPath(filePath);
        const resolved = await fs.realpath(mapped.hostPath);
        assertInside(mapped.root, resolved, filePath);
        return resolved;
    }

    private async resolveWritableHostPath(filePath: string): Promise<string> {
        const mapped = this.mapSandboxPath(filePath);
        let ancestor = path.dirname(mapped.hostPath);
        while (!existsSync(ancestor)) {
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            ancestor = parent;
        }
        const resolvedAncestor = await fs.realpath(ancestor);
        assertInside(mapped.root, resolvedAncestor, filePath);
        await fs.mkdir(path.dirname(mapped.hostPath), { recursive: true });
        const resolvedParent = await fs.realpath(path.dirname(mapped.hostPath));
        assertInside(mapped.root, resolvedParent, filePath);
        if (isSymbolicLink(mapped.hostPath))
            throw new Error(`Refusing symbolic-link write: ${filePath}`);
        return path.join(resolvedParent, path.basename(mapped.hostPath));
    }
}

export interface BubblewrapWorkspaceOptions extends WorkspaceBaseOptions {
    hostWorkdir?: string;
    hostCacheDir?: string;
    gatewayPort?: number | null;
    shareNet?: boolean;
    env?: Record<string, string>;
    extraPip?: string[];
    instructions?: string;
}

const DEFAULT_BUBBLEWRAP_INSTRUCTIONS = `<workspace>
You have a Bubblewrap-based Linux workspace. All tool calls execute
inside the sandbox at \`\`{workdir}\`\`.

Layout:

\`\`\`
{workdir}/
|-- data/       # offloaded multimodal files
|-- skills/     # reusable skills
\`-- sessions/   # session context and tool results
\`\`\`
</workspace>`;

/** Linux Bubblewrap workspace with per-launch gateway credentials. */
export class BubblewrapWorkspace extends SandboxedWorkspaceBase {
    readonly workdir = BUBBLEWRAP_WORKDIR;
    gatewayPort: number | null;
    protected readonly gatewayHome = BUBBLEWRAP_GATEWAY_HOME;
    readonly shareNet: boolean;
    readonly env: Record<string, string>;
    readonly extraPip: string[];
    readonly instructions: string;
    hostWorkdir: string;
    private readonly configuredHostWorkdir: string | null;
    private readonly configuredHostCacheDir: string | null;
    private readonly configuredGatewayPort: number | null;
    private hostTmpdir: string | null = null;
    private hostCacheDir: string | null = null;
    private ownsWorkdir = false;
    private ownsCacheDir = false;
    private gatewayProcess: ChildProcess | null = null;
    private gatewayToken = '';
    private gatewayNonce = '';

    constructor(options: BubblewrapWorkspaceOptions = {}) {
        validateGatewayPort(options.gatewayPort ?? null);
        if (options.shareNet === false) {
            throw new Error('BubblewrapWorkspace currently requires shareNet=true.');
        }
        if (options.hostWorkdir !== undefined && !options.hostWorkdir.trim()) {
            throw new Error('hostWorkdir must not be empty.');
        }
        if (options.hostCacheDir !== undefined && !options.hostCacheDir.trim()) {
            throw new Error('hostCacheDir must not be empty.');
        }
        super(options);
        this.configuredHostWorkdir = options.hostWorkdir ? path.resolve(options.hostWorkdir) : null;
        this.configuredHostCacheDir = options.hostCacheDir
            ? path.resolve(options.hostCacheDir)
            : null;
        this.configuredGatewayPort = options.gatewayPort ?? null;
        this.gatewayPort = this.configuredGatewayPort;
        this.hostWorkdir = this.configuredHostWorkdir ?? '';
        this.shareNet = true;
        this.env = { ...(options.env ?? {}) };
        this.extraPip = [...(options.extraPip ?? [])];
        this.instructions = options.instructions ?? DEFAULT_BUBBLEWRAP_INSTRUCTIONS;
        this.rotateGatewayCredentials();
    }

    override get isPersistent(): boolean {
        return this.configuredHostWorkdir !== null;
    }

    async getInstructions(): Promise<string> {
        return this.instructions.replaceAll('{workdir}', this.workdir);
    }

    override async initialize(): Promise<void> {
        try {
            await super.initialize();
        } catch (error) {
            await this.close().catch(cleanupError =>
                logger.warning('Bubblewrap cleanup failed: %s', String(cleanupError))
            );
            throw error;
        }
    }

    protected async provisionBackend(): Promise<void> {
        if (process.platform !== 'linux') throw new Error('BubblewrapWorkspace requires Linux.');
        await probeBubblewrap();
        if (!this.configuredHostWorkdir) {
            this.hostWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-bwrap-work-'));
            this.ownsWorkdir = true;
        } else {
            this.hostWorkdir = createPrivateDirectory(this.configuredHostWorkdir, 'hostWorkdir');
        }
        this.hostTmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-bwrap-tmp-'));
        if (this.configuredHostCacheDir) {
            this.hostCacheDir = resolveCacheDirectory(
                this.hostWorkdir,
                this.configuredHostCacheDir
            );
        } else if (this.configuredHostWorkdir) {
            const cacheRoot = path.join(path.dirname(this.hostWorkdir), '.agentscope-bwrap-cache');
            mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
            const key = createHash('blake2b512')
                .update(this.hostWorkdir)
                .digest('hex')
                .slice(0, 32);
            this.hostCacheDir = resolveCacheDirectory(this.hostWorkdir, path.join(cacheRoot, key));
        } else {
            this.hostCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-bwrap-cache-'));
            this.ownsCacheDir = true;
        }
        this.backend = new BubblewrapBackend({
            hostWorkdir: this.hostWorkdir,
            hostTmpdir: this.hostTmpdir,
            hostCacheDir: this.hostCacheDir,
            shareNet: true,
            env: this.env,
        });
    }

    protected async teardownBackend(): Promise<void> {
        await this.stopGatewayProcess().catch(error =>
            logger.warning('Failed to stop Bubblewrap gateway: %s', String(error))
        );
        this.backend = null;
        if (this.hostTmpdir) await fs.rm(this.hostTmpdir, { recursive: true, force: true });
        if (this.ownsCacheDir && this.hostCacheDir) {
            await fs.rm(this.hostCacheDir, { recursive: true, force: true });
        }
        if (this.ownsWorkdir && this.hostWorkdir) {
            await fs.rm(this.hostWorkdir, { recursive: true, force: true });
        }
        this.hostTmpdir = null;
        this.hostCacheDir = null;
        if (this.ownsWorkdir) this.hostWorkdir = '';
        this.ownsWorkdir = false;
        this.ownsCacheDir = false;
    }

    protected override get gatewayAuthToken(): string {
        return this.gatewayToken;
    }

    protected override get gatewayInstanceNonce(): string {
        return this.gatewayNonce;
    }

    protected override bootstrapCommands(): string[] {
        const packages = ['mcp<2.0.0', 'uvicorn', 'fastapi', 'httpx', ...this.extraPip]
            .map(quoteShell)
            .join(' ');
        const binDirectory = `${this.gatewayHome}/bin`;
        const uvPath = `${binDirectory}/uv`;
        const ripgrepPath = `${binDirectory}/rg`;
        return [
            `mkdir -p ${quoteShell(binDirectory)}`,
            `if ! ${quoteShell(uvPath)} --version >/dev/null 2>&1; then rm -f ${quoteShell(uvPath)}; ${this.installUvScript(binDirectory)}; fi`,
            `if ! ${quoteShell(this.gatewayPython)} --version >/dev/null 2>&1; then rm -rf ${quoteShell(this.gatewayVenv)}; ${quoteShell(uvPath)} venv ${quoteShell(this.gatewayVenv)}; fi`,
            `${quoteShell(uvPath)} pip install --python ${quoteShell(this.gatewayPython)} ${packages}`,
            `if ! ${quoteShell(ripgrepPath)} --version >/dev/null 2>&1; then rm -f ${quoteShell(ripgrepPath)}; ${this.installRipgrepScript()}; fi`,
            `${quoteShell(ripgrepPath)} --version`,
            `${quoteShell(uvPath)} pip install --python ${quoteShell(this.gatewayPython)} --no-deps 'agentscope'`,
        ];
    }

    protected override async setupMcpGateway(): Promise<void> {
        const backend = this.getBackend() as BubblewrapBackend;
        if (!(await this.bootstrapIsReady())) {
            for (const command of this.bootstrapCommands()) {
                const result = await backend.execShell(['sh', '-c', command], {
                    timeout: this.bootstrapCommandTimeout,
                });
                if (!result.ok()) {
                    throw new Error(
                        `Bubblewrap bootstrap failed (exit ${result.exitCode}) for ` +
                            `${JSON.stringify(command)}\nstderr: ${result.stderr.toString('utf8')}` +
                            `\nstdout: ${result.stdout.toString('utf8')}`
                    );
                }
            }
        }
        // Refresh runtime code even when a persistent bootstrap remains usable.
        await backend.writeFile(this.gatewayScript, Buffer.from(GATEWAY_PYTHON_SCRIPT));

        const attempts = this.configuredGatewayPort === null ? 3 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (this.configuredGatewayPort === null) this.gatewayPort = await allocatePort();
            if (this.gatewayPort === null) throw new Error('Gateway port was not allocated.');
            await this.stopGatewayProcess();
            this.rotateGatewayCredentials();
            const command =
                `exec ${quoteShell(this.gatewayPython)} -I -u ${quoteShell(this.gatewayScript)} ` +
                `--port ${this.gatewayPort} --auth-token ${quoteShell(this.gatewayToken)} ` +
                `--instance-nonce ${quoteShell(this.gatewayNonce)} > ${quoteShell(this.gatewayLog)} 2>&1`;
            this.gatewayProcess = backend.startProcess(['sh', '-c', command], {
                cwd: BUBBLEWRAP_WORKDIR,
            });
            this.gateway = new GatewayClient({
                backend,
                gatewayPort: this.gatewayPort,
                timeout: 30,
                gatewayLogPath: this.gatewayLog,
                authToken: this.gatewayToken,
                instanceNonce: this.gatewayNonce,
            });
            if (await this.waitGatewayHealth(30_000)) return;
            await this.stopGatewayProcess();
        }
        throw new Error('Bubblewrap gateway did not become healthy within 30s.');
    }

    protected async bootstrapIsReady(): Promise<boolean> {
        if (!this.backend) return false;
        const result = await this.backend.execShell(
            [
                'sh',
                '-c',
                'test -f "$1" && test -x "$2" && "$2" --version >/dev/null 2>&1 && ' +
                    '"$2" -I -c \'import agentscope, fastapi, uvicorn, mcp\' ' +
                    '>/dev/null 2>&1 && "$3" --version >/dev/null 2>&1 && ' +
                    '"$4" --version >/dev/null 2>&1',
                'sh',
                this.gatewayScript,
                this.gatewayPython,
                `${this.gatewayHome}/bin/uv`,
                `${this.gatewayHome}/bin/rg`,
            ],
            { timeout: 30 }
        );
        return result.ok();
    }

    protected installUvScript(binDirectory: string): string {
        return (
            'set -eu; tmp_installer=$(mktemp); ' +
            'cleanup_installer() { rm -f "$tmp_installer"; }; ' +
            'trap cleanup_installer EXIT INT TERM; ' +
            'curl -LsSf --retry 5 --retry-delay 2 --retry-all-errors ' +
            '--connect-timeout 15 --max-time 60 --retry-max-time 180 ' +
            '-o "$tmp_installer" https://astral.sh/uv/install.sh; ' +
            `env UV_INSTALL_DIR=${quoteShell(binDirectory)} ` +
            'INSTALLER_NO_MODIFY_PATH=1 sh "$tmp_installer"; ' +
            'rm -f "$tmp_installer"; trap - EXIT INT TERM'
        );
    }

    protected installRipgrepScript(): string {
        const binDirectory = quoteShell(`${this.gatewayHome}/bin`);
        const cacheDirectory = quoteShell(`${BUBBLEWRAP_CACHE_DIR}/ripgrep`);
        const version = '14.1.0';
        const baseUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${version}`;
        const curl =
            'curl -fL --retry 5 --retry-delay 2 --retry-all-errors ' +
            '--connect-timeout 15 --max-time 90 --retry-max-time 180';
        const x64Hash = 'f84757b07f425fe5cf11d87df6644691c644a5cd2348a2c670894272999d3ba7';
        const arm64Hash = 'c8c210b99844fbf16b7a36d1c963e8351bca5ff2dd7c788f5fba4ac18ba8c60d';
        return (
            'set -eu; arch=$(uname -m); case "$arch" in ' +
            `x86_64|amd64) asset=ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz; ` +
            `sha256=${x64Hash} ;; ` +
            `aarch64|arm64) asset=ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz; ` +
            `sha256=${arm64Hash} ;; ` +
            '*) echo "unsupported ripgrep architecture: $arch" >&2; exit 1 ;; esac; ' +
            `mkdir -p ${cacheDirectory} ${binDirectory}; cd ${cacheDirectory}; ` +
            'if ! printf "%s  %s\\n" "$sha256" "$asset" | ' +
            'sha256sum -c - >/dev/null 2>&1; then ' +
            'tmp_asset=$(mktemp "${asset}.tmp.XXXXXX"); ' +
            'cleanup_asset() { rm -f "$tmp_asset"; }; ' +
            'trap cleanup_asset EXIT INT TERM; ' +
            `${curl} -o "$tmp_asset" ${quoteShell(baseUrl)}/"$asset"; ` +
            'printf "%s  %s\\n" "$sha256" "$tmp_asset" | sha256sum -c -; ' +
            'mv -f "$tmp_asset" "$asset"; trap - EXIT INT TERM; fi; ' +
            'tmp=$(mktemp -d); tar -xzf "$asset" -C "$tmp"; ' +
            `tmp_rg=$(mktemp ${binDirectory}/.rg.tmp.XXXXXX); ` +
            'cleanup_rg() { rm -f "$tmp_rg"; }; trap cleanup_rg EXIT INT TERM; ' +
            'cp "$tmp"/ripgrep-*/rg "$tmp_rg"; chmod +x "$tmp_rg"; ' +
            `mv -f "$tmp_rg" ${binDirectory}/rg; ` +
            'trap - EXIT INT TERM; rm -rf "$tmp"'
        );
    }

    rotateGatewayCredentials(): void {
        this.gatewayToken = randomBytes(32).toString('base64url');
        this.gatewayNonce = randomBytes(32).toString('base64url');
    }

    static async allocateGatewayPort(): Promise<number> {
        return allocatePort();
    }

    private async waitGatewayHealth(timeoutMs: number): Promise<boolean> {
        if (!this.gateway) return false;
        const deadline = Date.now() + timeoutMs;
        let delay = 100;
        while (Date.now() < deadline) {
            if (this.gatewayProcess?.exitCode !== null) return false;
            if (await this.gateway.health()) return true;
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(Math.round(delay * 1.5), 1000);
        }
        return this.gateway.health();
    }

    private async stopGatewayProcess(): Promise<void> {
        const child = this.gatewayProcess;
        if (!child) return;
        await terminateProcessTree(child, 5000);
        if (child.exitCode !== null) this.gatewayProcess = null;
    }
}

async function collectProcess(
    child: ChildProcess,
    timeoutSeconds?: number,
    signal?: AbortSignal
): Promise<ExecResult> {
    return new Promise(resolve => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;
        const finish = (result: ExecResult): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            resolve(result);
        };
        const abort = (): void => {
            void terminateProcessTree(child, 1000).then(() =>
                finish(new ExecResult({ exitCode: -1, stderr: Buffer.from('aborted') }))
            );
        };
        child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
        child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
        child.on('error', error =>
            finish(new ExecResult({ exitCode: 127, stderr: Buffer.from(error.message) }))
        );
        child.on('close', code =>
            finish(
                new ExecResult({
                    exitCode: code ?? 0,
                    stdout: Buffer.concat(stdout),
                    stderr: Buffer.concat(stderr),
                })
            )
        );
        signal?.addEventListener('abort', abort, { once: true });
        const timer = timeoutSeconds
            ? setTimeout(() => {
                  void terminateProcessTree(child, 1000).then(() =>
                      finish(new ExecResult({ exitCode: -1, stderr: Buffer.from('timed out') }))
                  );
              }, timeoutSeconds * 1000)
            : undefined;
        if (signal?.aborted) abort();
    });
}

export async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
    if (child.exitCode !== null) return;
    try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
    } catch {
        child.kill('SIGTERM');
    }
    const exited = await Promise.race([
        new Promise<boolean>(resolve => child.once('close', () => resolve(true))),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (exited) return;
    try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
}

async function probeBubblewrap(): Promise<void> {
    const result = spawnSync(
        'bwrap',
        [
            '--die-with-parent',
            '--new-session',
            '--unshare-all',
            '--share-net',
            '--ro-bind',
            '/',
            '/',
            '--proc',
            '/proc',
            '--dev',
            '/dev',
            '--',
            'true',
        ],
        { timeout: 5000 }
    );
    if (result.error || result.status !== 0) {
        throw new Error(
            `BubblewrapWorkspace requires Linux and a working bwrap executable: ${String(result.error ?? result.stderr)}`
        );
    }
}

function createPrivateDirectory(directory: string, label: string): string {
    const absolute = path.resolve(directory);
    const existed = existsSync(absolute);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (!statSync(absolute).isDirectory() || isSymbolicLink(absolute)) {
        throw new Error(`${label} must be a real directory.`);
    }
    if (!existed) chmodSync(absolute, 0o700);
    return realpathSync(absolute);
}

function resolveCacheDirectory(workdir: string, cacheDir: string): string {
    if (isSymbolicLink(cacheDir)) throw new Error('hostCacheDir must not be a symbolic link.');
    const resolved = createPrivateDirectory(cacheDir, 'hostCacheDir');
    if (pathsOverlap(workdir, resolved))
        throw new Error('hostCacheDir must not overlap hostWorkdir.');
    return resolved;
}

function directoryIdentity(directory: string): DirectoryIdentity {
    if (isSymbolicLink(directory) || !statSync(directory).isDirectory())
        throw new Error('not directory');
    const value = statSync(directory, { bigint: false });
    return { dev: value.dev, ino: value.ino };
}

function pathsOverlap(left: string, right: string): boolean {
    const relative = path.relative(realpathSync(left), realpathSync(right));
    const inverse = path.relative(realpathSync(right), realpathSync(left));
    return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative)) ||
        (!inverse.startsWith('..') && !path.isAbsolute(inverse))
    );
}

function isSymbolicLink(target: string): boolean {
    try {
        return lstatSync(target).isSymbolicLink();
    } catch {
        return false;
    }
}

function assertInside(root: string, candidate: string, original: string): void {
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Path escapes writable Bubblewrap mounts: ${original}`);
    }
}

function baseEnvironment(): Record<string, string> {
    return {
        HOME: BUBBLEWRAP_WORKDIR,
        TMPDIR: BUBBLEWRAP_TMPDIR,
        UV_CACHE_DIR: `${BUBBLEWRAP_CACHE_DIR}/uv`,
        XDG_CACHE_HOME: `${BUBBLEWRAP_CACHE_DIR}/xdg`,
        PIP_CACHE_DIR: `${BUBBLEWRAP_CACHE_DIR}/pip`,
        PATH: `${BUBBLEWRAP_GATEWAY_HOME}/.venv/bin:${BUBBLEWRAP_GATEWAY_HOME}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONUNBUFFERED: '1',
    };
}

function readOnlySystemMounts(): string[] {
    const argv: string[] = [];
    if (existsSync('/usr')) argv.push('--ro-bind', '/usr', '/usr');
    argv.push('--dir', '/etc');
    for (const target of [
        '/etc/resolv.conf',
        '/etc/hosts',
        '/etc/nsswitch.conf',
        '/etc/passwd',
        '/etc/group',
        '/etc/alternatives',
        '/etc/ssl',
        '/etc/pki',
        '/etc/ca-certificates',
    ]) {
        if (existsSync(target)) argv.push('--ro-bind', target, target);
    }
    for (const target of ['/bin', '/sbin', '/lib', '/lib64']) {
        if (!existsSync(target)) continue;
        if (isSymbolicLink(target)) argv.push('--symlink', readlinkSync(target), target);
        else argv.push('--ro-bind', target, target);
    }
    return argv;
}

function validateGatewayPort(port: number | null): void {
    if (port === null) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('gatewayPort must be null or an integer from 1 to 65535.');
    }
}

async function allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

function quoteShell(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
