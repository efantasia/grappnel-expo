import { ServiceResult } from '@/lib/services/folders';
import { supabase } from '@/lib/supabase';
import {
  MaterialSourceType,
  MaterialStatus,
  MaterialTopic,
} from '@/lib/types';

// A material_topics row joined to its material (title/status/folder), so the
// exploration screens can render sources without a second query.
interface JoinedMaterial {
  id: string;
  title: string;
  source_type: MaterialSourceType;
  status: MaterialStatus;
  folder_id: string | null;
}

// The matched OpenAlex topic's authoritative description + keywords, embedded
// via material_topics.openalex_topic_id (null when no topic was matched).
interface JoinedOpenAlexTopic {
  description: string | null;
  keywords: string[] | null;
}

export interface TopicRow extends MaterialTopic {
  materials: JoinedMaterial | null;
  openalex_topics: JoinedOpenAlexTopic | null;
}

// Topics extracted from the user's materials, optionally scoped to a folder
// (null = all materials, matching the generate screen's source picker).
export async function listTopics(
  folderId?: string | null,
): Promise<ServiceResult<TopicRow[]>> {
  let query = supabase
    .from('material_topics')
    .select(
      '*, materials!inner(id, title, source_type, status, folder_id), openalex_topics(description, keywords)',
    )
    .order('created_at', { ascending: false });
  if (folderId) query = query.eq('materials.folder_id', folderId);
  const { data, error } = await query;
  return { data: data as TopicRow[] | null, error: error?.message ?? null };
}

export interface TopicSuggestion {
  name: string;
  materialCount: number;
}

// Collapses per-material topic rows into a deduped suggestion list keyed by
// OpenAlex topic, most widely covered first (same topic across materials counts
// once per material). The label is the OpenAlex topic's display name.
export function toTopicSuggestions(topics: MaterialTopic[]): TopicSuggestion[] {
  const byId = new Map<string, { name: string; materials: Set<string> }>();
  for (const topic of topics) {
    const id = topic.openalex_topic_id;
    const name = topic.openalex_topic;
    if (!id || !name) continue;
    const entry = byId.get(id) ?? { name, materials: new Set<string>() };
    entry.materials.add(topic.material_id);
    byId.set(id, entry);
  }
  return [...byId.values()]
    .map(({ name, materials }) => ({ name, materialCount: materials.size }))
    .sort(
      (a, b) => b.materialCount - a.materialCount || a.name.localeCompare(b.name),
    );
}

export interface TopicMaterialRef {
  id: string;
  title: string;
  source_type: MaterialSourceType;
  status: MaterialStatus;
  folder_id: string | null;
}

// One OpenAlex topic collapsed across every material that covers it. `key` is
// the OpenAlex topic id (stable, used for routing); `name` is the topic's
// display name. Higher levels of the hierarchy are the most common non-null
// label across materials (ties keep the first seen).
export interface AggregatedTopic {
  key: string; // OpenAlex topic id, e.g. "T10085"
  name: string; // OpenAlex topic display name
  materials: TopicMaterialRef[];
  materialCount: number;
  openalexDomain: string | null;
  openalexField: string | null;
  openalexSubfield: string | null;
  openalexTopic: string | null;
  openalexTopicId: string;
  openalexDescription: string | null;
  openalexKeywords: string[];
  wikipediaUrl: string | null;
  wikipediaTitle: string | null;
}

function mostCommon(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function aggregateTopics(rows: TopicRow[]): AggregatedTopic[] {
  const byKey = new Map<
    string,
    { name: string; rows: TopicRow[]; materials: Map<string, TopicMaterialRef> }
  >();

  for (const row of rows) {
    const key = row.openalex_topic_id;
    const name = row.openalex_topic;
    if (!key || !name) continue;
    const entry = byKey.get(key) ?? {
      name,
      rows: [],
      materials: new Map<string, TopicMaterialRef>(),
    };
    entry.rows.push(row);
    if (row.materials) {
      entry.materials.set(row.materials.id, {
        id: row.materials.id,
        title: row.materials.title,
        source_type: row.materials.source_type,
        status: row.materials.status,
        folder_id: row.materials.folder_id,
      });
    }
    byKey.set(key, entry);
  }

  const result: AggregatedTopic[] = [];
  for (const [key, entry] of byKey) {
    // Description, keywords and the Wikipedia article all follow the matched
    // OpenAlex topic, so take them together from one representative matched row
    // rather than resolving each separately.
    const matchedRow =
      entry.rows.find((r) => r.openalex_topic_id) ?? entry.rows[0];
    result.push({
      key,
      name: entry.name,
      materials: [...entry.materials.values()],
      materialCount: entry.materials.size,
      openalexDomain: mostCommon(entry.rows.map((r) => r.openalex_domain)),
      openalexField: mostCommon(entry.rows.map((r) => r.openalex_field)),
      openalexSubfield: mostCommon(entry.rows.map((r) => r.openalex_subfield)),
      openalexTopic: mostCommon(entry.rows.map((r) => r.openalex_topic)),
      openalexTopicId: key,
      openalexDescription: matchedRow?.openalex_topics?.description ?? null,
      openalexKeywords: matchedRow?.openalex_topics?.keywords ?? [],
      wikipediaUrl: matchedRow?.wikipedia_url ?? null,
      wikipediaTitle: matchedRow?.wikipedia_title ?? null,
    });
  }
  return result;
}

// The OpenAlex hierarchy levels a user can browse topics by. (Wikipedia is a
// single article per topic — a per-topic link, not a grouping.)
export type TopicDimension = 'field' | 'domain';

export interface TopicGroup {
  key: string;
  label: string;
  sublabel: string | null; // e.g. the OpenAlex domain above a field
  topics: AggregatedTopic[];
}

const UNCLASSIFIED = 'Unclassified';

// Buckets topics by the chosen classification level; each topic lands in
// exactly one group. Groups are ordered by size (Unclassified last); topics
// within a group by how many sources cover them.
export function groupTopics(
  topics: AggregatedTopic[],
  dimension: TopicDimension,
): TopicGroup[] {
  const groups = new Map<string, TopicGroup>();
  const add = (label: string, sublabel: string | null, topic: AggregatedTopic) => {
    const group = groups.get(label) ?? { key: label, label, sublabel, topics: [] };
    group.topics.push(topic);
    groups.set(label, group);
  };

  for (const topic of topics) {
    if (dimension === 'domain') {
      add(topic.openalexDomain ?? UNCLASSIFIED, null, topic);
    } else {
      add(topic.openalexField ?? UNCLASSIFIED, topic.openalexDomain, topic);
    }
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.topics.sort(
      (a, b) => b.materialCount - a.materialCount || a.name.localeCompare(b.name),
    );
  }
  list.sort((a, b) => {
    if (a.label === UNCLASSIFIED) return 1;
    if (b.label === UNCLASSIFIED) return -1;
    return b.topics.length - a.topics.length || a.label.localeCompare(b.label);
  });
  return list;
}

// The OpenAlex hierarchy a topic falls under, formatted as a breadcrumb path.
export function openAlexPath(topic: AggregatedTopic): string {
  return [
    topic.openalexDomain,
    topic.openalexField,
    topic.openalexSubfield,
    topic.openalexTopic,
  ]
    .filter(Boolean)
    .join('  ›  ');
}
