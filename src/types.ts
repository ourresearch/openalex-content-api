export interface Env {
  // R2 buckets
  PDFS: R2Bucket;
  GROBID_XML: R2Bucket;

  // D1 database
  CONTENT_INDEX: D1Database;

  // R2 presigning credentials (set in Cloudflare dashboard)
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CF_ACCOUNT_ID: string;
}

export interface ContentRecord {
  work_id: number;
  pdf_uuid: string | null;
  grobid_uuid: string | null;
}

export interface SignedUrlInfo {
  url: string;
  expires_at: string;
}

