import { invokeFunction } from '@/lib/functions';
import { ServiceResult } from '@/lib/services/folders';
import { supabase } from '@/lib/supabase';
import { StudyGuide } from '@/lib/types';

export async function listGuides(): Promise<ServiceResult<StudyGuide[]>> {
  const { data, error } = await supabase
    .from('study_guides')
    .select('*')
    .order('created_at', { ascending: false });
  return { data: data as StudyGuide[] | null, error: error?.message ?? null };
}

export async function getGuide(id: string): Promise<ServiceResult<StudyGuide>> {
  const { data, error } = await supabase
    .from('study_guides')
    .select('*')
    .eq('id', id)
    .single();
  return { data: data as StudyGuide | null, error: error?.message ?? null };
}

export interface GenerateGuideInput {
  topic: string;
  title?: string;
  folderId?: string | null;
  materialIds?: string[];
}

// Returns immediately with a 'generating' guide row; poll getGuide until the
// status settles (the edge function finishes in the background).
export async function generateGuide(
  input: GenerateGuideInput,
): Promise<ServiceResult<StudyGuide>> {
  const { data, error } = await invokeFunction<{ guide: StudyGuide }>(
    'generate-guide',
    {
      topic: input.topic,
      title: input.title,
      folder_id: input.folderId ?? null,
      material_ids: input.materialIds,
    },
  );
  return { data: data?.guide ?? null, error };
}

export async function deleteGuide(id: string): Promise<ServiceResult<true>> {
  const { error } = await supabase.from('study_guides').delete().eq('id', id);
  return { data: error ? null : true, error: error?.message ?? null };
}
