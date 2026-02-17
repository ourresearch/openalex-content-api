import type { Env } from "./types";
import { generateS3SignedUrl } from "./signing";

const SNAPSHOT_BUCKET = "openalex-snapshots";

/**
 * Infer the S3 subdirectory (format) from the filename extension.
 *   *.jsonl.gz  → "jsonl"
 *   *.parquet   → "parquet"
 */
function inferFormat(filename: string): "jsonl" | "parquet" | null {
  if (filename.endsWith(".jsonl.gz")) return "jsonl";
  if (filename.endsWith(".parquet")) return "parquet";
  return null;
}

/**
 * Handle a changefile download request.
 *
 * GET /changefiles/{date}/{filename}
 *   → 302 redirect to presigned S3 URL
 *
 * S3 key: daily/{date}/{format}/{filename}
 * e.g. daily/2026-02-16/jsonl/works_2026-02-16.jsonl.gz
 */
export async function handleChangefile(
  request: Request,
  env: Env,
  date: string,
  filename: string
): Promise<Response> {
  // Validate date format (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json(
      { error: "Invalid date format. Use YYYY-MM-DD.", date },
      { status: 400, headers: { "X-Credits-Cost": "0" } }
    );
  }

  const format = inferFormat(filename);
  if (!format) {
    return Response.json(
      {
        error: "Unsupported file type. Supported extensions: .jsonl.gz, .parquet",
        filename,
      },
      { status: 400, headers: { "X-Credits-Cost": "0" } }
    );
  }

  const s3Key = `daily/${date}/${format}/${filename}`;

  const signedInfo = await generateS3SignedUrl(env, SNAPSHOT_BUCKET, s3Key);

  return new Response(null, {
    status: 302,
    headers: {
      Location: signedInfo.url,
      "X-Expires-At": signedInfo.expires_at,
      "X-Credits-Cost": "0",
    },
  });
}
