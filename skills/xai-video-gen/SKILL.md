---
name: xai-video-gen
description: Generate short videos via xAI Grok Imagine Video.
homepage: https://docs.x.ai/docs/guides/video-generation
metadata:
  {
    "openclaw":
      {
        "emoji": "🎬",
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

# xAI Video Gen (Grok Imagine Video)

Generate short videos via the xAI Video API. Two-step process: submit job, poll until done.

Generate from text

```bash
python3 {baseDir}/scripts/generate.py --prompt "a cat walking on the moon" --filename "mooncat.mp4"
```

Generate from image (animate a still)

```bash
python3 {baseDir}/scripts/generate.py --prompt "slowly zoom in and add gentle wind" -i "/path/to/photo.png" --filename "animated.mp4"
```

Options

```bash
python3 {baseDir}/scripts/generate.py --prompt "..." --duration 10 --resolution 720p --aspect-ratio 9:16
```

- Duration: 1-15 seconds (default 5). Editing capped at 8.7s.
- Resolution: `480p` (default) or `720p`.
- Aspect ratios: `16:9` (default), `1:1`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`.
- Timeout: `--timeout 600` (seconds, default 600).

API key

- `XAI_API_KEY` env var
- Or set `skills."xai-video-gen".apiKey` / `skills."xai-video-gen".env.XAI_API_KEY` in `~/.openclaw/openclaw.json`

Notes

- Video generation can take 1-5 minutes. The script polls until completion.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Do not read the video back; report the saved path only.
