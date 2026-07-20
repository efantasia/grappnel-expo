import { invokeFunction } from '@/lib/functions';
import { ServiceResult } from '@/lib/services/folders';
import { supabase } from '@/lib/supabase';

// Mints short-lived signed URLs for a set of figures (the GCS bucket is
// private) so the client can display them — used by both the flashcard study
// screen and study guides. Returns a map keyed by figure id.
export async function signFigureUrls(
  figureIds: string[],
): Promise<ServiceResult<Record<string, string>>> {
  if (figureIds.length === 0) return { data: {}, error: null };
  const { data, error } = await invokeFunction<{ urls: Record<string, string> }>(
    'sign-figures',
    { figure_ids: figureIds },
  );
  return { data: data?.urls ?? null, error };
}

// Whether any figure in scope carries detected labels — i.e. whether image
// occlusion cards are possible for these sources. Scoped to a folder (null =
// all the user's materials); RLS keeps it to the signed-in user. Only the
// `labels` column is fetched and emptiness is checked client-side.
export async function hasLabeledFigures(
  folderId?: string | null,
): Promise<ServiceResult<boolean>> {
  let query = supabase
    .from('material_figures')
    .select('labels, materials!inner(folder_id)')
    .limit(1000);
  if (folderId) query = query.eq('materials.folder_id', folderId);
  const { data, error } = await query;
  if (error) return { data: null, error: error.message };
  const available = (data ?? []).some(
    (row: { labels: unknown }) =>
      Array.isArray(row.labels) && row.labels.length > 0,
  );
  return { data: available, error: null };
}
