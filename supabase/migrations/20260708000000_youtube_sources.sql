-- Materials can now come from YouTube links, not just file uploads.
--   source_type: 'upload' (file in Supabase Storage) | 'youtube' (source_url)
--   source_url:  canonical watch URL for youtube materials; also lets guide
--                citations deep-link back to the timestamped section.
-- YouTube materials have no Storage object, so storage_path becomes nullable.

ALTER TABLE public.materials
  ADD COLUMN source_type text NOT NULL DEFAULT 'upload'
    CHECK (source_type IN ('upload', 'youtube')),
  ADD COLUMN source_url text;

ALTER TABLE public.materials
  ALTER COLUMN storage_path DROP NOT NULL;

ALTER TABLE public.materials
  ADD CONSTRAINT materials_source_check CHECK (
    (source_type = 'upload' AND storage_path IS NOT NULL) OR
    (source_type = 'youtube' AND source_url IS NOT NULL)
  );
