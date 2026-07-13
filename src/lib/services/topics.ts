import { ServiceResult } from '@/lib/services/folders';
import { supabase } from '@/lib/supabase';
import { MaterialTopic } from '@/lib/types';

// Topics extracted from the user's materials, optionally scoped to a folder
// (null = all materials, matching the generate screen's source picker).
export async function listTopics(
  folderId?: string | null,
): Promise<ServiceResult<MaterialTopic[]>> {
  let query = supabase
    .from('material_topics')
    .select('*, materials!inner(folder_id)')
    .order('created_at', { ascending: false });
  if (folderId) query = query.eq('materials.folder_id', folderId);
  const { data, error } = await query;
  return { data: data as MaterialTopic[] | null, error: error?.message ?? null };
}

export interface TopicSuggestion {
  name: string;
  materialCount: number;
}

// Collapses per-material topic rows into a deduped suggestion list, most
// widely covered topics first (same topic across materials counts once per
// material).
export function toTopicSuggestions(topics: MaterialTopic[]): TopicSuggestion[] {
  const byName = new Map<string, { name: string; materials: Set<string> }>();
  for (const topic of topics) {
    const key = topic.name.trim().toLowerCase();
    if (!key) continue;
    const entry = byName.get(key) ?? { name: topic.name.trim(), materials: new Set<string>() };
    entry.materials.add(topic.material_id);
    byName.set(key, entry);
  }
  return [...byName.values()]
    .map(({ name, materials }) => ({ name, materialCount: materials.size }))
    .sort(
      (a, b) => b.materialCount - a.materialCount || a.name.localeCompare(b.name),
    );
}
