/**
 * S3-compatible storage provider (AWS S3, MinIO, Spaces, R2, ...).
 *
 * Uses the AWS SDK's SigV4 signer — never custom crypto. Signed URLs are
 * the SDK's standard `GetObjectCommand` presigners with real expiry.
 *
 * **Production note:** mock-testable. The client is wrapped behind a tiny
 * `S3Ops` interface so tests inject fakes instead of network calls.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  assertObjectKey,
  checkPut,
  type FileValidationRules,
  type StorageProvider,
} from "./validation.js";

export interface S3Ops {
  putObject(input: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  headExists(input: { bucket: string; key: string }): Promise<boolean>;
  presignGet(input: { bucket: string; key: string; expiresIn: number }): Promise<string>;
}

/** Default S3Ops over the AWS SDK (SigV4 signing by the SDK). */
export function awsS3Ops(client: S3Client): S3Ops {
  return {
    async putObject(input: { bucket: string; key: string; body: Buffer; contentType: string }) {
      await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
    },
    async deleteObject(input: { bucket: string; key: string }) {
      await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
    },
    async headExists(input: { bucket: string; key: string }): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }));
        return true;
      } catch {
        return false;
      }
    },
    async presignGet(input: { bucket: string; key: string; expiresIn: number }): Promise<string> {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }),
        { expiresIn: input.expiresIn },
      );
    },
  };
}

export interface S3Options {
  bucket: string;
  /** S3 endpoint (MinIO/R2/S3) — omit for AWS. */
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  validation?: FileValidationRules;
  /** Fake ops for tests (skips the AWS SDK entirely). */
  ops?: S3Ops;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";
  readonly #bucket: string;
  readonly #validation: FileValidationRules | undefined;
  readonly #ops: S3Ops;
  readonly #client: S3Client | undefined;

  constructor(options: S3Options) {
    if (!options.bucket) throw new Error("[allinone/storage] S3Options.bucket is required");
    this.#bucket = options.bucket;
    if (options.validation) this.#validation = options.validation;
    if (options.ops) {
      this.#ops = options.ops;
      this.#client = undefined;
    } else {
      this.#client = new S3Client({
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.region ? { region: options.region } : {}),
        ...(options.accessKeyId && options.secretAccessKey
          ? {
              credentials: {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
              },
            }
          : {}),
        ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
      });
      this.#ops = awsS3Ops(this.#client);
    }
  }

  async put(key: string, data: Buffer, contentType: string): Promise<{ url: string }> {
    checkPut(key, data, contentType, this.#validation);
    await this.#ops.putObject({ bucket: this.#bucket, key, body: data, contentType });
    return { url: `https://${this.#bucket}.s3.amazonaws.com/${key}` };
  }

  async getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    assertObjectKey(key);
    return this.#ops.presignGet({ bucket: this.#bucket, key, expiresIn: expiresInSeconds });
  }

  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    const existed = await this.#ops.headExists({ bucket: this.#bucket, key });
    if (!existed) return false;
    await this.#ops.deleteObject({ bucket: this.#bucket, key });
    return true;
  }

  async exists(key: string): Promise<boolean> {
    assertObjectKey(key);
    return this.#ops.headExists({ bucket: this.#bucket, key });
  }

  async disconnect(): Promise<void> {
    this.#client?.destroy();
  }
}

export function createS3Provider(options: S3Options): S3StorageProvider {
  return new S3StorageProvider(options);
}
