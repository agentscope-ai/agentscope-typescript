/* eslint-disable jsdoc/require-jsdoc */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { GATEWAY_PYTHON_SCRIPT } from './gateway-script';
import { GLOB_HELPER_PYTHON_SCRIPT } from './glob-helper-script';

export const DEFAULT_DOCKER_BASE_IMAGE = 'python:3.11-slim';
export const DEFAULT_DOCKER_GATEWAY_PORT = 5600;
export const DOCKER_CONTAINER_WORKDIR = '/workspace';
export const DOCKER_GATEWAY_HOME = '/root/.agentscope';
export const DOCKER_IMAGE_REPOSITORY = 'agentscope-workspace';

export interface RenderDockerfileOptions {
    baseImage?: string;
    gatewayHome?: string;
    containerWorkdir?: string;
    nodeVersion?: string | null;
    installAgentscopeBlock?: string;
}

export interface DockerBuildContext {
    directory: string;
    tag: string;
    copyFiles: Record<string, Buffer>;
}

const NODE_COPY_BLOCK = `COPY --from=node_stage /usr/local/bin/node /usr/local/bin/node
COPY --from=node_stage /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx`;

export function renderDockerfile(options: RenderDockerfileOptions = {}): string {
    const baseImage = options.baseImage ?? DEFAULT_DOCKER_BASE_IMAGE;
    const gatewayHome = options.gatewayHome ?? DOCKER_GATEWAY_HOME;
    const containerWorkdir = options.containerWorkdir ?? DOCKER_CONTAINER_WORKDIR;
    const installAgentscopeBlock = (options.installAgentscopeBlock ?? '').trimEnd();
    const nodeFrom = options.nodeVersion
        ? `FROM node:${options.nodeVersion}-slim AS node_stage\n`
        : '';
    const nodeCopy = options.nodeVersion ? `${NODE_COPY_BLOCK}\n\n` : '';
    return `# syntax=docker/dockerfile:1.6
${nodeFrom}FROM ${baseImage}

RUN apt-get update \\
 && apt-get install -y --no-install-recommends curl ca-certificates ripgrep \\
 && rm -rf /var/lib/apt/lists/* \\
 && curl -LsSf https://astral.sh/uv/install.sh \\
        | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh

${nodeCopy}ENV UV_PROJECT_ENVIRONMENT=${gatewayHome}/.venv \\
    UV_LINK_MODE=copy \\
    PATH=${gatewayHome}/.venv/bin:$PATH
WORKDIR ${gatewayHome}
RUN uv venv ${gatewayHome}/.venv

COPY requirements.txt ${gatewayHome}/requirements.txt
RUN uv pip install -r ${gatewayHome}/requirements.txt

${installAgentscopeBlock}
COPY _mcp_gateway_app.py ${gatewayHome}/_mcp_gateway_app.py
COPY _glob_helper.py ${gatewayHome}/_glob_helper.py

WORKDIR ${containerWorkdir}
`;
}

export function computeDockerImageTag(
    dockerfileText: string,
    copyFiles: Record<string, Uint8Array>
): string {
    const hash = createHash('sha256');
    hash.update(Buffer.from('DOCKERFILE\0'));
    hash.update(dockerfileText);
    for (const name of Object.keys(copyFiles).sort()) {
        hash.update(Buffer.from('\0FILE\0'));
        hash.update(name);
        hash.update(Buffer.from('\0'));
        hash.update(copyFiles[name]);
    }
    return `${DOCKER_IMAGE_REPOSITORY}:${hash.digest('hex').slice(0, 12)}`;
}

export async function prepareDockerBuildContext(
    options: Omit<RenderDockerfileOptions, 'installAgentscopeBlock'> & {
        extraPip?: string[];
    } = {}
): Promise<DockerBuildContext> {
    const dockerfile = renderDockerfile({
        ...options,
        installAgentscopeBlock: 'RUN uv pip install "agentscope"',
    });
    const requirements = ['mcp<2.0.0', 'uvicorn', 'fastapi', 'httpx', ...(options.extraPip ?? [])]
        .join('\n')
        .concat('\n');
    const copyFiles: Record<string, Buffer> = {
        'requirements.txt': Buffer.from(requirements),
        '_mcp_gateway_app.py': Buffer.from(GATEWAY_PYTHON_SCRIPT),
        '_glob_helper.py': Buffer.from(GLOB_HELPER_PYTHON_SCRIPT),
    };
    const tag = computeDockerImageTag(dockerfile, copyFiles);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'as-ws-build-'));
    await Promise.all([
        fs.writeFile(path.join(directory, 'Dockerfile'), dockerfile),
        ...Object.entries(copyFiles).map(([name, content]) =>
            fs.writeFile(path.join(directory, name), content)
        ),
    ]);
    return { directory, tag, copyFiles };
}
