#!/usr/bin/env python3
"""Generate or edit images via xAI Grok Imagine API."""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.x.ai/v1/images/generations"
DEFAULT_MODEL = "grok-imagine-image-pro"


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


def generate(
    api_key: str,
    prompt: str,
    model: str,
    n: int = 1,
    aspect_ratio: str = "1:1",
    image_url: str | None = None,
) -> dict:
    body: dict = {
        "model": model,
        "prompt": prompt,
        "n": n,
        "response_format": "b64_json",
    }
    if aspect_ratio:
        body["aspect_ratio"] = aspect_ratio
    if image_url:
        body["image_url"] = image_url

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "openclaw/xai-image-gen",
        },
        data=data,
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"xAI Images API failed ({e.code}): {payload}") from e


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate images via xAI Grok Imagine.")
    ap.add_argument("--prompt", required=True, help="Image generation prompt.")
    ap.add_argument("--filename", default="image.png", help="Output filename.")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"Model id (default: {DEFAULT_MODEL}).")
    ap.add_argument("--count", type=int, default=1, help="Number of images (max 10).")
    ap.add_argument("--aspect-ratio", default="1:1", help="Aspect ratio (e.g. 1:1, 16:9, 9:16).")
    ap.add_argument("-i", "--input-image", default="", help="Source image path for editing.")
    args = ap.parse_args()

    api_key = (os.environ.get("XAI_API_KEY") or "").strip()
    if not api_key:
        print("Missing XAI_API_KEY", file=sys.stderr)
        return 2

    image_url = encode_image(args.input_image) if args.input_image else None

    count = min(args.count, 10)
    res = generate(api_key, args.prompt, args.model, count, args.aspect_ratio, image_url)

    images = res.get("data", [])
    if not images:
        print(f"No images returned: {json.dumps(res)[:400]}", file=sys.stderr)
        return 1

    stem = Path(args.filename).stem
    ext = Path(args.filename).suffix or ".png"

    for idx, item in enumerate(images):
        suffix = f"-{idx + 1}" if len(images) > 1 else ""
        fname = f"{stem}{suffix}{ext}"
        out_path = resolve_output_path(fname)

        b64_data = item.get("b64_json")
        url = item.get("url")
        if b64_data:
            out_path.write_bytes(base64.b64decode(b64_data))
        elif url:
            urllib.request.urlretrieve(url, out_path)
        else:
            print(f"No image data in response item {idx}", file=sys.stderr)
            continue

        print(f"Saved: {out_path}")
        print(f"MEDIA: {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
