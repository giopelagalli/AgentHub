# Media

## Media

**Docs → Media** shows the images and clips made for a project, each with the prompt and settings
that made it, and a box to ask for another: pick **Image** or **Video**, a size (and a length for a
clip), describe it, **Generate** (⌘↩). The job shows under the box while it waits and renders; the
file lands in the project bundle as `media/image-<job>.png` / `media/video-<job>.mp4` beside a
`.json` with the prompt, size, seed, machine and render time, and is committed.

Employees can do the same from a turn. Making images and making videos are **abilities**, not a
role (decision 0073): open an employee's drawer — click their face on the Overview — and switch
**Images** and/or **Videos** on under **Can make**. Images gives them `generate_image`, Videos
`generate_video`, whatever their role; the manager sees who makes what and asks them for an app
icon, a hero image or a demo clip. A **designer** you never changed can make both, as before; once
you flip a switch, the switches are what count. If no machine can render yet, the drawer says so
under the switches — the setting is kept, and a render the employee asks for is refused until a
machine that renders it joins. An employee with an ability always runs on the built-in loop for
their tasks (pi and Claude Code cannot offer the render tools); the drawer says so under
**Harness** when you have picked one of those.

"No machine can render images yet" means no registered node offers `image-gen`. Rendering runs on
the PC (the 7900 XTX) through ComfyUI (decision 0018: Qwen-Image for stills, Wan 2.2 or LTX-2 for
clips). What the PC needs:

1. **ComfyUI on ROCm**, running locally (`http://127.0.0.1:8188`), with the models downloaded.
2. **The by-hand test first**: render one image and one clip in ComfyUI's own web UI from the
   models' example workflows, and tune them until they look right.
3. **The templates**: `deploy/amd/comfy/qwen-image-t2i.json` and `wan22-t2v.json` are placeholders
   (`TODO-verify` marks every guess). Export the tested workflows from ComfyUI (*Export (API)*)
   over them and put the `{{prompt}}`-style placeholders back — `deploy/amd/comfy/README.md`.
4. **The node config** — the daemon offers both job types and points at the templates:

   ```yaml
   jobTypes: [image-gen, video-gen]
   video:
     comfyUrl: http://127.0.0.1:8188
     workflows:
       image: /opt/agenthub/deploy/amd/comfy/qwen-image-t2i.json
       video: /opt/agenthub/deploy/amd/comfy/wan22-t2v.json
   ```

   An older config with a single `video.workflow` keeps working for clips. Without
   `workflows.image` the node does not offer `image-gen` at all, even if `jobTypes` lists it.

One render at a time per machine: a still or a clip parks the machine's worker model while it runs
and hands it back after (decision 0061). In the simulation, `sim-media` renders against a mock
ComfyUI in a few seconds, and `pomodoro-cli` starts with an app icon.
