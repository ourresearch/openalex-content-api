import type { Env, ContentRecord } from "./types";
import { signContentRecord } from "./signing";

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

/**
 * Handle a single work content request.
 *
 * GET /works/{work_id}.pdf → 302 redirect to signed PDF URL
 * GET /works/{work_id}.grobid-xml → 302 redirect to signed Grobid XML URL
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

  // Generate signed URL
  const formats = await signContentRecord(
    env,
    format === "pdf" ? uuid : null,
    format === "grobid-xml" ? uuid : null
  );

  const signedInfo = format === "pdf" ? formats.pdf : formats.grobid_xml;
  if (!signedInfo) {
    return Response.json(
      { error: "Failed to generate signed URL" },
      { status: 500 }
    );
  }

  // Return 302 redirect to the signed URL
  return new Response(null, {
    status: 302,
    headers: {
      Location: signedInfo.url,
      "X-Expires-At": signedInfo.expires_at,
      "X-Credits-Cost": "100",
    },
  });
}

