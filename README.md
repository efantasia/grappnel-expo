# Grappnel

Grappnel turns students' course materials — textbooks, lecture notes, slides —
into study guides. Upload sources, organize them into folders, and generate
topic-focused guides built only from your own materials via RAG.

**Stack:** Expo (iOS / Android / web) · Supabase (auth, Postgres, Storage,
edge functions) · Google Cloud (GCS, Vertex AI Search, Gemini).

## How it works

```
upload (app) ─→ Supabase Storage (materials/<user_id>/…)
                     │  sync-material edge function
                     ▼
               GCS bucket  content/<user_id>/<material_id>.<ext>
                           metadata/<user_id>/<material_id>.jsonl
                     │                          │
                     │ (audio/video)            │ (documents)
                     ▼                          │
               grappnel-transcribe              │
               Cloud Run job                    │
               (ffmpeg → Velma STT)             │
                     │                          │
                     ▼                          │
               transcripts/<user_id>/<material_id>.txt
                     │                          │
                     └────────┬─────────────────┘
                              │  documents:import (INCREMENTAL)
                              ▼
               Vertex AI Search datastore
                 structData: { user_id, folder_id, material_id, title }
                     │  search filter: user_id: ANY("<uid>") [AND folder_id…]
                     ▼
               generate-guide edge function ─→ Gemini ─→ study_guides row
```

Every layer is scoped by user id: Postgres RLS (`auth.uid() = user_id`),
Storage policies (per-user folders), GCS object prefixes, and a mandatory
`user_id` filter on every Vertex AI Search query.

## Setup

### 1. Supabase

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push                 # applies supabase/migrations
npx supabase functions deploy        # deploys all four edge functions
```

Copy `.env.example` to `.env` and fill in `EXPO_PUBLIC_SUPABASE_URL` and
`EXPO_PUBLIC_SUPABASE_ANON_KEY` from the project's API settings.

### 2. Google Cloud

To switch gcloud to this project's configuration:

```bash
gcloud config configurations activate personal
```

```bash
VELMA_API_KEY=<modulate-console-admin-key> ./scripts/setup-gcp.sh <gcp-project-id>
```

This creates the GCS bucket, the Vertex AI Search datastore (layout parser +
chunking, explicit filterable schema), a search engine, the
`grappnel-transcribe` Cloud Run job (audio extraction + Velma transcription
for audio/video uploads; the Modulate API key goes into Secret Manager), and
a `grappnel-functions` service account with a key in `secrets/` (gitignored).
It prints the exact `npx supabase secrets set …` command to run afterwards.

`VELMA_API_KEY` is a Console Admin key from the
[Modulate platform](https://platform.modulate.ai). It's only needed on the
first run (or omit it to skip the transcription job — document uploads still
work). Re-deploy the job after changing `gcp/transcribe-job/`:

```bash
gcloud run jobs deploy grappnel-transcribe --source gcp/transcribe-job \
  --region us-central1 --project <gcp-project-id>
```

### 3. Run

```bash
npm run dev        # Expo dev server (press w for web, i for iOS, a for Android)
npm run typecheck
npm run build:web  # static web export in dist/
```

## Edge functions

| Function | Purpose |
| --- | --- |
| `sync-material` | Copy upload from Supabase Storage → GCS; documents trigger an incremental Vertex import, audio/video starts the `grappnel-transcribe` Cloud Run job. `metadata_only: true` re-syncs title/folder without re-copying. |
| `check-material` | Settle in-flight statuses: watch GCS for the transcript (then import it) while `transcribing`, poll the import operation while `indexing`. |
| `delete-material` | Remove the search document, GCS objects (content + transcript), Storage file, and DB row. |
| `generate-guide` | Retrieve chunks (user-scoped, optional folder/material filter), generate a Markdown study guide with Gemini in the background, update the `study_guides` row. |

## Supported file types

Up to 100 MB per file:

- **Documents** — PDF, TXT, MD, HTML, DOCX, PPTX, XLSX (the set Vertex AI
  Search indexes directly).
- **Audio/video** — MP3, M4A, WAV, AAC, FLAC, OGG, MP4, MOV, WEBM. These are
  transcribed first (`grappnel-transcribe` Cloud Run job: ffmpeg extracts a
  mono 16 kHz track, Modulate's Velma batch API transcribes it) and the
  transcript is what gets indexed; guides cite the original file name.
