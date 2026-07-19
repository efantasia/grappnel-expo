-- Figure extraction + image flashcards.
--
-- After a document material indexes, a Cloud Run job (gcp/extract-figures-job)
-- pulls the embedded images out of the source file (PDF/DOCX/PPTX/XLSX),
-- normalizes + captions them, and writes them to GCS
-- (figures/<user_id>/<material_id>/…). check-material then records one
-- material_figures row per kept figure. materials.figures_status tracks the
-- run independently of indexing/topics:
--   pending -> processing -> extracting -> extracted | skipped | error
--     pending:    queued (default; also the value between upload and first sync)
--     processing: the extraction job is running (watched by check-material)
--     extracting: the manifest landed and rows are being written
--     extracted:  material_figures rows are in place
--     skipped:    material has no image-bearing file (text, audio, video, YT)
--     error:      extraction failed (figures_error holds the message)
--
-- Flashcard decks are generated like study guides (generate-flashcards, async):
-- each card may reference one material_figures row so the front/back can show
-- a figure from the student's own materials.

ALTER TABLE public.materials
  ADD COLUMN figures_status text NOT NULL DEFAULT 'pending'
    CHECK (figures_status IN
      ('pending', 'processing', 'extracting', 'extracted', 'skipped', 'error')),
  ADD COLUMN figures_error text;

-- Existing materials predate figure extraction; leave them alone rather than
-- showing them as perpetually "pending". A re-sync moves them into the flow.
UPDATE public.materials SET figures_status = 'skipped';

-- ---------------------------------------------------------------------------
-- material_figures — one image extracted from a material's source file
-- ---------------------------------------------------------------------------
CREATE TABLE public.material_figures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE CASCADE,
  -- GCS object under figures/<user_id>/<material_id>/… (private bucket; the
  -- client fetches display URLs via the sign-figures edge function).
  gcs_object text NOT NULL,
  -- Stable order within the material (drives display + card references).
  ordinal integer NOT NULL,
  -- 1-based source page for PDFs; NULL for Office files (no reliable mapping).
  page integer,
  width integer,
  height integer,
  mime_type text NOT NULL,
  -- Gemini-authored, from reading the image at extraction time.
  caption text,
  alt_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_id, ordinal)
);

CREATE INDEX material_figures_user_id_idx ON public.material_figures(user_id);
CREATE INDEX material_figures_material_id_idx ON public.material_figures(material_id);

ALTER TABLE public.material_figures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own figures" ON public.material_figures
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own figures" ON public.material_figures
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own figures" ON public.material_figures
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own figures" ON public.material_figures
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- flashcard_decks — a generated set of cards on one or more topics
-- ---------------------------------------------------------------------------
CREATE TABLE public.flashcard_decks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 200),
  topic text NOT NULL,
  status text NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'complete', 'error')),
  error_message text,
  card_count integer,
  source_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX flashcard_decks_user_id_idx ON public.flashcard_decks(user_id);
CREATE INDEX flashcard_decks_folder_id_idx ON public.flashcard_decks(folder_id);

ALTER TABLE public.flashcard_decks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own decks" ON public.flashcard_decks
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own decks" ON public.flashcard_decks
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own decks" ON public.flashcard_decks
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own decks" ON public.flashcard_decks
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER flashcard_decks_updated_at
  BEFORE UPDATE ON public.flashcard_decks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- flashcards — the cards in a deck, optionally tied to a figure
-- ---------------------------------------------------------------------------
CREATE TABLE public.flashcards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id uuid NOT NULL REFERENCES public.flashcard_decks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  front text NOT NULL,
  back text NOT NULL,
  hint text,
  -- The figure shown with the card, or NULL for a text-only card. SET NULL so
  -- deleting/ re-extracting a source degrades the card to text instead of
  -- vanishing it.
  figure_id uuid REFERENCES public.material_figures(id) ON DELETE SET NULL,
  citation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deck_id, ordinal)
);

CREATE INDEX flashcards_deck_id_idx ON public.flashcards(deck_id);
CREATE INDEX flashcards_user_id_idx ON public.flashcards(user_id);

ALTER TABLE public.flashcards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own flashcards" ON public.flashcards
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own flashcards" ON public.flashcards
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own flashcards" ON public.flashcards
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own flashcards" ON public.flashcards
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Explicit Data API grants (see 20260715120000_api_role_grants.sql): newer
-- Supabase stacks don't auto-expose new tables to the API roles. RLS above
-- still gates every row.
grant all privileges on public.material_figures to anon, authenticated, service_role;
grant all privileges on public.flashcard_decks to anon, authenticated, service_role;
grant all privileges on public.flashcards to anon, authenticated, service_role;
