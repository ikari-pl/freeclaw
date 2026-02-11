---
name: xai-image-gen
description: Generate or edit images via xAI Grok Imagine (image-pro and image-1212).
homepage: https://docs.x.ai/docs/guides/image-generation
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "bins": ["python3"], "env": ["XAI_API_KEY"] },
        "primaryEnv": "XAI_API_KEY",
        "install":
          [
            {
              "id": "python-brew",
              "kind": "brew",
              "formula": "python",
              "bins": ["python3"],
              "label": "Install Python (brew)",
            },
          ],
      },
  }
---

# xAI Image Gen (Grok Imagine)

Generate or edit images via the xAI Images API.

Generate

```bash
python3 {baseDir}/scripts/generate.py --prompt "a cozy cabin in the mountains at sunset" --filename "cabin.png"
```

Edit (provide a source image)

```bash
python3 {baseDir}/scripts/generate.py --prompt "make it winter with snow" --filename "cabin-winter.png" -i "/path/to/cabin.png"
```

Multiple images

```bash
python3 {baseDir}/scripts/generate.py --prompt "cyberpunk cityscape" --count 4 --filename "city.png"
```

Models

```bash
# Pro model (default, higher quality)
python3 {baseDir}/scripts/generate.py --model grok-imagine-image-pro --prompt "..."

# Classic model
python3 {baseDir}/scripts/generate.py --model grok-2-image-1212 --prompt "..."
```

Aspect ratios: `1:1` (default), `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`.

```bash
python3 {baseDir}/scripts/generate.py --prompt "panoramic landscape" --aspect-ratio 16:9
```

API key

- `XAI_API_KEY` env var
- Or set `skills."xai-image-gen".apiKey` / `skills."xai-image-gen".env.XAI_API_KEY` in `~/.openclaw/openclaw.json`

Notes

- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.
- The script prints a `MEDIA:` line that auto-attaches the image to the current chat. Do NOT also send the image via the message tool — that causes duplicates.
- Do not read the image back; report the saved path only.
