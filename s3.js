// s3.js
import { S3Client } from "@aws-sdk/client-s3";

/**
 * S3 client factory for either MinIO (local endpoint) or real AWS S3.
 * Exports `s3Client` named export to match your server.js import:
 *   import { s3Client } from "./s3.js"
 *
 * Environment variables used:
 *  - MINIO_ENDPOINT (optional) - e.g. "203.113.132.48"
 *  - MINIO_PORT     (optional) - e.g. "8008"
 *  - MINIO_ACCESS_KEY
 *  - MINIO_SECRET_KEY
 *  - MINIO_REGION   (optional)
 *  - If MINIO_* not present, it will fallback to AWS env vars if available:
 *    AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 */

const usingMinio = Boolean(process.env.MINIO_ENDPOINT && process.env.MINIO_PORT);

const endpoint = usingMinio
  ? `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`
  : undefined;

const region = process.env.MINIO_REGION || process.env.AWS_REGION || "us-east-1";

let credentials;
if (usingMinio && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY) {
  credentials = {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  };
} else if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
} else {
  credentials = undefined; // allow SDK to pick up default credentials chain
}

export const s3Client = new S3Client({
  endpoint,
  region,
  credentials,
  forcePathStyle: usingMinio, // MinIO requires path style
});
