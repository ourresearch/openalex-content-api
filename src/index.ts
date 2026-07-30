import type { Env } from "./types";
import { handleSingleWork } from "./singleWork";
import { handleChangefile } from "./changefiles";

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

    // Route: GET /changefiles/{date}/{filename}
    const changefileMatch = path.match(/^\/changefiles\/([^/]+)\/([^/]+)$/);
    if (changefileMatch) {
      return handleChangefile(request, env, changefileMatch[1], changefileMatch[2]);
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

    // robots.txt — must be a real 200 text/plain: robots-respecting clients
    // check it before downloading, and a 4xx here reads as "blocked"
    if (path === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\n", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Credits-Cost": "0",
        },
      });
    }

    // Root endpoint - API documentation
    if (path === "/" || path === "") {
      return Response.json({
        name: "OpenAlex Content",
        description: "Download PDFs, TEI XML, and daily change files for OpenAlex",
        endpoints: {
          works: {
            usage: "content.openalex.org/works/{work_id}.{format}",
            formats: ["pdf", "grobid-xml"],
            note: "Omitting the extension defaults to .pdf",
            example: "content.openalex.org/works/W3038568908.pdf",
            credits: 100,
          },
          changefiles: {
            usage: "content.openalex.org/changefiles/{date}/{filename}",
            formats: ["jsonl.gz", "parquet"],
            example: "content.openalex.org/changefiles/2026-02-16/works_2026-02-16.jsonl.gz",
          },
        },
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
