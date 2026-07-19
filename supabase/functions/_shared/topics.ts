// Topic extraction: once a material is indexed, Gemini reads its content and
// identifies the main topics it covers, classifying each against the official
// OpenAlex taxonomy. Results land in material_topics (one row per topic) so
// study tools can offer a topic picker. Triggered from check-material in the
// background; materials.topics_status tracks the run: pending -> extracting ->
// extracted | error.
//
// OpenAlex classification is pinned to the authoritative openalex_topics table
// (seeded from api.openalex.org) so it can't hallucinate a topic. Two stages:
//   1. Gemini reads the content and proposes candidate topics, each tagged with
//      an OpenAlex domain + field (constrained to the 4/26 official names).
//   2. For each field, Gemini picks the single best-matching OFFICIAL topic id
//      from that field's rows in openalex_topics (using their names + keywords),
//      or none. The chosen row's subfield/field/domain ids+names and its
//      canonical Wikipedia article are copied verbatim — nothing about OpenAlex
//      or Wikipedia is model-authored.
//
// Content comes from GCS for transcripts and plain-text uploads; binary
// documents (PDF/DOCX/PPTX/…) reuse the text Vertex AI Search parsed at import
// time via chunks.list, so nothing is parsed twice.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { readObjectText } from './gcs.ts';
import { listDocumentChunks, searchChunks } from './discovery.ts';
import { generateJson } from './gemini.ts';

// Enough to characterize even a long textbook without blowing the budget.
const MAX_CONTENT_CHARS = 120_000;
const MAX_TOPICS = 8;

const OPENALEX_DOMAINS = [
  'Physical Sciences',
  'Life Sciences',
  'Social Sciences',
  'Health Sciences',
];

// The 26 OpenAlex fields per domain, verbatim from the openalex_topics data
// (scripts/fetch-openalex-topics.mjs). These strings MUST match field_name in
// the table exactly — they narrow the candidate list in stage 2.
const OPENALEX_FIELDS: Record<string, string[]> = {
  'Physical Sciences': [
    'Chemical Engineering',
    'Chemistry',
    'Computer Science',
    'Earth and Planetary Sciences',
    'Energy',
    'Engineering',
    'Environmental Science',
    'Materials Science',
    'Mathematics',
    'Physics and Astronomy',
  ],
  'Life Sciences': [
    'Agricultural and Biological Sciences',
    'Biochemistry, Genetics and Molecular Biology',
    'Immunology and Microbiology',
    'Neuroscience',
    'Pharmacology, Toxicology and Pharmaceutics',
  ],
  'Social Sciences': [
    'Arts and Humanities',
    'Business, Management and Accounting',
    'Decision Sciences',
    'Economics, Econometrics and Finance',
    'Psychology',
    'Social Sciences',
  ],
  'Health Sciences': [
    'Dentistry',
    'Health Professions',
    'Medicine',
    'Nursing',
    'Veterinary',
  ],
};

// ---------------------------------------------------------------------------
// Stage 1 — content -> candidate topics (with an OpenAlex domain + field to
// narrow the authoritative lookup in stage 2)
// ---------------------------------------------------------------------------

const STAGE1_PROMPT = `You are Grappnel's academic classifier. You receive the text content (or lecture transcript) of one course material a student uploaded. Identify the main topics the material substantively covers.

Topic rules:
- Return 0 to ${MAX_TOPICS} topics. A focused handout or single lecture usually covers 1-3; a broad textbook or long recording may cover more. Return an empty list if the material has no substantive academic topic (e.g. purely administrative or logistical content) — do not force a topic that isn't there.
- "name" is a short student-facing label for the topic as this material presents it (e.g. "Light reactions of photosynthesis"), at most 200 characters.
- "summary" is one sentence describing what this material covers about the topic.
- Only include topics with substantial coverage. Skip passing mentions, boilerplate, and administrative content (syllabus logistics, grading, homework instructions).

For every topic, place it in the OpenAlex taxonomy (used to look the topic up in the official OpenAlex list afterwards):
- "openalex_domain" MUST be exactly one of: ${OPENALEX_DOMAINS.join('; ')}.
- "openalex_field" MUST be exactly one of the 26 OpenAlex fields below, and must belong to the chosen domain. Pick the single best field:
${OPENALEX_DOMAINS.map((d) => `    ${d}: ${OPENALEX_FIELDS[d].join('; ')}`).join('\n')}`;

const STAGE1_SCHEMA = {
  type: 'OBJECT',
  properties: {
    topics: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          summary: { type: 'STRING' },
          openalex_domain: { type: 'STRING', enum: OPENALEX_DOMAINS },
          openalex_field: {
            type: 'STRING',
            enum: Object.values(OPENALEX_FIELDS).flat(),
          },
        },
        required: ['name', 'summary', 'openalex_domain', 'openalex_field'],
      },
    },
  },
  required: ['topics'],
};

interface CandidateTopic {
  name?: string;
  summary?: string;
  openalex_domain?: string;
  openalex_field?: string;
}

// ---------------------------------------------------------------------------
// Stage 2 — candidate -> official OpenAlex topic id (per field)
// ---------------------------------------------------------------------------

interface OpenAlexTopicRow {
  topic_id: string;
  display_name: string;
  keywords: string[] | null;
  subfield_id: string;
  subfield_name: string;
  field_id: string;
  field_name: string;
  domain_id: string;
  domain_name: string;
  wikipedia_url: string | null;
  wikipedia_title: string | null;
}

const STAGE2_SCHEMA = {
  type: 'OBJECT',
  properties: {
    matches: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          topic_id: { type: 'STRING' }, // "" when nothing fits
        },
        required: ['index', 'topic_id'],
      },
    },
  },
  required: ['matches'],
};

// Asks Gemini to map each extracted topic (referenced by its index) to the id
// of the single best official topic in `topics`, or "" for no good match.
async function pickOfficialTopics(
  fieldName: string,
  entries: { index: number; name: string; summary: string }[],
  topics: OpenAlexTopicRow[],
): Promise<Map<number, string>> {
  const list = topics
    .map((t) => {
      const keywords = t.keywords?.length ? ` — keywords: ${t.keywords.join(', ')}` : '';
      return `${t.topic_id}\t${t.display_name} (${t.subfield_name})${keywords}`;
    })
    .join('\n');
  const extracted = entries
    .map((e) => `[${e.index}] ${e.name} — ${e.summary}`)
    .join('\n');

  const prompt = `Field: ${fieldName}

Below are topics extracted from a course material, then the official OpenAlex topics in this field (one per line: "<topic_id>\\t<name> (<subfield>) — keywords: ..."). Use the names and keywords to judge fit. For each extracted topic, choose the single best-matching official topic and return its exact topic_id. If none is a reasonable match, return an empty string for that index. Only use topic_id values that appear in the list.

Extracted topics:
${extracted}

Official OpenAlex topics in ${fieldName}:
${list}`;

  const result = await generateJson<{ matches?: { index?: number; topic_id?: string }[] }>(
    'You match described topics to a fixed list of official topic ids. Never invent an id.',
    prompt,
    STAGE2_SCHEMA,
  );

  const picks = new Map<number, string>();
  for (const match of result.matches ?? []) {
    if (typeof match.index === 'number' && typeof match.topic_id === 'string') {
      picks.set(match.index, match.topic_id.trim());
    }
  }
  return picks;
}

interface OpenAlexAssignment {
  domainId: string | null;
  domainName: string | null;
  fieldId: string | null;
  fieldName: string | null;
  subfieldId: string | null;
  subfieldName: string | null;
  topicId: string | null;
  topicName: string | null;
  wikipediaUrl: string | null;
  wikipediaTitle: string | null;
}

function topicLevelAssignment(row: OpenAlexTopicRow): OpenAlexAssignment {
  return {
    domainId: row.domain_id,
    domainName: row.domain_name,
    fieldId: row.field_id,
    fieldName: row.field_name,
    subfieldId: row.subfield_id,
    subfieldName: row.subfield_name,
    topicId: row.topic_id,
    topicName: row.display_name,
    wikipediaUrl: row.wikipedia_url,
    wikipediaTitle: row.wikipedia_title,
  };
}

// Resolves each candidate's OpenAlex placement against the authoritative table.
// Every candidate whose field is recognized gets at least domain+field (the
// field enum comes from the table, so this is authoritative too); those Gemini
// can match to a specific topic also get subfield/topic/Wikipedia. One stage-2
// call per distinct field.
async function classifyOpenAlex(
  admin: SupabaseClient,
  candidates: CandidateTopic[],
): Promise<Map<number, OpenAlexAssignment>> {
  const indicesByField = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const field = cleanLabel(candidate.openalex_field);
    if (!field) return;
    const existing = indicesByField.get(field);
    if (existing) existing.push(index);
    else indicesByField.set(field, [index]);
  });

  const assignments = new Map<number, OpenAlexAssignment>();
  for (const [fieldName, indices] of indicesByField) {
    const { data: topics } = await admin
      .from('openalex_topics')
      .select(
        'topic_id, display_name, keywords, subfield_id, subfield_name, field_id, field_name, domain_id, domain_name, wikipedia_url, wikipedia_title',
      )
      .eq('field_name', fieldName)
      .limit(1000);
    if (!topics?.length) continue; // unrecognized field -> leave OpenAlex null

    const rows = topics as OpenAlexTopicRow[];
    const byId = new Map(rows.map((row) => [row.topic_id, row]));
    const group = new Set(indices);
    const picks = await pickOfficialTopics(
      fieldName,
      indices.map((index) => ({
        index,
        name: cleanLabel(candidates[index].name) ?? '',
        summary: cleanLabel(candidates[index].summary, 1000) ?? '',
      })),
      rows,
    );
    for (const [index, topicId] of picks) {
      if (!group.has(index)) continue; // ignore stray indices from the model
      const row = byId.get(topicId);
      if (row) assignments.set(index, topicLevelAssignment(row));
    }
  }
  return assignments;
}

// ---------------------------------------------------------------------------

// The materials-row fields extraction needs (edge functions read rows untyped).
export interface TopicSourceMaterial {
  id: string;
  user_id: string;
  title: string;
  file_name: string;
  mime_type: string;
  gcs_object: string | null;
  transcript_object: string | null;
}

// Transcripts and text uploads are read verbatim from GCS; anything Vertex had
// to parse (PDF/Office) is read back as its indexed chunks.
async function materialContent(material: TopicSourceMaterial): Promise<string> {
  if (material.transcript_object) {
    return (await readObjectText(material.transcript_object)).slice(0, MAX_CONTENT_CHARS);
  }
  if (material.mime_type.startsWith('text/') && material.gcs_object) {
    return (await readObjectText(material.gcs_object)).slice(0, MAX_CONTENT_CHARS);
  }
  let chunks: string[];
  try {
    chunks = await listDocumentChunks(material.id, MAX_CONTENT_CHARS);
  } catch (err) {
    console.warn(`chunks.list unavailable for ${material.id}, falling back to search:`, err);
    const results = await searchChunks(
      material.title,
      { userId: material.user_id, materialIds: [material.id] },
      50,
    );
    chunks = results.map((c) => c.content);
  }
  return chunks.join('\n\n').slice(0, MAX_CONTENT_CHARS);
}

function cleanLabel(value: string | undefined, maxLength = 200): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

// A material_topics row is now purely the matched OpenAlex topic — no
// Gemini-authored name/summary. The display name is the OpenAlex topic's
// display_name (openalex_topic) and the description comes from the joined
// openalex_topics row on the client.
function toRow(materialId: string, userId: string, oa: OpenAlexAssignment) {
  return {
    material_id: materialId,
    user_id: userId,
    openalex_domain: oa.domainName,
    openalex_field: oa.fieldName,
    openalex_subfield: oa.subfieldName,
    openalex_topic: oa.topicName,
    openalex_domain_id: oa.domainId,
    openalex_field_id: oa.fieldId,
    openalex_subfield_id: oa.subfieldId,
    openalex_topic_id: oa.topicId,
    wikipedia_url: oa.wikipediaUrl,
    wikipedia_title: oa.wikipediaTitle,
  };
}

// Runs the full extraction for one material. Safe to fire-and-forget: the
// topics_status claim makes concurrent calls no-ops, and failures land in
// topics_status/topics_error instead of throwing. A full re-sync resets the
// status to 'pending' for a fresh run.
export async function extractMaterialTopics(
  admin: SupabaseClient,
  material: TopicSourceMaterial,
): Promise<void> {
  const { data: claimed } = await admin
    .from('materials')
    .update({ topics_status: 'extracting', topics_error: null })
    .eq('id', material.id)
    .eq('user_id', material.user_id)
    .in('topics_status', ['pending', 'error'])
    .select('id');
  if (!claimed?.length) return;

  try {
    const content = await materialContent(material);
    if (!content.trim()) throw new Error('No content available for topic extraction');

    const stage1 = await generateJson<{ topics?: CandidateTopic[] }>(
      STAGE1_PROMPT,
      `Material title: ${material.title}\nFile name: ${material.file_name}\n\nContent:\n${content}`,
      STAGE1_SCHEMA,
    );
    const candidates = (stage1.topics ?? []).slice(0, MAX_TOPICS);
    const openalex = await classifyOpenAlex(admin, candidates);

    // Keep only candidates that matched an official OpenAlex topic, deduped by
    // topic id (two candidates can map to the same topic; the unique
    // (material_id, openalex_topic_id) constraint forbids storing it twice).
    const seen = new Set<string>();
    const rows = [];
    for (let index = 0; index < candidates.length; index++) {
      const oa = openalex.get(index);
      if (!oa?.topicId || seen.has(oa.topicId)) continue;
      seen.add(oa.topicId);
      rows.push(toRow(material.id, material.user_id, oa));
    }
    // Zero matched topics is a valid outcome — some materials have no clear
    // academic subject (syllabi, admin handouts). Clear any previous rows
    // (idempotent replace) and mark extracted rather than treating "no topics"
    // as an error.
    const { error: deleteError } = await admin
      .from('material_topics')
      .delete()
      .eq('material_id', material.id);
    if (deleteError) throw new Error(deleteError.message);
    if (rows.length > 0) {
      const { error: insertError } = await admin.from('material_topics').insert(rows);
      if (insertError) throw new Error(insertError.message);
    }

    await admin
      .from('materials')
      .update({ topics_status: 'extracted', topics_error: null })
      .eq('id', material.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`topic extraction failed for ${material.id}:`, message);
    await admin
      .from('materials')
      .update({ topics_status: 'error', topics_error: message.slice(0, 500) })
      .eq('id', material.id);
  }
}
