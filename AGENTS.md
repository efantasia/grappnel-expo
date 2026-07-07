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
- `npx supabase db push` / `npx supabase functions deploy` — deploy backend

## Architecture rules

- **Everything is user-scoped.** Postgres RLS keys on `auth.uid() = user_id`;
  Storage paths and GCS objects are prefixed `<user_id>/`; every Vertex AI
  Search query MUST include the `user_id: ANY("<uid>")` filter
  (`supabase/functions/_shared/discovery.ts` enforces UUID validation to keep
  filter expressions injection-safe).
- Edge functions use the service role (RLS bypassed) and therefore must
  always add `.eq('user_id', user.id)` to queries.
- Material lifecycle: `uploaded → syncing → indexing → indexed | error`
  (statuses set by `sync-material` / `check-material`). Vertex imports are
  **INCREMENTAL** with one JSONL manifest per material — never use FULL
  reconciliation, it would purge other users' documents.
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
