/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-explicit-any */

declare module 'better-sqlite3' {
    const Database: unknown;
    export default Database;
}

declare module '@aws-sdk/client-s3' {
    export class S3Client {
        constructor(options: Record<string, unknown>);
        send(command: unknown): Promise<Record<string, any>>;
        destroy(): void;
    }
    export class GetObjectCommand {
        constructor(options: Record<string, unknown>);
    }
    export class DeleteObjectCommand {
        constructor(options: Record<string, unknown>);
    }
    export class HeadObjectCommand {
        constructor(options: Record<string, unknown>);
    }
}

declare module '@aws-sdk/lib-storage' {
    export class Upload {
        constructor(options: Record<string, unknown>);
        done(): Promise<void>;
    }
}
