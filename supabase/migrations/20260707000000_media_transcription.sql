-- Audio/video materials are transcribed (Cloud Run job -> Velma) before
-- indexing, adding a 'transcribing' step to the material lifecycle:
--   uploaded -> syncing -> [transcribing ->] indexing -> indexed | error
-- transcript_object holds the GCS transcript that Vertex indexes for media
-- materials (documents keep indexing gcs_object directly).

ALTER TABLE public.materials
  DROP CONSTRAINT materials_status_check;

ALTER TABLE public.materials
  ADD CONSTRAINT materials_status_check
  CHECK (status IN ('uploaded', 'syncing', 'transcribing', 'indexing', 'indexed', 'error'));

ALTER TABLE public.materials
  ADD COLUMN transcript_object text;
