// Generates the consolidated topic-extraction migration from the OpenAlex API
// (https://api.openalex.org/topics) — the machine-readable source of the same
// ~4,500-topic list published in the OpenAlex "Topics" spreadsheet. Every
// topic carries its subfield/field/domain (with ids), description, keywords,
// and canonical Wikipedia URL. The classifier constrains its choices to this
// list so it can't invent topics; re-run this to refresh when OpenAlex revises
// its topics.
//
//   npm run topics:refresh   (node scripts/fetch-openalex-topics.mjs)
//
// Emits supabase/migrations/<stamp>_topic_extraction.sql — the ENTIRE feature
// schema (materials.topics_status, the openalex_topics reference table + seed,
// and material_topics) in one file — and prints the 4 domains / 26 fields to
// paste into the classifier prompt.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase/migrations/20260712000000_topic_extraction.sql');
const API = 'https://api.openalex.org/topics';
const SELECT = 'id,display_name,description,keywords,ids,subfield,field,domain';

const shortId = (url) => (url ? url.split('/').pop() : null);

// OpenAlex occasionally returns junk (e.g. the literal string "NaN") where a
// value should be null, so treat non-strings and known sentinels as empty.
function cleanText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'NaN' || trimmed === 'null' || trimmed === 'undefined') {
    return null;
  }
  return trimmed;
}

// Accept only real Wikipedia article URLs; anything else (including "NaN")
// becomes null. Returns the URL and its derived title together.
function cleanWikipedia(value) {
  const url = cleanText(value);
  if (!url || !/^https?:\/\/[^\s]*wikipedia\.org\/wiki\//i.test(url)) {
    return { url: null, title: null };
  }
  const slug = url.split('/wiki/').pop();
  let title = null;
  try {
    title = decodeURIComponent(slug).replace(/_/g, ' ');
  } catch {
    title = slug.replace(/_/g, ' ');
  }
  return { url, title };
}

async function fetchAllTopics() {
  const topics = [];
  let cursor = '*';
  while (cursor) {
    const url = `${API}?per-page=200&select=${SELECT}&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'grappnel-topics-seed' } });
    if (!res.ok) throw new Error(`OpenAlex ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const t of data.results) {
      const wiki = cleanWikipedia(t.ids?.wikipedia);
      topics.push({
        topic_id: shortId(t.id),
        display_name: t.display_name,
        description: cleanText(t.description),
        keywords: Array.isArray(t.keywords)
          ? t.keywords.map(cleanText).filter((k) => k !== null)
          : [],
        subfield_id: shortId(t.subfield?.id),
        subfield_name: t.subfield?.display_name ?? null,
        field_id: shortId(t.field?.id),
        field_name: t.field?.display_name ?? null,
        domain_id: shortId(t.domain?.id),
        domain_name: t.domain?.display_name ?? null,
        wikipedia_url: wiki.url,
        wikipedia_title: wiki.title,
      });
    }
    cursor = data.meta.next_cursor;
    process.stderr.write(`\rfetched ${topics.length}/${data.meta.count}`);
  }
  process.stderr.write('\n');
  return topics;
}

const text = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const textArray = (arr) =>
  !arr || arr.length === 0
    ? `'{}'`
    : `ARRAY[${arr.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ')}]`;

function seedStatements(topics) {
  const cols = [
    'topic_id',
    'display_name',
    'description',
    'keywords',
    'subfield_id',
    'subfield_name',
    'field_id',
    'field_name',
    'domain_id',
    'domain_name',
    'wikipedia_url',
    'wikipedia_title',
  ];
  const render = (t) =>
    `  (${text(t.topic_id)}, ${text(t.display_name)}, ${text(t.description)}, ${textArray(t.keywords)}, ` +
    `${text(t.subfield_id)}, ${text(t.subfield_name)}, ${text(t.field_id)}, ${text(t.field_name)}, ` +
    `${text(t.domain_id)}, ${text(t.domain_name)}, ${text(t.wikipedia_url)}, ${text(t.wikipedia_title)})`;

  const out = [];
  const BATCH = 500;
  for (let i = 0; i < topics.length; i += BATCH) {
    out.push(`INSERT INTO public.openalex_topics (${cols.join(', ')}) VALUES`);
    out.push(topics.slice(i, i + BATCH).map(render).join(',\n') + ';');
    out.push('');
  }
  return out.join('\n');
}

function buildMigration(topics) {
  return `-- Topic extraction (consolidated). After a material is indexed,
-- check-material runs Gemini topic extraction (_shared/topics.ts): it finds the
-- main topics and classifies each against the OFFICIAL OpenAlex taxonomy, which
-- lives in openalex_topics below (${topics.length} rows, seeded from
-- api.openalex.org by scripts/fetch-openalex-topics.mjs — re-run to refresh).
-- The classifier can only pick a topic that exists in that table
-- (material_topics.openalex_topic_id is FK-constrained to it), so it can never
-- hallucinate a topic id, name, or its Wikipedia article.
--
-- materials.topics_status tracks the run independently of indexing:
--   pending -> extracting -> extracted | error

-- ---------------------------------------------------------------------------
-- materials: topic-extraction lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE public.materials
  ADD COLUMN topics_status text NOT NULL DEFAULT 'pending'
    CHECK (topics_status IN ('pending', 'extracting', 'extracted', 'error')),
  ADD COLUMN topics_error text;

-- ---------------------------------------------------------------------------
-- openalex_topics: authoritative reference data (domain > field > subfield >
-- topic; each with its id, description, keywords, and canonical Wikipedia
-- article). Read-only; the classifier selects OpenAlex topics ONLY from here.
-- ---------------------------------------------------------------------------
CREATE TABLE public.openalex_topics (
  topic_id text PRIMARY KEY,
  display_name text NOT NULL,
  description text,
  keywords text[] NOT NULL DEFAULT '{}',
  subfield_id text NOT NULL,
  subfield_name text NOT NULL,
  field_id text NOT NULL,
  field_name text NOT NULL,
  domain_id text NOT NULL,
  domain_name text NOT NULL,
  wikipedia_url text,
  wikipedia_title text
);

CREATE INDEX openalex_topics_field_name_idx ON public.openalex_topics(field_name);

ALTER TABLE public.openalex_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read openalex topics" ON public.openalex_topics
  FOR SELECT TO authenticated USING (true);

${seedStatements(topics)}
-- ---------------------------------------------------------------------------
-- material_topics: one row per OpenAlex topic per material. A topic IS the
-- matched OpenAlex topic (no freeform name/summary): the hierarchy names + ids
-- and the canonical Wikipedia article are copied from the matched openalex_topics
-- row. openalex_topic_id is required (only matched topics are stored) and unique
-- per material.
-- ---------------------------------------------------------------------------
CREATE TABLE public.material_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE CASCADE,
  openalex_domain text,
  openalex_field text,
  openalex_subfield text,
  openalex_topic text,
  openalex_domain_id text,
  openalex_field_id text,
  openalex_subfield_id text,
  openalex_topic_id text NOT NULL REFERENCES public.openalex_topics(topic_id),
  wikipedia_url text,
  wikipedia_title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_id, openalex_topic_id)
);

CREATE INDEX material_topics_user_id_idx ON public.material_topics(user_id);
CREATE INDEX material_topics_material_id_idx ON public.material_topics(material_id);

ALTER TABLE public.material_topics ENABLE ROW LEVEL SECURITY;

-- Rows are written only by edge functions (service role); clients read.
CREATE POLICY "Users can view own material topics" ON public.material_topics
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
`;
}

const topics = await fetchAllTopics();

// Safety net: never ship 'NaN' (or other sentinel junk) in any column.
const junk = [];
for (const t of topics) {
  for (const [key, value] of Object.entries(t)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => v === 'NaN' || v === 'null' || v === 'undefined')) {
      junk.push(`${t.topic_id}.${key}`);
    }
  }
}
if (junk.length) {
  throw new Error(`Refusing to write migration — sentinel values remain in: ${junk.slice(0, 20).join(', ')}`);
}

writeFileSync(MIGRATION, buildMigration(topics));

const domains = [...new Set(topics.map((t) => t.domain_name))].filter(Boolean).sort();
const fieldsByDomain = {};
for (const t of topics) {
  if (!t.domain_name || !t.field_name) continue;
  (fieldsByDomain[t.domain_name] ??= new Set()).add(t.field_name);
}
const missingWiki = topics.filter((t) => !t.wikipedia_url).length;
const missingDesc = topics.filter((t) => !t.description).length;

console.log(`\nWrote ${MIGRATION}`);
console.log(`Topics: ${topics.length}  (no Wikipedia URL: ${missingWiki}, no description: ${missingDesc})`);
console.log(`\nDomains (${domains.length}) and their fields:`);
for (const d of domains) {
  console.log(`\n${d}:`);
  console.log('  ' + [...fieldsByDomain[d]].sort().join('; '));
}
