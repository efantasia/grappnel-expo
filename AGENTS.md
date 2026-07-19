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
- `npm run deploy:figures` — deploy the figure-extraction Cloud Run job
  (same `personal` gcloud config)
- `npm run deploy:backend` — all four in order

## Architecture rules

- **Everything is user-scoped.** Postgres RLS keys on `auth.uid() = user_id`;
  GCS objects are namespaced by user id (`content/<user_id>/…`,
  `transcripts/<user_id>/…`); every Vertex AI Search query MUST include the
  `user_id: ANY("<uid>")` filter (`supabase/functions/_shared/discovery.ts`
  enforces UUID validation to keep filter expressions injection-safe).
- Edge functions use the service role (RLS bypassed) and therefore must
  always add `.eq('user_id', user.id)` to queries.
- Uploads go **directly to GCS** — no Supabase Storage hop. `create-upload`
  validates type/size, inserts the row (status `uploading`, `gcs_object`
  preassigned server-side), and mints a GCS resumable upload session pinned
  to that object name / content type / exact byte length; the client PUTs
  the bytes to the session URI (streaming from disk on native) and then
  calls `sync-material`, which verifies the object exists before ingesting.
  Browser PUTs require the bucket CORS config set by `scripts/setup-gcp.sh`.
  `storage_path` (and the `uploaded` status) survive only on legacy rows
  that predate this flow.
- Downloads also skip Supabase: `download-material` mints a short-lived V4
  signed GCS URL (signed locally with the service-account key in
  `_shared/gcs.ts`, `response-content-disposition: attachment`) for the
  material's `gcs_object`; `get-transcript` returns transcript text read
  server-side. `src/lib/download.ts` (+ `.web.ts`) handles both per platform
  (share sheet on native, browser download on web) from the material "…" menu.
- Material lifecycle: `uploading → syncing → [transcribing →] indexing →
  indexed | error` (statuses set by `create-upload` / `sync-material` /
  `check-material`).
  Vertex imports are **INCREMENTAL** with one JSONL manifest per material —
  never use FULL reconciliation, it would purge other users' documents.
- Audio/video materials are transcribed before indexing: `sync-material`
  starts the `grappnel-transcribe` Cloud Run job (`gcp/transcribe-job/`:
  ffmpeg → Modulate Velma STT), which writes
  `transcripts/<user_id>/<material_id>.txt` (or `….error.txt`) to GCS;
  `check-material` watches for those objects and imports the transcript
  (`transcript_object` on the row) as `text/plain`. Re-deploy the job after
  changing it — `npx supabase functions deploy` does NOT cover it.
- Transcripts are timestamped as one sentence per line (`[12:04] …`, blank-line
  separated, falling back to time-based breaks when there's no sentence
  punctuation) — the SAME shape for uploaded media (`gcp/transcribe-job` from
  Velma's utterances) and YouTube captions (`_shared/youtube.ts`
  `formatCaptionTranscript`), so retrieved chunks carry dense per-sentence
  timestamps. `generate-guide` has Gemini cite
  `[Source: <name> @ 12:04]` inline, then `footnoteCitations` rewrites each
  distinct citation to a numbered footnote reference (`[^n]`) and appends the
  definitions under a `### Sources` heading; for materials with a `source_url`
  the definition is a Markdown link to that moment (appending `&t=<seconds>s`)
  — never let the model construct URLs. The client (`src/components/guide-content.tsx`
  + `src/lib/guide-markdown.ts`) renders the references as tappable superscripts
  (`#fn-<n>`, intercepted to scroll to the footnote), the definitions as a
  linked footnote list, converts `$…$`/`$$…$$` LaTeX (and stray LaTeX symbol
  commands the model leaks outside the delimiters) to Unicode, and drops a
  redundant leading title heading. Raw `<br>` is handled by a custom markdown-it
  inline rule that emits a `hardbreak` token — a real line break that survives
  inside table cells (whose source row must stay on one line), unlike a
  string-level newline which would shatter the table. The generation prompt
  forbids raw HTML and a redundant title heading.
- YouTube materials (`source_type = 'youtube'`, `mime_type = 'video/youtube'`,
  NULL `storage_path`) are created by `add-youtube-material` (link → video id
  → oEmbed title). Their transcript is the video's own caption track
  (`npm:youtube-transcript-plus` in `_shared/youtube.ts`) fetched in the edge
  function — no Cloud Run job, no `transcribing` status; they go straight to
  `indexing`. Videos without captions are rejected with a clear error. Only
  the parsed 11-char video id is trusted; the canonical watch URL is rebuilt
  from it before it reaches the caption fetch or citation links.
- After a material lands on `indexed`, `check-material` starts background
  topic extraction (`_shared/topics.ts`): Gemini reads the content (GCS text
  for transcripts/plain text; the Vertex-parsed chunks via v1alpha
  `chunks.list` for PDF/Office uploads, falling back to `searchChunks`) and
  writes one `material_topics` row per topic. `materials.topics_status` tracks
  it (`pending → extracting → extracted | error`); full re-syncs reset it to
  `pending`, metadata-only re-syncs keep the extracted topics.
- **A topic IS an OpenAlex topic — there is no freeform name/summary.** Every
  `material_topics` row is a single official OpenAlex topic the material covers;
  the display label is the topic's `openalex_topic` (display name) and any
  description comes from the joined `openalex_topics` row. Classification is
  pinned to the `openalex_topics` reference table — never free-typed. That table
  (4,516 rows: domain > field > subfield > topic, each with its id, description,
  keywords + canonical Wikipedia article) plus `materials.topics_status` and the
  base `material_topics` table live in the consolidated migration
  `20260712000000_topic_extraction.sql`, generated by
  `scripts/fetch-openalex-topics.mjs` (`npm run topics:refresh`) from
  `api.openalex.org` — edit the script, not the SQL, and regenerate.
  `20260714000000_topics_openalex_only.sql` then drops the old freeform
  name/summary and makes `openalex_topic_id` NOT NULL + unique per material.
- Extraction (`_shared/topics.ts`) is two-stage: (1) Gemini proposes candidate
  topics (a transient name/summary used only for matching), each tagged with an
  OpenAlex domain + field constrained by `enum` to the official 4/26 names
  (which must stay verbatim-equal to `field_name`); (2) per field, Gemini picks
  the single best OFFICIAL topic id from that field's rows (using their names +
  keywords). Only matched candidates are stored (deduped by topic id); a
  candidate that matches nothing is dropped. `material_topics.openalex_topic_id`
  is FK-constrained to `openalex_topics`, so a hallucinated id can't be inserted.
- Topics surface on the client through `src/lib/services/topics.ts`:
  `listTopics(folderId)` joins each `material_topics` row to its material and to
  its matched `openalex_topics` row (for the description + keywords);
  `aggregateTopics` collapses rows across materials keyed by OpenAlex topic id
  (representative higher levels = most-common non-null label); `groupTopics`
  buckets by OpenAlex subfield (with the field as a sub-label). The **Explore**
  tab (`src/app/(tabs)/topics.tsx`) browses those groups; the topic detail
  screen (`src/app/topic/[id].tsx`, keyed by the OpenAlex topic id) shows the
  OpenAlex hierarchy, the official description + keywords, a link to the
  canonical Wikipedia article, and covering sources (each with the shared
  material "…" menu — open/download/rename/move/delete), and deep-links into
  `/generate?topic=…` (passing the display name). The generate screen offers
  the same subfield-grouped topics (`aggregateTopics` + `groupTopics`, scoped
  to the selected source folder) as one-tap chips under per-subfield headers.
- Renaming/moving a material must re-sync the search index metadata
  (`syncMaterial(id, metadataOnly)`) because title/folder live in structData.
- Guide generation is async: `generate-guide` returns a `generating` row
  immediately and finishes via `EdgeRuntime.waitUntil`; clients poll the row.
- **Figures** are extracted from document uploads (PDF/DOCX/PPTX/XLSX only —
  never text, media, or YouTube) so cards/guides can show images from the
  student's own sources. Parallel to indexing, `sync-material` starts the
  `grappnel-extract-figures` Cloud Run job (`gcp/extract-figures-job/`: poppler
  `pdfimages` / `unzip` media → `sharp` filter+normalize → Vertex Gemini
  caption), which writes figures to `figures/<user_id>/<material_id>/…` plus a
  `manifest.json` (or `error.txt`) there. `check-material` watches for the
  manifest (`settleFigures` in `_shared/figures.ts`) and imports it into
  `material_figures` (one row per kept figure, with the Gemini caption/alt
  text). `materials.figures_status` tracks it: `pending → processing →
  extracting → extracted | skipped | error` (`skipped` = a material type with
  no embedded images). Full re-syncs reset it to `pending`; metadata-only
  re-syncs keep the extracted figures. Re-deploy the job after changing it —
  `npx supabase functions deploy` does NOT cover it (like transcribe). The
  private bucket means figures are displayed via `sign-figures` (short-lived V4
  signed inline URLs, `createSignedInlineUrl` in `_shared/gcs.ts`).
- **Flashcards** mirror guides: `generate-flashcards` retrieves chunks for the
  topic(s), offers Gemini the `material_figures` of the matched sources, and has
  it author cards — each optionally attaching a figure *by index* (resolved to a
  real `figure_id` server-side, never model-authored) so the card shows an image.
  Cards are `type` `'basic'` (question/answer) or `'cloze'` (fill-in-the-blank:
  `front` has a `_____` gap, `back` is the missing term; the study screen fills
  the gap on reveal). **Image answer-reveal review:** after drafting, every
  figure-bearing card is checked *multimodally* (`generateJsonFromParts` +
  `readObjectBase64`) — Gemini looks at the actual image and, if the card's
  answer is visibly shown on it (printed label/title/caption), the figure is
  dropped from that card (fail-safe: a review error also drops it). So a card
  never reveals its own answer in its picture. It returns a `generating` deck
  immediately and finishes via `EdgeRuntime.waitUntil`; `flashcard_decks` +
  `flashcards` rows, clients poll.
  The generate screen (`src/app/generate.tsx`) is shared: `?mode=flashcards`
  routes it to `generateFlashcards` + `/deck/[id]` (the study screen, which
  renders card images via `expo-image` + signed URLs). Deck list lives on the
  **Cards** tab (`src/app/(tabs)/flashcards.tsx`); detail is `src/app/deck/[id].tsx`
  (singular route, like `guide/[id]`, so it never collides with the tab route).

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
- `Screen` spans the full window width (it no longer caps content) so scroll
  containers own full-width scrolling — on web the wheel then works across the
  whole window, not just the centered column. Each scrollable screen applies
  `screenScroll` from `src/components/ui/screen.tsx` (`style={screenScroll.scroll}`
  for the full-width scroll node + `contentContainerStyle={[screenScroll.content,
  …]}` to cap+center content to `MaxContentWidth`). `ScreenHeader` self-caps the
  same way; non-scroll content in a `Screen` (e.g. `welcome`) must cap itself
  (`width:'100%'` + `maxWidth: MaxContentWidth` + `alignSelf:'center'` + gutter).

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
