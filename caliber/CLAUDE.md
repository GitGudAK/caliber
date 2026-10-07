# Caliber

A product video studio for watches. The user uploads a 3D watch model; the app generates a 3D environment around it using the image-blaster pipeline (World Labs Marble -> Gaussian splat .spz, FAL nano-banana for image edits, FAL Hunyuan 3D for draft models, FAL ElevenLabs for audio). The editor lights the watch, animates camera moves, and exports MP4 via WebCodecs + Mediabunny.

Built from scratch (2026-10-06). An earlier Bolt.new prototype ("SoleStage", for shoes) existed but its code could not be exported, so nothing from it is carried over.

## Source of truth

This repo is a build on top of image-blaster (github.com/neilsonnn/image-blaster, MIT): image-blaster's files live at the repo root (`..` from this folder) and Caliber lives in `caliber/`. The `upstream` git remote points at image-blaster for pulling updates. Its `.claude/skills/` and `.claude/scripts/` are the source of truth for every API call, model ID, and parameter. Its `app/` has a working React splat viewer (Spark + R3F) to reuse. Its `worlds/` folder is empty — there is no sample .spz.

Key facts pulled from it:
- World: `POST https://api.worldlabs.ai/marble/v1/worlds:generate`, header `WLT-Api-Key`, model `marble-1.1`, poll `GET /operations/{id}`. Prompt is `{type:"text", text_prompt}` or `{type:"image", image_prompt:{source:"data_base64"|"uri", ...}, text_prompt?}`. Response `assets.splats.spz_urls` (keys like 100k/500k/full_res), `assets.mesh.collider_mesh_url`, `assets.imagery.pano_url`, `assets.thumbnail_url`, `assets.splats.semantics_metadata` (ground_plane_offset, flip_y, metric_scale_factor). Always download assets locally; never load from provider URLs.
- FAL queue: `POST https://queue.fal.run/{endpoint}`, header `Authorization: Key $FAL_KEY`, poll status_url, fetch response_url.
- Image edit: `fal-ai/nano-banana-2/edit` (prompt, image_urls, resolution "1K", aspect_ratio "auto", output_format "png", safety_tolerance "4").
- 3D: `fal-ai/hunyuan3d-v3/image-to-3d` (input_image_url, generate_type "Normal", enable_pbr true, face_count 50000).
- SFX: `fal-ai/elevenlabs/sound-effects/v2` (text, loop, prompt_influence 0.3, output_format "mp3_44100_128", duration_seconds 0.5–22). Non-loop output is trimmed/normalized with ffmpeg.
- Viewer stack: three 0.180, @react-three/fiber 9, React 19, @sparkjsdev/spark 2.x.

## Architecture: fully local

Runs on this machine with one command (`npm run dev` starts Vite + the local server). No Supabase, no auth (single user).
- Database: SQLite file at `data/caliber.db`, typed query layer, migrations.
- Storage: `data/assets/`, served by the local server.
- Server: local Node (TypeScript) API that runs the pipeline steps.
- Job progress: Server-Sent Events, with polling as a fallback.
- Secrets: `.env` read only by the server (WORLDLABS_API_KEY, FAL_KEY). Ship `.env.example`; `.env` is gitignored. Keys never reach the frontend.
- Serve .spz, .glb, .mp3, .mp4 with correct MIME types from the same origin.
- Keep infrastructure behind small interfaces so it can be swapped: repository layer, asset storage (save, get URL, delete), job runner (create job, update progress, subscribe). The frontend talks only to the local API.
- AI models still run in the cloud (World Labs, FAL). "Local" means the app, data, files, and job orchestration.
- Exported MP4s save to `data/exports/`.

## Rules

- No silent fallbacks, placeholder gradients, or mock data presented as real. If something fails, surface the real error in the UI.
- Never spend money on paid API calls without showing the exact request first and getting approval.
- Make small, verifiable changes and run the app to check them. Report what was verified versus assumed.
- Never pay twice for the same output. Every paid provider call goes through `server/jobs/paidRequest.ts`, which fingerprints the exact request body (`server/providers/requestHash.ts`) in the `provider_requests` table and reuses completed outputs instead of re-sending. Finished worlds are saved as presets in the library (`world_presets`, files under `data/assets/presets/`) and are never deleted through the API.

## Features (target)

- Upload a watch model (.glb); optionally draft one from a photo via Hunyuan.
- Environment step: demo set, preset prompts, custom prompt, or location photo -> World Labs world (.spz).
- Editor: splat world + watch, orbit camera, lighting, moving hands, materials, camera shots/moves, audio.
- Each generation is a job with live SSE progress, auto-load on success, real error + Retry on failure.
- Debug panel (keyboard toggle): job ID, step statuses, asset paths.
- MP4 export via WebCodecs + Mediabunny.

## Decisions (2026-10-06)

- Text prompts go text -> scene image (FAL nano-banana-2 text-to-image) -> user approves the still -> World Labs image prompt. Location photos go straight to World Labs.
- UI matches image-blaster's look: Radix Themes dark + Tailwind, the `chrome` tokens from `src/components/AppChrome.tsx`. No new palette or fonts.
- Sample watch for bootstrapping: `samples/casio_watch.glb` (Sketchfab export, license unconfirmed, gitignored). It is one merged surface split by 6 materials and sits off-origin, so the viewer auto-centers/scales. Hands are not separate meshes.
- Stack: Node >= 22.5 (built-in `node:sqlite`), Hono server on 127.0.0.1:8787, Vite on 5173 proxying /api and /assets. three 0.180 + Spark 2.3.1 install cleanly.
- API contract lives in `shared/api.ts`; types in `shared/types.ts`. Change the contract there first.
- Scale: worlds are generated as macro tabletop scenes (World Labs handles close-up images well — verified 2026-10-06 on the oak desk), then scaled down so the watch sits at true size on the splat surface. The world's pano drives reflections on the steel. Watch placement (`Placement` in shared/types.ts) is user-editable and saved per project; presets carry a default placement.
- First paid world: "Morning Desk — macro oak" (FAL request 01a11335-…, World Labs operation d335f052-…). Hand-tuned placement: worldScale 0.06, desk at y≈0 via worldOffset [0, 0.0294, 0], watch size 0.065, standing on its bracelet, dial up.

## Folder ownership (for parallel agents)

| Area | Paths |
|---|---|
| Infra interfaces (lead only) | `shared/**`, `server/db/**`, `server/storage/**`, `server/jobs/runner.ts`, `server/env.ts`, `package.json`, configs |
| API routes | `server/index.ts`, `server/app.ts`, `server/routes/**`, `server/jobs/<kind>.ts` |
| Provider clients | `server/providers/**` (pure request builders + injected fetch; never call paid APIs in tests) |
| Frontend shell | `src/main.tsx`, `src/App.tsx`, `src/components/**`, `src/lib/**`, `src/screens/**` |
| Viewer | `src/viewer/**`, `viewer-sandbox.html` |
| Export | `src/export/**` |

Agents never run `npm install` or commit; dependency and contract changes go through the lead.
