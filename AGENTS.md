# Grappnel — agent guide

Expo SDK 57 app (iOS/Android/web) + Supabase backend that builds study guides
from students' uploaded course materials using Vertex AI Search (RAG) +
Gemini. Read README.md for the architecture diagram and setup. Expo has
changed a lot recently — consult https://docs.expo.dev/versions/v57.0.0/
before writing Expo-API code.

## Commands

- `npm run dev` — Expo dev server (`w` = web)
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `expo lint`
- `npm run build:web` — web export to `dist/`
- `npm run deploy:db` / `npm run deploy:functions` — push migrations /
  deploy edge functions (Supabase)
- `npm run deploy:transcribe` — deploy the transcription Cloud Run job
  (uses the `personal` gcloud config; run `gcloud auth login` if expired)
- `npm run deploy:backend` — all three in order

## Architecture rules

- **Everything is user-scoped.** Postgres RLS keys on `auth.uid() = user_id`;
  Storage paths and GCS objects are prefixed `<user_id>/`; every Vertex AI
  Search query MUST include the `user_id: ANY("<uid>")` filter
  (`supabase/functions/_shared/discovery.ts` enforces UUID validation to keep
  filter expressions injection-safe).
- Edge functions use the service role (RLS bypassed) and therefore must
  always add `.eq('user_id', user.id)` to queries.
- Material lifecycle: `uploaded → syncing → [transcribing →] indexing →
  indexed | error` (statuses set by `sync-material` / `check-material`).
  Vertex imports are **INCREMENTAL** with one JSONL manifest per material —
  never use FULL reconciliation, it would purge other users' documents.
- Audio/video materials are transcribed before indexing: `sync-material`
  starts the `grappnel-transcribe` Cloud Run job (`gcp/transcribe-job/`:
  ffmpeg → Modulate Velma STT), which writes
  `transcripts/<user_id>/<material_id>.txt` (or `….error.txt`) to GCS;
  `check-material` watches for those objects and imports the transcript
  (`transcript_object` on the row) as `text/plain`. Re-deploy the job after
  changing it — `npx supabase functions deploy` does NOT cover it.
- Transcripts are timestamped paragraphs (`[12:04] Speaker 1: …` from Velma's
  utterances for uploads; `[12:04] …` from YouTube captions), so retrieved
  chunks carry timestamps. `generate-guide` has Gemini cite
  `[Source: <name> @ 12:04]` and then linkifies citations itself for
  materials with a `source_url` (appending `&t=<seconds>s`) — never let the
  model construct URLs.
- YouTube materials (`source_type = 'youtube'`, `mime_type = 'video/youtube'`,
  NULL `storage_path`) are created by `add-youtube-material` (link → video id
  → oEmbed title). Their transcript is the video's own caption track
  (`npm:youtube-transcript-plus` in `_shared/youtube.ts`) fetched in the edge
  function — no Cloud Run job, no `transcribing` status; they go straight to
  `indexing`. Videos without captions are rejected with a clear error. Only
  the parsed 11-char video id is trusted; the canonical watch URL is rebuilt
  from it before it reaches the caption fetch or citation links.
- Renaming/moving a material must re-sync the search index metadata
  (`syncMaterial(id, metadataOnly)`) because title/folder live in structData.
- Guide generation is async: `generate-guide` returns a `generating` row
  immediately and finishes via `EdgeRuntime.waitUntil`; clients poll the row.

## Client conventions (mirrors abstia-expo)

- Expo Router, typed routes, screens in `src/app/`, `@/*` path alias.
- Platform splits via `.web.ts` siblings (see `src/lib/supabase.ts`).
- Plain `StyleSheet.create` + semantic tokens from `src/constants/theme.ts`
  read through `useThemeColors()`. No Tailwind/NativeWind.
- Service functions in `src/lib/services/` return `{ data, error }` — never
  throw to the UI. Contexts export a `useX()` hook that throws outside its
  provider.
- Cross-platform dialogs use the modals in `src/components/ui/` (RN `Alert`
  is a no-op on web — don't use it).
- Auth gating lives in `src/app/_layout.tsx` (segment check + `router.replace`),
  not in route groups.

## Gotchas

- `EXPO_PUBLIC_*` env vars are inlined at build time; a missing one ships as
  `undefined` and crashes at launch.
- Edge function secrets (GCP config) are listed in `.env.example`; local
  serving reads `supabase/functions/.env` (gitignored).
- The Vertex datastore must be created with layout parsing + chunking config
  (scripts/setup-gcp.sh does this) or CHUNKS search mode returns nothing.
- YouTube bot-walls datacenter IPs (edge runtime included) with
  LOGIN_REQUIRED "confirm you're not a bot" playability, which breaks
  caption fetching. `_shared/youtube.ts` detects this via the watch page's
  playabilityStatus and reports it distinctly; the fix is the
  `YOUTUBE_PROXY_URL` secret (rotating residential proxy — only YouTube
  requests are routed through it).
