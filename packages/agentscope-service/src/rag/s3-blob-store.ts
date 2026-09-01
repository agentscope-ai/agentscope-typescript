/* eslint-disable jsdoc/require-jsdoc */

import { Readable } from 'node:stream';

import type { AsyncBlobReader, SyncReadable } from './blob-store';
import { BlobStoreBase } from './blob-store';

interface S3Driver {
    upload(bucket: string, key: string, body: Readable): Promise<void>;
    get(bucket: string, key: string): Promise<AsyncIterable<Uint8Array> & { destroy?: () => void }>;
    delete(bucket: string, key: string): Promise<void>;
    head(bucket: string, key: string): Promise<number | null>;
    close(): void;
}

export interface S3BlobStoreOptions {
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    useSsl?: boolean;
    forcePathStyle?: boolean;
    driver?: S3Driver;
}

/** S3-compatible blob store with dynamic optional AWS SDK loading. */
export class S3BlobStore extends BlobStoreBase {
    private driver: S3Driver | null;

    constructor(
        private readonly bucket: string,
        private readonly options: S3BlobStoreOptions = {}
    ) {
        super();
        this.driver = options.driver ?? null;
    }

    override async openStore(): Promise<this> {
        this.driver ??= await createAwsDriver(this.options);
        return this;
    }

    override async closeStore(): Promise<void> {
        this.driver?.close();
        if (!this.options.driver) this.driver = null;
    }

    async writeStream(key: string, stream: SyncReadable): Promise<string> {
        await this.requireDriver().upload(this.bucket, key, Readable.from(syncChunks(stream)));
        return `s3://${this.bucket}/${key}`;
    }

    async open(uri: string): Promise<AsyncBlobReader> {
        const [bucket, key] = S3BlobStore.parseUri(uri);
        const body = await this.requireDriver().get(bucket, key);
        const iterator = body[Symbol.asyncIterator]();
        let pending = Buffer.alloc(0);
        let closed = false;
        const close = async (): Promise<void> => {
            if (closed) return;
            closed = true;
            body.destroy?.();
            await iterator.return?.();
        };
        return {
            async read(size = -1): Promise<Uint8Array> {
                if (closed) throw new Error('Blob reader is closed.');
                if (size < 0) {
                    const chunks = [pending];
                    pending = Buffer.alloc(0);
                    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
                        chunks.push(Buffer.from(chunk));
                    }
                    return Buffer.concat(chunks);
                }
                while (pending.byteLength < size) {
                    const next = await iterator.next();
                    if (next.done) break;
                    pending = Buffer.concat([pending, Buffer.from(next.value)]);
                }
                const result = pending.subarray(0, size);
                pending = pending.subarray(result.byteLength);
                return result;
            },
            close,
            [Symbol.asyncDispose]: close,
        };
    }

    async delete(uri: string): Promise<void> {
        const key = this.keyFromOwnedUri(uri);
        await this.requireDriver().delete(this.bucket, key);
    }

    override async size(uri: string): Promise<number | null> {
        return this.requireDriver().head(this.bucket, this.keyFromOwnedUri(uri));
    }

    async exists(uri: string): Promise<boolean> {
        return (await this.size(uri)) !== null;
    }

    static parseUri(uri: string): [bucket: string, key: string] {
        if (!uri.startsWith('s3://')) throw new Error(`Not an S3 blob URI: ${JSON.stringify(uri)}`);
        const separator = uri.indexOf('/', 's3://'.length);
        if (separator < 0 || separator === 's3://'.length || separator === uri.length - 1) {
            throw new Error(`Malformed S3 blob URI: ${JSON.stringify(uri)}`);
        }
        return [uri.slice('s3://'.length, separator), uri.slice(separator + 1)];
    }

    private keyFromOwnedUri(uri: string): string {
        const [bucket, key] = S3BlobStore.parseUri(uri);
        if (bucket !== this.bucket) {
            throw new Error(
                `Bucket ${JSON.stringify(bucket)} in URI ${JSON.stringify(uri)} does not match configured bucket ${JSON.stringify(this.bucket)}.`
            );
        }
        return key;
    }

    private requireDriver(): S3Driver {
        if (!this.driver) {
            throw new Error('S3BlobStore is not open; call openStore() before blob methods.');
        }
        return this.driver;
    }
}

async function* syncChunks(stream: SyncReadable): AsyncGenerator<Uint8Array> {
    while (true) {
        const chunk = stream.read(1 << 20);
        if (!chunk || chunk.byteLength === 0) return;
        yield chunk;
    }
}

async function createAwsDriver(options: S3BlobStoreOptions): Promise<S3Driver> {
    let clientModule: typeof import('@aws-sdk/client-s3');
    let storageModule: typeof import('@aws-sdk/lib-storage');
    try {
        [clientModule, storageModule] = await Promise.all([
            import('@aws-sdk/client-s3'),
            import('@aws-sdk/lib-storage'),
        ]);
    } catch (error) {
        throw new Error(
            'S3BlobStore requires the optional dependencies @aws-sdk/client-s3 and @aws-sdk/lib-storage.',
            { cause: error }
        );
    }
    const credentials =
        options.accessKeyId && options.secretAccessKey
            ? {
                  accessKeyId: options.accessKeyId,
                  secretAccessKey: options.secretAccessKey,
                  sessionToken: options.sessionToken,
              }
            : undefined;
    const client = new clientModule.S3Client({
        region: options.region,
        endpoint: normalizeEndpoint(options.endpoint, options.useSsl),
        credentials,
        forcePathStyle: options.forcePathStyle,
    });
    return {
        async upload(bucket, key, body) {
            await new storageModule.Upload({
                client,
                params: { Bucket: bucket, Key: key, Body: body },
            }).done();
        },
        async get(bucket, key) {
            const response = await client.send(
                new clientModule.GetObjectCommand({ Bucket: bucket, Key: key })
            );
            if (!response.Body || !(Symbol.asyncIterator in response.Body)) {
                throw new Error(`S3 object s3://${bucket}/${key} did not return a streaming body.`);
            }
            return response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
        },
        async delete(bucket, key) {
            await client.send(new clientModule.DeleteObjectCommand({ Bucket: bucket, Key: key }));
        },
        async head(bucket, key) {
            try {
                const response = await client.send(
                    new clientModule.HeadObjectCommand({ Bucket: bucket, Key: key })
                );
                return response.ContentLength ?? null;
            } catch (error) {
                if (isMissingS3Object(error)) return null;
                throw error;
            }
        },
        close() {
            client.destroy();
        },
    };
}

function normalizeEndpoint(
    endpoint: string | undefined,
    useSsl: boolean | undefined
): string | undefined {
    if (!endpoint || useSsl !== false || /^https?:\/\//.test(endpoint)) return endpoint;
    return `http://${endpoint}`;
}

function isMissingS3Object(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as Record<string, unknown>;
    return (
        value.name === 'NoSuchKey' ||
        value.name === 'NotFound' ||
        (value.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode === 404
    );
}
