// Topic extraction: once a material is indexed, Gemini reads its content and
// identifies the main topics it covers, classifying each under three systems
// (OpenAlex 4-level hierarchy, bepress Digital Commons 3-tier taxonomy,
// Wikipedia categories). Results land in material_topics (one row per topic)
// so study tools can offer a topic picker. Triggered from check-material in
// the background; materials.topics_status tracks the run:
//   pending -> extracting -> extracted | error
//
// Content comes from GCS for transcripts and plain-text uploads; binary
// documents (PDF/DOCX/PPTX/…) reuse the text Vertex AI Search parsed at
// import time via chunks.list, so nothing is parsed twice.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { readObjectText } from './gcs.ts';
import { listDocumentChunks, searchChunks } from './discovery.ts';
import { generateJson } from './gemini.ts';

// Enough to characterize even a long textbook without blowing the budget.
const MAX_CONTENT_CHARS = 120_000;
const MAX_TOPICS = 8;
const MAX_WIKIPEDIA_CATEGORIES = 8;

// The top of each taxonomy is small enough to pin exactly in the prompt;
// deeper levels are best-effort labels from the model.
const OPENALEX_DOMAINS = [
  'Physical Sciences',
  'Life Sciences',
  'Social Sciences',
  'Health Sciences',
];

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

const DIGITAL_COMMONS_TIER1 = [
  'Architecture',
  'Arts and Humanities',
  'Business',
  'Education',
  'Engineering',
  'Law',
  'Life Sciences',
  'Medicine and Health Sciences',
  'Physical Sciences and Mathematics',
  'Social and Behavioral Sciences',
];

const SYSTEM_PROMPT = `You are Grappnel's academic classifier. You receive the text content (or lecture transcript) of one course material a student uploaded. Identify the main topics the material substantively covers and classify every topic under three classification systems.

Topic rules:
- Return 1 to ${MAX_TOPICS} topics. A focused handout or single lecture usually covers 1-3; a broad textbook or long recording may cover more.
- "name" is a short student-facing label for the topic as this material presents it (e.g. "Light reactions of photosynthesis"), at most 200 characters.
- "summary" is one sentence describing what this material covers about the topic.
- Only include topics with substantial coverage. Skip passing mentions, boilerplate, and administrative content (syllabus logistics, grading, homework instructions).

Classification systems (apply all three to every topic):
1. OpenAlex hierarchy (domain > field > subfield > topic):
   - "openalex_domain" MUST be exactly one of: ${OPENALEX_DOMAINS.join('; ')}.
   - "openalex_field" MUST be exactly one of the 26 OpenAlex fields, and must belong to the chosen domain:
${OPENALEX_DOMAINS.map((d) => `     ${d}: ${OPENALEX_FIELDS[d].join('; ')}`).join('\n')}
   - "openalex_subfield" and "openalex_topic" are the closest matching OpenAlex subfield and topic names (best effort; e.g. subfield "Plant Science", topic "Photosynthesis and Carbon Fixation Processes").
2. bepress Digital Commons three-tier discipline taxonomy:
   - "digital_commons_tier1" MUST be exactly one of: ${DIGITAL_COMMONS_TIER1.join('; ')}.
   - "digital_commons_tier2" is the closest matching second-tier discipline (e.g. "Biology"); "digital_commons_tier3" is the third-tier discipline when one clearly applies (e.g. "Plant Biology") — omit it otherwise.
3. "wikipedia_categories": 2-${MAX_WIKIPEDIA_CATEGORIES} English Wikipedia category names that best describe the topic, without the "Category:" prefix (e.g. "Photosynthesis", "Light-dependent reactions").`;

const TOPICS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    topics: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          summary: { type: 'STRING' },
          openalex_domain: { type: 'STRING' },
          openalex_field: { type: 'STRING' },
          openalex_subfield: { type: 'STRING' },
          openalex_topic: { type: 'STRING' },
          digital_commons_tier1: { type: 'STRING' },
          digital_commons_tier2: { type: 'STRING' },
          digital_commons_tier3: { type: 'STRING' },
          wikipedia_categories: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: [
          'name',
          'summary',
          'openalex_domain',
          'openalex_field',
          'openalex_subfield',
          'openalex_topic',
          'digital_commons_tier1',
          'digital_commons_tier2',
          'wikipedia_categories',
        ],
      },
    },
  },
  required: ['topics'],
};

interface ExtractedTopic {
  name?: string;
  summary?: string;
  openalex_domain?: string;
  openalex_field?: string;
  openalex_subfield?: string;
  openalex_topic?: string;
  digital_commons_tier1?: string;
  digital_commons_tier2?: string;
  digital_commons_tier3?: string;
  wikipedia_categories?: string[];
}

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

// Transcripts and text uploads are read verbatim from GCS; anything Vertex
// had to parse (PDF/Office) is read back as its indexed chunks.
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

function toRow(materialId: string, userId: string, topic: ExtractedTopic) {
  const name = cleanLabel(topic.name);
  if (!name) return null;
  const categories = (topic.wikipedia_categories ?? [])
    .map((c) => cleanLabel(c.replace(/^Category:\s*/i, '')))
    .filter((c): c is string => c !== null)
    .slice(0, MAX_WIKIPEDIA_CATEGORIES);
  return {
    material_id: materialId,
    user_id: userId,
    name,
    summary: cleanLabel(topic.summary, 1000),
    openalex_domain: cleanLabel(topic.openalex_domain),
    openalex_field: cleanLabel(topic.openalex_field),
    openalex_subfield: cleanLabel(topic.openalex_subfield),
    openalex_topic: cleanLabel(topic.openalex_topic),
    digital_commons_tier1: cleanLabel(topic.digital_commons_tier1),
    digital_commons_tier2: cleanLabel(topic.digital_commons_tier2),
    digital_commons_tier3: cleanLabel(topic.digital_commons_tier3),
    wikipedia_categories: categories,
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

    const result = await generateJson<{ topics?: ExtractedTopic[] }>(
      SYSTEM_PROMPT,
      `Material title: ${material.title}\nFile name: ${material.file_name}\n\nContent:\n${content}`,
      TOPICS_SCHEMA,
    );

    const rows = (result.topics ?? [])
      .map((topic) => toRow(material.id, material.user_id, topic))
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .slice(0, MAX_TOPICS);
    if (rows.length === 0) throw new Error('Gemini returned no usable topics');

    // Replace, don't append, so re-runs stay idempotent.
    const { error: deleteError } = await admin
      .from('material_topics')
      .delete()
      .eq('material_id', material.id);
    if (deleteError) throw new Error(deleteError.message);
    const { error: insertError } = await admin.from('material_topics').insert(rows);
    if (insertError) throw new Error(insertError.message);

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
