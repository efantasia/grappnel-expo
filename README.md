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
gcloud config configurations activate grappnel
```

```bash
./scripts/setup-gcp.sh <gcp-project-id>
```

This creates the GCS bucket, the Vertex AI Search datastore (layout parser +
chunking, explicit filterable schema), a search engine, and a
`grappnel-functions` service account with a key in `secrets/` (gitignored).
It prints the exact `npx supabase secrets set …` command to run afterwards.

### 3. Run

```bash
npm run dev        # Expo dev server (press w for web, i for iOS, a for Android)
npm run typecheck
npm run build:web  # static web export in dist/
```

## Edge functions

| Function | Purpose |
| --- | --- |
| `sync-material` | Copy upload from Supabase Storage → GCS, write JSONL manifest, trigger incremental Vertex import. `metadata_only: true` re-syncs title/folder without re-copying. |
| `check-material` | Poll the import operation; settles status to `indexed` / `error`. |
| `delete-material` | Remove the search document, GCS objects, Storage file, and DB row. |
| `generate-guide` | Retrieve chunks (user-scoped, optional folder/material filter), generate a Markdown study guide with Gemini in the background, update the `study_guides` row. |

## Supported file types

PDF, TXT, MD, HTML, DOCX, PPTX, XLSX — up to 100 MB per file (the set Vertex
AI Search indexes directly).
