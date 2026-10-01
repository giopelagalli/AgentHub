# ComfyUI workflow templates (FR-E1)

The node daemon fills these and posts them to the PC's ComfyUI (`video.comfyUrl`):

| File | Job type | Model |
|---|---|---|
| `qwen-image-t2i.json` | `image-gen` | Qwen-Image (stills) |
| `wan22-t2v.json` | `video-gen` | Wan 2.2 TI2V-5B (clips) |

**These are placeholders.** Node ids, node class names, model filenames and sampler settings were
written from the public example workflows, not exported from the real ComfyUI on the 7900 XTX.
Everything marked `TODO-verify` in a node's `_meta.title` is a guess.

## Replacing them with the real ones

1. Install ComfyUI on ROCm on the PC and download the models.
2. **Test by hand first**: load the model's example workflow in the ComfyUI web UI, render one
   image (and one clip), and tune steps/cfg/shift until the output is good.
3. *Workflow → Export (API)* in ComfyUI. Overwrite the file here with the export.
4. Put the placeholders back where the job's values go — strings inside quotes, numbers bare:
   - both: `"{{prompt}}"`, `"{{negativePrompt}}"`, `{{width}}`, `{{height}}`, `{{seed}}`
   - video only: `{{seconds}}`, `{{fps}}`, `{{frames}}` (seconds × fps rounded to 4k+1, what Wan
     and LTX-2 call `length`)
5. Keep exactly one output node (`SaveImage` / `SaveVideo`): the daemon downloads the first output
   file the run reports. Stills are saved as `.png`, clips as `.mp4`.

## Pointing the daemon at them

```yaml
jobTypes: [image-gen, video-gen]
video:
  comfyUrl: http://127.0.0.1:8188
  workflows:
    image: /opt/agenthub/deploy/amd/comfy/qwen-image-t2i.json
    video: /opt/agenthub/deploy/amd/comfy/wan22-t2v.json
```

Without `workflows.image` the daemon does **not** offer `image-gen` (it logs why, and the hub's
Media view says no machine can render images) — the placeholder here is never used by default. Without
`workflows.video` it falls back to the older single `video.workflow`, and without that to
`deploy/spark/minimax-h3-t2v.json` (decision 0018 keeps H3 out; the fallback exists only so old
configs keep starting). An LTX-2 template is the same exercise with LTX-2's example workflow.
