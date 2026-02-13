#!/usr/bin/env python3
"""Generate short videos via xAI Grok Imagine Video API (submit + poll)."""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API_BASE = "https://api.x.ai/v1"
MODEL = "grok-imagine-video"


def resolve_output_path(filename: str) -> Path:
    preferred = Path.home() / "Projects" / "tmp"
    base = preferred if preferred.is_dir() else Path("/tmp")
    out = base / filename
    out.parent.mkdir(parents=True, exist_ok=True)
    return out


def encode_image(path: str) -> str:
    data = Path(path).expanduser().read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:image/png;base64,{b64}"


def api_request(api_key: str, endpoint: str, body: dict | None = None, method: str = "POST") -> dict:
    url = f"{API_BASE}{endpoint}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"xAI API failed ({e.code}): {payload}") from e


def submit_job(
    api_key: str,
    prompt: str,
    duration: int,
    resolution: str,
    aspect_ratio: str,
    image_url: str | None = None,
) -> str:
    body: dict = {
        "model": MODEL,
        "prompt": prompt,
        "duration": duration,
        "resolution": resolution,
        "aspect_ratio": aspect_ratio,
    }
    if image_url:
        body["image_url"] = image_url

    res = api_request(api_key, "/images/generations", body)
    # The API returns a deferred job id
    job_id = res.get("id") or res.get("deferred_id")
    if not job_id:
        # Some API versions return data directly
        if res.get("data"):
            return res
        raise RuntimeError(f"No job id in response: {json.dumps(res)[:400]}")
    return job_id


def poll_job(api_key: str, job_id: str, timeout: int, interval: float = 2.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        url = f"{API_BASE}/images/generations/{job_id}"
        headers = {"Authorization": f"Bearer {api_key}"}
        req = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                time.sleep(interval)
                continue
            payload = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Poll failed ({e.code}): {payload}") from e

        status = result.get("status", "").lower()
        if status == "done" or result.get("data"):
            return result
        if status in ("expired", "failed", "error"):
            raise RuntimeError(f"Job {status}: {json.dumps(result)[:400]}")

        elapsed = timeout - (deadline - time.time())
        print(f"  polling... {elapsed:.0f}s elapsed, status={status}", file=sys.stderr)
        time.sleep(interval)

    raise RuntimeError(f"Timed out after {timeout}s waiting for video job {job_id}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate video via xAI Grok Imagine Video.")
    ap.add_argument("--prompt", required=True, help="Video generation prompt.")
    ap.add_argument("--filename", default="video.mp4", help="Output filename.")
    ap.add_argument("--duration", type=int, default=5, help="Duration in seconds (1-15, default 5).")
    ap.add_argument("--resolution", default="480p", choices=["480p", "720p"], help="Resolution.")
    ap.add_argument("--aspect-ratio", default="16:9", help="Aspect ratio (e.g. 16:9, 1:1, 9:16).")
    ap.add_argument("-i", "--input-image", default="", help="Source image path to animate.")
    ap.add_argument("--timeout", type=int, default=600, help="Max wait seconds (default 600).")
    args = ap.parse_args()

    api_key = (os.environ.get("XAI_API_KEY") or "").strip()
    if not api_key:
        print("Missing XAI_API_KEY", file=sys.stderr)
        return 2

    image_url = encode_image(args.input_image) if args.input_image else None
    duration = max(1, min(15, args.duration))
    if image_url and duration > 8:
        print("Warning: editing duration capped at 8.7s, using 8", file=sys.stderr)
        duration = 8

    print(f"Submitting video job ({duration}s, {args.resolution}, {args.aspect_ratio})...")
    result = submit_job(api_key, args.prompt, duration, args.resolution, args.aspect_ratio, image_url)

    # If result is already a dict with data, the API returned synchronously
    if isinstance(result, dict):
        job_result = result
    else:
        print(f"Job submitted: {result}. Polling...")
        job_result = poll_job(api_key, result, args.timeout)

    # Extract video URL from response
    data = job_result.get("data", [])
    if not data:
        print(f"No video data: {json.dumps(job_result)[:400]}", file=sys.stderr)
        return 1

    video_url = data[0].get("url")
    video_b64 = data[0].get("b64_json")
    out_path = resolve_output_path(args.filename)

    if video_b64:
        out_path.write_bytes(base64.b64decode(video_b64))
    elif video_url:
        urllib.request.urlretrieve(video_url, out_path)
    else:
        print(f"No video URL or data in response", file=sys.stderr)
        return 1

    print(f"Saved: {out_path}")
    print(f"MEDIA: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
