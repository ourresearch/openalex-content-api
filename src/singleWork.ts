import type { Env, ContentRecord } from "./types";

/**
 * Parse and validate a work ID from the URL path.
 * Accepts: W2741809807, w2741809807, 2741809807, https://openalex.org/W2741809807
 */
function parseWorkId(rawId: string): number | null {
  // Remove URL prefix if present
  let id = rawId.replace(/^https?:\/\/openalex\.org\//i, "");

  // Remove 'W' or 'w' prefix if present
  id = id.replace(/^[Ww]/, "");

  const parsed = parseInt(id, 10);
  if (isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * Look up a work in D1 by work_id.
 */
async function lookupWork(env: Env, workId: number): Promise<ContentRecord | null> {
  const result = await env.CONTENT_INDEX.prepare(
    "SELECT work_id, pdf_uuid, grobid_uuid FROM content_index WHERE work_id = ?"
  )
    .bind(workId)
    .first<ContentRecord>();

  return result;
}

const CONTENT_TYPES: Record<"pdf" | "grobid-xml", string> = {
  pdf: "application/pdf",
  "grobid-xml": "application/gzip",
};

function downloadFilename(workId: number, format: "pdf" | "grobid-xml"): string {
  return format === "pdf" ? `W${workId}.pdf` : `W${workId}.grobid.xml.gz`;
}

/**
 * Headers common to 200/206/HEAD responses for a stored object.
 * writeHttpMetadata reproduces what the S3-compatible endpoint served
 * (Content-Type, Content-Encoding, etc. from object metadata), so proxied
 * responses stay byte- and header-compatible with the old presigned downloads.
 */
function objectHeaders(
  obj: R2Object,
  workId: number,
  format: "pdf" | "grobid-xml"
): Headers {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // Objects were uploaded with content-type binary/octet-stream; serve the
  // real type now that the response is ours (the old presigned URLs couldn't).
  headers.set("Content-Type", CONTENT_TYPES[format]);
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${downloadFilename(workId, format)}"`
  );
  headers.set("X-Credits-Cost", "100");
  return headers;
}

/** The content index says the file exists but the bucket disagrees. */
function missingObjectResponse(workId: number, format: "pdf" | "grobid-xml"): Response {
  return Response.json(
    {
      error: `The ${format} for this work is in the content index but missing from storage`,
      work_id: `W${workId}`,
    },
    { status: 500, headers: { "X-Credits-Cost": "0" } }
  );
}

/**
 * Handle a single work content request.
 *
 * GET /works/{work_id}.pdf → stream the PDF from R2
 * GET /works/{work_id}.grobid-xml → stream the Grobid XML (gzipped) from R2
 *
 * Files are served directly from the R2 bindings rather than via a 302 to a
 * presigned *.r2.cloudflarestorage.com URL. The cross-host redirect broke
 * robots.txt-respecting clients: they check robots.txt on the redirect-target
 * host, and Cloudflare's shared storage hostname answers that with a 400,
 * which strict fetchers treat as "robots unreachable → do not fetch" (and we
 * cannot serve a robots.txt on a hostname we don't control). Keeping the bytes
 * on content.openalex.org means the only robots.txt that matters is ours.
 */
export async function handleSingleWork(
  request: Request,
  env: Env,
  workIdRaw: string,
  format: "pdf" | "grobid-xml"
): Promise<Response> {
  // Parse work ID
  const workId = parseWorkId(workIdRaw);
  if (!workId) {
    return Response.json(
      { error: "Invalid work_id", input: workIdRaw },
      { status: 400, headers: { "X-Credits-Cost": "0" } }
    );
  }

  // Look up in D1
  const record = await lookupWork(env, workId);
  if (!record) {
    return Response.json(
      { error: "Work not found in content index", work_id: `W${workId}` },
      { status: 404, headers: { "X-Credits-Cost": "0" } }
    );
  }

  // Check if requested format is available
  const uuid = format === "pdf" ? record.pdf_uuid : record.grobid_uuid;
  if (!uuid) {
    return Response.json(
      {
        error: `No ${format} available for this work`,
        work_id: `W${workId}`,
      },
      { status: 404, headers: { "X-Credits-Cost": "0" } }
    );
  }

  const bucket = format === "pdf" ? env.PDFS : env.GROBID_XML;
  const key = format === "pdf" ? `${uuid}.pdf` : `${uuid}.xml.gz`;

  if (request.method === "HEAD") {
    const head = await bucket.head(key);
    if (!head) {
      return missingObjectResponse(workId, format);
    }
    const headers = objectHeaders(head, workId, format);
    headers.set("Content-Length", head.size.toString());
    return new Response(null, { status: 200, headers });
  }

  const rangeRequested = request.headers.has("range");
  let obj: R2ObjectBody | null;
  try {
    // Passing the request Headers lets R2 parse the Range header itself
    // (single ranges only; multipart or unsatisfiable ranges throw).
    obj = await bucket.get(key, rangeRequested ? { range: request.headers } : {});
  } catch (e) {
    const head = await bucket.head(key);
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${head?.size ?? 0}`,
        "X-Credits-Cost": "0",
      },
    });
  }

  if (!obj) {
    return missingObjectResponse(workId, format);
  }

  const headers = objectHeaders(obj, workId, format);

  if (rangeRequested && obj.range) {
    const offset =
      "suffix" in obj.range ? obj.size - obj.range.suffix : obj.range.offset ?? 0;
    const length =
      "suffix" in obj.range
        ? obj.range.suffix
        : obj.range.length ?? obj.size - offset;
    if (offset < 0 || offset >= obj.size || length <= 0) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${obj.size}`,
          "X-Credits-Cost": "0",
        },
      });
    }
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", length.toString());
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("Content-Length", obj.size.toString());
  // Stream the body through; never buffer it.
  return new Response(obj.body, { status: 200, headers });
}
