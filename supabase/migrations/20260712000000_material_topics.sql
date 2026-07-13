-- Topic extraction: after a material is indexed, Gemini identifies the main
-- topics it covers and classifies each one under three systems (OpenAlex's
-- 4-level hierarchy, the bepress Digital Commons 3-tier taxonomy, and
-- Wikipedia categories). One material_topics row per topic per material.
--
-- materials.topics_status tracks the extraction lifecycle independently of
-- the indexing status (extraction runs in the background after 'indexed'):
--   pending -> extracting -> extracted | error
-- A full (non-metadata) re-sync resets it to 'pending'.

ALTER TABLE public.materials
  ADD COLUMN topics_status text NOT NULL DEFAULT 'pending'
    CHECK (topics_status IN ('pending', 'extracting', 'extracted', 'error')),
  ADD COLUMN topics_error text;

CREATE TABLE public.material_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  summary text,
  -- OpenAlex hierarchy, one column per level (domain > field > subfield > topic)
  openalex_domain text,
  openalex_field text,
  openalex_subfield text,
  openalex_topic text,
  -- bepress Digital Commons three-tier discipline taxonomy
  digital_commons_tier1 text,
  digital_commons_tier2 text,
  digital_commons_tier3 text,
  -- English Wikipedia category names (without the "Category:" prefix)
  wikipedia_categories text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX material_topics_user_id_idx ON public.material_topics(user_id);
CREATE INDEX material_topics_material_id_idx ON public.material_topics(material_id);

ALTER TABLE public.material_topics ENABLE ROW LEVEL SECURITY;

-- Rows are written only by edge functions (service role); clients read.
CREATE POLICY "Users can view own material topics" ON public.material_topics
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
