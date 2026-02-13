import { AwsClient } from "aws4fetch";
import type { Env, SignedUrlInfo } from "./types";

const URL_EXPIRY_SECONDS = 300; // 5 minutes

// Cache AWS client per request context to avoid repeated instantiation
let cachedAwsClient: AwsClient | null = null;
let cachedCredentials: string | null = null;

function getAwsClient(env: Env): AwsClient {
  const credKey = `${env.R2_ACCESS_KEY_ID}:${env.R2_SECRET_ACCESS_KEY}`;
  if (cachedAwsClient && cachedCredentials === credKey) {
    return cachedAwsClient;
  }
  cachedAwsClient = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  cachedCredentials = credKey;
  return cachedAwsClient;
}

/**
 * Generate a presigned URL for an R2 object.
 *
 * R2 uses S3-compatible presigned URLs:
 * https://{account_id}.r2.cloudflarestorage.com/{bucket}/{key}?X-Amz-Algorithm=...
 */
export async function generateSignedUrl(
  env: Env,
  bucket: "openalex-pdfs" | "openalex-grobid-xml",
  key: string
): Promise<SignedUrlInfo> {
  const aws = getAwsClient(env);

  const endpoint = `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = new URL(`${endpoint}/${bucket}/${key}`);

  // Add X-Amz-Expires to the URL before signing
  url.searchParams.set("X-Amz-Expires", URL_EXPIRY_SECONDS.toString());

  // Sign the request with query string signing (for presigned URLs)
  const signed = await aws.sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });

  const expiresAt = new Date(Date.now() + URL_EXPIRY_SECONDS * 1000).toISOString();

  return {
    url: signed.url,
    expires_at: expiresAt,
  };
}

/**
 * Generate signed URLs for a content record.
 * Signs PDF and Grobid URLs in parallel for better performance.
 */
export async function signContentRecord(
  env: Env,
  pdfUuid: string | null,
  grobidUuid: string | null
): Promise<{ pdf?: SignedUrlInfo; grobid_xml?: SignedUrlInfo }> {
  const promises: Promise<void>[] = [];
  const result: { pdf?: SignedUrlInfo; grobid_xml?: SignedUrlInfo } = {};

  if (pdfUuid) {
    promises.push(
      generateSignedUrl(env, "openalex-pdfs", `${pdfUuid}.pdf`).then(
        (signed) => { result.pdf = signed; }
      )
    );
  }

  if (grobidUuid) {
    promises.push(
      generateSignedUrl(env, "openalex-grobid-xml", `${grobidUuid}.xml.gz`).then(
        (signed) => { result.grobid_xml = signed; }
      )
    );
  }

  await Promise.all(promises);
  return result;
}
