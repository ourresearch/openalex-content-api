import type { Env } from "./types";
import { handleSingleWork } from "./singleWork";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only allow GET and HEAD requests
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405 }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Route: GET /works/{work_id}.pdf or .grobid-xml
    const match = path.match(/^\/works\/([^.]+)\.(pdf|grobid-xml)$/);
    if (match) {
      const workId = match[1];
      const format = match[2] as "pdf" | "grobid-xml";
      return handleSingleWork(request, env, workId, format);
    }

    // No extension = redirect to .pdf
    const noExtMatch = path.match(/^\/works\/([^.\/]+)\/?$/);
    if (noExtMatch) {
      const workId = noExtMatch[1];
      const redirectUrl = new URL(request.url);
      redirectUrl.pathname = `/works/${workId}.pdf`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl.toString(),
          "X-Credits-Cost": "0",
        },
      });
    }

    // Root endpoint - API documentation
    if (path === "/" || path === "") {
      return Response.json({
        name: "OpenAlex Content",
        description: "Download PDFs and TEI XML for OpenAlex works",
        usage: "content.openalex.org/works/{work_id}.{format}",
        formats: ["pdf", "grobid-xml"],
        note: "Omitting the extension defaults to .pdf",
        example: "content.openalex.org/works/W2741809807.pdf",
        credits: 100,
        api_key: "Required (header or ?api_key=)"
      }, { headers: { "X-Credits-Cost": "0" } });
    }

    // 404 for unmatched routes
    return Response.json(
      { error: "Not found", path },
      { status: 404, headers: { "X-Credits-Cost": "0" } }
    );
  },
};

export { Env };
