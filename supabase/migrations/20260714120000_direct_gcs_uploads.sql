-- Uploads now stream straight from the client to GCS: create-upload mints a
-- resumable upload session (object name/type/size pinned server-side),
-- creates the row with gcs_object preassigned, and the client PUTs the bytes
-- directly — Supabase Storage is no longer a pass-through. New lifecycle:
--   uploading -> syncing -> [transcribing ->] indexing -> indexed | error
--   uploading: row exists, resumable session open, client still sending bytes
-- 'uploaded' remains valid for legacy rows that still live in Supabase
-- Storage (storage_path); new rows leave storage_path NULL.

ALTER TABLE public.materials
  DROP CONSTRAINT materials_status_check;

ALTER TABLE public.materials
  ADD CONSTRAINT materials_status_check
  CHECK (status IN ('uploading', 'uploaded', 'syncing', 'transcribing', 'indexing', 'indexed', 'error'));

-- Uploads are identified by their GCS object now; storage_path only remains
-- on legacy rows.
ALTER TABLE public.materials
  DROP CONSTRAINT materials_source_check;

ALTER TABLE public.materials
  ADD CONSTRAINT materials_source_check CHECK (
    (source_type = 'upload' AND (gcs_object IS NOT NULL OR storage_path IS NOT NULL)) OR
    (source_type = 'youtube' AND source_url IS NOT NULL)
  );
