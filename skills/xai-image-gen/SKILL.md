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

Multi-step editing

Chain edits by passing the previous output as `-i` for the next call. Keep track of the latest output path.

```bash
# Step 1: generate
python3 {baseDir}/scripts/generate.py --prompt "a cat sitting on a windowsill" --filename "cat.png"
# Step 2: user says "add rain outside" — edit the previous output
python3 {baseDir}/scripts/generate.py --prompt "add rain outside the window" --filename "cat-rain.png" -i "/tmp/cat.png"
# Step 3: user says "make it night time" — edit again
python3 {baseDir}/scripts/generate.py --prompt "change to night time, dark sky" --filename "cat-rain-night.png" -i "/tmp/cat-rain.png"
```

When the user asks to modify the last generated image, always use `-i` with the most recent output path. Do not regenerate from scratch unless asked.

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
