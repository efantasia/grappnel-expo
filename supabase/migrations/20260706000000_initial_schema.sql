-- Grappnel initial schema: profiles, folders, materials, study_guides.
-- Every table is owner-scoped with RLS keyed on auth.uid() = user_id
-- (profiles keys on id). Edge functions use the service role and always
-- filter by the authenticated user's id explicitly.

-- Shared updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Auto-create a profile row for every new auth user. SECURITY DEFINER because
-- the trigger fires as supabase_auth_admin, which has no INSERT grant on
-- public tables.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'display_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- folders
-- ---------------------------------------------------------------------------
CREATE TABLE public.folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX folders_user_id_idx ON public.folders(user_id);

ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own folders" ON public.folders
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own folders" ON public.folders
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own folders" ON public.folders
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own folders" ON public.folders
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER folders_updated_at
  BEFORE UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- materials
-- ---------------------------------------------------------------------------
-- status flow: uploaded -> syncing -> indexing -> indexed | error
--   uploaded: file is in Supabase Storage, not yet copied to GCS
--   syncing:  sync-material is copying to GCS / triggering the import
--   indexing: Vertex AI Search import operation is running (index_operation)
--   indexed:  searchable in the datastore
CREATE TABLE public.materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 200),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  file_size bigint,
  storage_path text NOT NULL,
  gcs_object text,
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'syncing', 'indexing', 'indexed', 'error')),
  error_message text,
  index_operation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX materials_user_id_idx ON public.materials(user_id);
CREATE INDEX materials_folder_id_idx ON public.materials(folder_id);

ALTER TABLE public.materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own materials" ON public.materials
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own materials" ON public.materials
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own materials" ON public.materials
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own materials" ON public.materials
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER materials_updated_at
  BEFORE UPDATE ON public.materials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- study_guides
-- ---------------------------------------------------------------------------
CREATE TABLE public.study_guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 200),
  topic text NOT NULL,
  content text,
  status text NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'complete', 'error')),
  error_message text,
  source_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX study_guides_user_id_idx ON public.study_guides(user_id);
CREATE INDEX study_guides_folder_id_idx ON public.study_guides(folder_id);

ALTER TABLE public.study_guides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own study guides" ON public.study_guides
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own study guides" ON public.study_guides
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own study guides" ON public.study_guides
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own study guides" ON public.study_guides
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER study_guides_updated_at
  BEFORE UPDATE ON public.study_guides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Storage: private per-user materials bucket. Object paths are
-- <user_id>/<material_id>/<file_name>, so policies key on the first folder.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('materials', 'materials', false, 104857600) -- 100 MB per file
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can upload own material files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'materials' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can view own material files" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'materials' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete own material files" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'materials' AND (storage.foldername(name))[1] = auth.uid()::text);
