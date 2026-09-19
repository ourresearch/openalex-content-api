"""
Audit the content index by sampling R2 objects and checking for corrupted PDFs.

Reads the first 5 bytes of each PDF object via S3-compatible range GET to check
for the %PDF- magic header. Objects that aren't valid PDFs (e.g., HTML error pages,
Cloudflare challenge pages, 403/404 responses) are flagged for removal.

Usage:
    # Dry run - sample 1000 random entries, report stats
    python scripts/audit_content_index.py --sample 1000

    # Purge mode - remove bad entries from D1 (requires --confirm)
    python scripts/audit_content_index.py --sample 1000 --purge --confirm

Requires env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
                    CF_API_TOKEN, CF_ACCOUNT_ID
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import requests

# Cloudflare D1 config
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "a452eddbbe06eb7d02f4879cee70d29c")
CF_D1_DATABASE_ID = "c2e1cc17-1810-400b-a7c8-c5103ab366de"
CF_API_TOKEN = os.environ["CF_API_TOKEN"]

# R2 config
R2_ACCOUNT_ID = os.environ["R2_ACCOUNT_ID"]
PDF_BUCKET = "openalex-pdfs"


def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def d1_query(sql: str, params: list = None) -> list:
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DATABASE_ID}/query"
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {"sql": sql}
    if params:
        payload["params"] = params

    resp = requests.post(url, headers=headers, json=payload, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    if data.get("result") and data["result"][0].get("results"):
        return data["result"][0]["results"]
    return []


def d1_execute(sql: str):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DATABASE_ID}/query"
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    resp = requests.post(url, headers=headers, json={"sql": sql}, timeout=120)
    resp.raise_for_status()
    return resp.json()


def check_pdf(s3_client, pdf_uuid: str) -> dict:
    """Check if an R2 object is a valid PDF by reading first 5 bytes."""
    key = f"{pdf_uuid}.pdf"
    try:
        resp = s3_client.get_object(Bucket=PDF_BUCKET, Key=key, Range="bytes=0-4")
        header = resp["Body"].read()
        is_valid = header == b"%PDF-"
        return {"uuid": pdf_uuid, "valid": is_valid, "header": header, "error": None}
    except s3_client.exceptions.NoSuchKey:
        return {"uuid": pdf_uuid, "valid": False, "header": None, "error": "not_found"}
    except Exception as e:
        return {"uuid": pdf_uuid, "valid": False, "header": None, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Audit content index for corrupted PDFs")
    parser.add_argument("--sample", type=int, default=500, help="Number of random entries to check")
    parser.add_argument("--purge", action="store_true", help="Remove bad entries from D1")
    parser.add_argument("--confirm", action="store_true", help="Required with --purge to actually execute")
    parser.add_argument("--threads", type=int, default=20, help="Concurrent R2 checks")
    args = parser.parse_args()

    print(f"Sampling {args.sample} random entries from content_index...")
    rows = d1_query(
        f"SELECT work_id, pdf_uuid FROM content_index WHERE pdf_uuid IS NOT NULL ORDER BY RANDOM() LIMIT {args.sample}"
    )
    print(f"Got {len(rows)} entries to check")

    s3 = get_s3_client()
    results = {"valid": 0, "corrupted": 0, "missing": 0, "error": 0}
    bad_work_ids = []
    start = time.time()

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = {
            pool.submit(check_pdf, s3, row["pdf_uuid"]): row
            for row in rows
        }
        for i, future in enumerate(as_completed(futures), 1):
            row = futures[future]
            result = future.result()

            if result["valid"]:
                results["valid"] += 1
            elif result["error"] == "not_found":
                results["missing"] += 1
                bad_work_ids.append(row["work_id"])
            elif result["error"]:
                results["error"] += 1
            else:
                results["corrupted"] += 1
                bad_work_ids.append(row["work_id"])
                header_preview = result["header"][:20] if result["header"] else "empty"
                print(f"  CORRUPTED W{row['work_id']}: {header_preview}")

            if i % 100 == 0:
                elapsed = time.time() - start
                rate = i / elapsed
                print(f"  Checked {i}/{len(rows)} ({rate:.0f}/s) — valid: {results['valid']}, bad: {results['corrupted']}, missing: {results['missing']}")

    elapsed = time.time() - start
    total_with_pdf = d1_query("SELECT COUNT(*) as c FROM content_index WHERE pdf_uuid IS NOT NULL")[0]["c"]

    print(f"\n--- Results ({len(rows)} sampled in {elapsed:.1f}s) ---")
    print(f"  Valid PDFs:   {results['valid']} ({100*results['valid']/len(rows):.1f}%)")
    print(f"  Corrupted:    {results['corrupted']} ({100*results['corrupted']/len(rows):.1f}%)")
    print(f"  Missing in R2:{results['missing']} ({100*results['missing']/len(rows):.1f}%)")
    print(f"  Errors:       {results['error']} ({100*results['error']/len(rows):.1f}%)")
    bad_rate = (results["corrupted"] + results["missing"]) / len(rows)
    estimated_bad = int(total_with_pdf * bad_rate)
    print(f"\n  Total PDFs in index: {total_with_pdf:,}")
    print(f"  Estimated bad entries: ~{estimated_bad:,} ({100*bad_rate:.1f}%)")

    if bad_work_ids and args.purge:
        if not args.confirm:
            print(f"\n  Would remove {len(bad_work_ids)} entries. Pass --confirm to execute.")
            return

        print(f"\n  Purging {len(bad_work_ids)} bad entries from D1...")
        # Batch delete in groups of 500
        for i in range(0, len(bad_work_ids), 500):
            batch = bad_work_ids[i : i + 500]
            ids_str = ",".join(str(wid) for wid in batch)
            d1_execute(f"UPDATE content_index SET pdf_uuid = NULL WHERE work_id IN ({ids_str})")
            print(f"  Nullified pdf_uuid for {min(i + 500, len(bad_work_ids))}/{len(bad_work_ids)} entries")

        print("  Purge complete. Run ES re-sync to update has_content flags.")


if __name__ == "__main__":
    main()
