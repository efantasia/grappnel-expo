import { invokeFunction } from '@/lib/functions';
import { ServiceResult } from '@/lib/services/folders';

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
