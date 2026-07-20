// Generates a study guide: retrieves the most relevant chunks from the
// user's indexed materials via Vertex AI Search (scoped by user_id and
// optionally a folder or explicit materials), then asks Gemini to write a
// structured Markdown guide from them.
//
// The row is created immediately with status 'generating' and the heavy work
// runs via EdgeRuntime.waitUntil, so the client gets the guide id right away
// and polls the study_guides row for completion.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { searchChunks, RetrievedChunk } from '../_shared/discovery.ts';
import { generateText } from '../_shared/gemini.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const SYSTEM_PROMPT = `You are Grappnel, an expert study assistant that builds study guides for students from their own course materials.

You will receive one or more topics and numbered excerpts retrieved from the student's uploaded materials (textbooks, lecture notes, slides). Write a comprehensive study guide in Markdown based ONLY on those excerpts.

Requirements:
- Write in GitHub-Flavored Markdown. Do NOT emit raw HTML — no <br>, <b>, <sup> or any other tags. Separate paragraphs with a blank line and use Markdown for every bit of formatting.
- Do NOT begin with a top-level title heading that restates the topic — the app already shows the guide's title. Start directly with a one-paragraph overview of the topic(s).
- When several topics are given, cover each of them, organizing the body so every topic is addressed (a dedicated section per topic works well when they are distinct).
- Organize the body into clear sections with ## headings; use bullet points, tables, and **bold key terms** where helpful.
- Write any mathematical expression, formula, symbol, or unit as LaTeX: inline math delimited by single dollar signs ($...$) and display math by double dollar signs ($$...$$). For example: $\\text{GFR} < 60 \\text{ mL/min/1.73m}^2$. Never write LaTeX outside of these delimiters, and never wrap non-mathematical prose in dollar signs.
- Include a "Key Terms" section defining important vocabulary.
- Include a "Self-Check Questions" section with 5-8 questions (answers in a separate "Answers" section at the end).
- Each excerpt is labeled with the source it came from. When a point comes from a specific source, cite it inline like [Source: <source name>], using the source name exactly as it appears in the excerpt label. Place the citation right after the fact it supports; do not add extra spaces before it.
- Excerpts from recorded lectures contain timestamp markers like [12:04] or [1:05:30] at the start of sentences or paragraphs. When citing such a source, include the timestamp of the marker immediately preceding the supporting content: [Source: <source name> @ 12:04]. Copy timestamps exactly as they appear — never invent or adjust them.
- Document excerpts (from PDFs, slides, and notes) show a page number in the excerpt label like "(p. 12)". When citing such a source, include that page: [Source: <source name> @ p.12]. Copy the page number exactly from the label of the excerpt you used — never invent, guess, or adjust it, and omit the page entirely if the excerpt's label shows none.
- Outside of citations, never reproduce the bracketed timestamp markers in the guide text.
- You may be given a numbered list of figures (images) extracted from the materials. When a figure directly illustrates a point, reference it ON ITS OWN LINE with the exact marker [[figure:N]] (N = the figure's number from the list), placed right after the paragraph it illustrates. Reference a figure at most once, only when it genuinely helps a reader, and never use a number that is not in the list. Do not describe the marker or write image Markdown yourself — just the [[figure:N]] marker. If no figures are provided or none fit, add none.
- If the excerpts only partially cover the topic, cover what they contain and add a short "Gaps to Review" note listing what the student should look up in their materials.
- Do not invent facts that are not supported by the excerpts.`;

interface SourceInfo {
  name: string; // the citation label: file name for uploads, title for YouTube
  url: string | null;
}

// The materials table is the source of truth for source names; the titles
// Vertex returns with chunks can degrade to GCS object names (material ids).
async function sourcesByMaterial(
  admin: SupabaseClient,
  userId: string,
  chunks: RetrievedChunk[],
): Promise<Map<string, SourceInfo>> {
  const ids = [...new Set(chunks.map((c) => c.materialId).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { data } = await admin
    .from('materials')
    .select('id, file_name, title, source_type, source_url')
    .in('id', ids)
    .eq('user_id', userId);
  return new Map(
    (data ?? []).map((m) => [
      m.id as string,
      {
        name: (m.source_type === 'youtube' ? m.title : m.file_name) as string,
        url: (m.source_url as string | null) ?? null,
      },
    ]),
  );
}

function buildContext(chunks: RetrievedChunk[], sources: Map<string, SourceInfo>): string {
  return chunks
    .map((chunk, i) => {
      const name = sources.get(chunk.materialId)?.name ?? chunk.title;
      // Show the page (from Vertex's layout parser) in the label so the model
      // can copy it into the citation, exactly as it copies transcript timestamps.
      const page = chunk.page ? ` (p. ${chunk.page})` : '';
      return `[${i + 1}] ${name}${page}\n${chunk.content}`;
    })
    .join('\n\n---\n\n');
}

interface FigureRef {
  id: string;
  materialId: string;
  caption: string | null;
  altText: string | null;
}

// Figures from the materials the retrieval matched — the same relevance
// heuristic flashcards use ("figures from the sources this topic draws on").
async function figuresForGuide(
  admin: SupabaseClient,
  userId: string,
  materialIds: string[],
): Promise<FigureRef[]> {
  if (materialIds.length === 0) return [];
  const { data } = await admin
    .from('material_figures')
    .select('id, material_id, caption, alt_text, ordinal')
    .in('material_id', materialIds)
    .eq('user_id', userId)
    .order('material_id', { ascending: true })
    .order('ordinal', { ascending: true })
    .limit(24);
  return (data ?? []).map((f) => ({
    id: f.id as string,
    materialId: f.material_id as string,
    caption: (f.caption as string | null) ?? null,
    altText: (f.alt_text as string | null) ?? null,
  }));
}

function buildFigureList(figures: FigureRef[], sources: Map<string, SourceInfo>): string {
  if (figures.length === 0) return 'No figures are available for these sources.';
  return figures
    .map((f, i) => {
      const source = sources.get(f.materialId)?.name ?? 'source';
      return `[${i}] (Source: ${source}) ${f.caption ?? f.altText ?? 'figure (no description)'}`;
    })
    .join('\n');
}

// The most chunks any single guide feeds to Gemini, and the ceiling on how
// many topics one request may fan out into (each topic is its own search).
const CHUNK_CAP = 18;
const MAX_TOPICS = 8;

// Retrieves chunks for each topic separately and interleaves them round-robin,
// so a multi-topic guide gives every topic balanced representation instead of
// letting one topic's high-scoring chunks crowd out the others. Deduped by
// (material, chunk text) since the same excerpt can match several topics.
async function retrieveForTopics(
  topics: string[],
  scope: { userId: string; folderId: string | null; materialIds: string[] | undefined },
): Promise<RetrievedChunk[]> {
  const perTopic = Math.max(5, Math.ceil(CHUNK_CAP / topics.length));
  const lists = await Promise.all(
    topics.map((topic) => searchChunks(topic, scope, perTopic)),
  );

  const seen = new Set<string>();
  const merged: RetrievedChunk[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && merged.length < CHUNK_CAP; i++) {
    for (const list of lists) {
      if (merged.length >= CHUNK_CAP) break;
      const chunk = list[i];
      if (!chunk) continue;
      const key = `${chunk.materialId}::${chunk.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(chunk);
    }
  }
  return merged;
}

function timestampToSeconds(ts: string): number | null {
  const parts = ts.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

// [Source: name], [Source: name @ 12:04] (media timestamp), or
// [Source: name @ p.12] (document page). Group 1 = name, 2 = timestamp,
// 3 = page — a citation carries at most one of the latter two.
const CITATION_RE =
  /\[Source:\s*([^\]@]+?)(?:\s*@\s*(?:(\d{1,2}(?::\d{2}){1,2})|p\.?\s*(\d{1,4})))?\]/gi;

// Builds the timestamped watch URL for a source citation (…&t=724s), or the
// plain URL when there is no timestamp. Returns null for sources without a URL.
function citationHref(
  url: string | undefined,
  ts: string | undefined,
): string | null {
  if (!url) return null;
  const seconds = ts ? timestampToSeconds(ts) : null;
  return seconds !== null
    ? `${url}${url.includes('?') ? '&' : '?'}t=${seconds}s`
    : url;
}

// Gemini cites plain "[Source: <name>]" inline, optionally with a media
// timestamp ("@ 12:04") or a document page ("@ p.12"). Rewrites each distinct
// citation to a numbered footnote reference `[^n]` and appends the definitions
// under a "### Sources" heading (the client renders the references as tappable
// superscripts and the list as linked footnotes). Sources with a URL (YouTube
// lectures) get a Markdown link jumping to that moment; done deterministically
// here rather than trusting the model to construct URLs. Any raw <br> the model
// slips in is left as-is for the client to sanitize (it handles <br> inside
// tables, which must stay on one line).
function footnoteCitations(content: string, sources: Map<string, SourceInfo>): string {
  const urlByName = new Map<string, string>();
  for (const source of sources.values()) {
    if (source.url) urlByName.set(source.name, source.url);
  }

  const numberByKey = new Map<string, number>();
  const order: { name: string; ts: string | undefined; page: string | undefined }[] = [];

  const body = content.replace(
    CITATION_RE,
    (_match, rawName: string, ts: string | undefined, page: string | undefined) => {
      const name = rawName.trim();
      // A distinct (source, moment) — timestamp OR page — gets its own footnote.
      const key = ts ? `${name}@${ts}` : page ? `${name}#p${page}` : name;
      let n = numberByKey.get(key);
      if (n === undefined) {
        n = order.length + 1;
        numberByKey.set(key, n);
        order.push({ name, ts, page });
      }
      return `[^${n}]`;
    },
  );

  if (order.length === 0) return body;

  const defs = order.map(({ name, ts, page }, i) => {
    const label = ts ? `${name} @ ${ts}` : page ? `${name}, p. ${page}` : name;
    // Only media sources (YouTube) have a URL to deep-link; document pages
    // render as plain text (there's no per-page link into an uploaded file).
    const href = citationHref(urlByName.get(name), ts);
    return `[^${i + 1}]: ${href ? `[${label}](${href})` : label}`;
  });

  return `${body.trimEnd()}\n\n### Sources\n\n${defs.join('\n')}\n`;
}

// Rewrites the model's inline [[figure:N]] markers into Markdown images the
// client resolves to signed URLs (grappnel-figure://<id>). The id/URL is set
// here — never by the model — and each figure is embedded at most once. An
// invalid or already-used index drops the marker.
const FIGURE_MARKER_RE = /\[\[figure:(\d+)\]\]/g;

function sanitizeCaption(text: string): string {
  return text.replace(/[[\]()\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function embedFigures(content: string, figures: FigureRef[]): string {
  const used = new Set<string>();
  return content.replace(FIGURE_MARKER_RE, (_match, nStr: string) => {
    const n = Number(nStr);
    const fig = Number.isInteger(n) && n >= 0 && n < figures.length ? figures[n] : null;
    if (!fig || used.has(fig.id)) return '';
    used.add(fig.id);
    const caption = sanitizeCaption(fig.caption ?? fig.altText ?? 'Figure');
    return `\n\n![${caption}](grappnel-figure://${fig.id})\n\n`;
  });
}

async function runGeneration(
  guideId: string,
  userId: string,
  topics: string[],
  folderId: string | null,
  materialIds: string[] | undefined,
): Promise<void> {
  const admin = adminClient();
  try {
    const chunks = await retrieveForTopics(topics, { userId, folderId, materialIds });

    if (chunks.length === 0) {
      await admin
        .from('study_guides')
        .update({
          status: 'error',
          error_message:
            topics.length > 1
              ? 'No indexed material matched these topics. Make sure your sources have finished indexing, or try broader topics.'
              : 'No indexed material matched this topic. Make sure your sources have finished indexing, or try a broader topic.',
        })
        .eq('id', guideId);
      return;
    }

    const topicLabel =
      topics.length === 1
        ? `Topic: ${topics[0]}`
        : `Topics:\n${topics.map((t) => `- ${t}`).join('\n')}`;
    const chunkMaterialIds = [...new Set(chunks.map((c) => c.materialId).filter(Boolean))];
    const sources = await sourcesByMaterial(admin, userId, chunks);
    const figures = await figuresForGuide(admin, userId, chunkMaterialIds);

    const content = await generateText(
      SYSTEM_PROMPT,
      `${topicLabel}\n\nExcerpts from my materials:\n\n${buildContext(chunks, sources)}` +
        `\n\nFigures available to reference (insert [[figure:N]] on its own line where one illustrates the text):\n${buildFigureList(figures, sources)}`,
    );

    await admin
      .from('study_guides')
      .update({
        content: footnoteCitations(embedFigures(content, figures), sources),
        status: 'complete',
        source_count: chunkMaterialIds.length,
        error_message: null,
      })
      .eq('id', guideId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`generate-guide failed for ${guideId}:`, message);
    await admin
      .from('study_guides')
      .update({ status: 'error', error_message: message })
      .eq('id', guideId);
  }
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: {
    topic?: string;
    topics?: string[];
    title?: string;
    folder_id?: string | null;
    material_ids?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }
  // Accept a `topics` array; fall back to the legacy single `topic` string.
  const rawTopics = Array.isArray(body.topics) ? body.topics : [body.topic];
  const topics = [
    ...new Set(rawTopics.map((t) => t?.trim()).filter((t): t is string => !!t)),
  ].slice(0, MAX_TOPICS);
  if (topics.length === 0) return errorResponse('at least one topic is required');
  const topicSummary = topics.join(', ');

  const admin = adminClient();
  const { data: guide, error: insertError } = await admin
    .from('study_guides')
    .insert({
      user_id: user.id,
      folder_id: body.folder_id ?? null,
      title: body.title?.trim() || topicSummary,
      topic: topicSummary,
      status: 'generating',
    })
    .select()
    .single();
  if (insertError || !guide) {
    return errorResponse(insertError?.message ?? 'Could not create guide', 500);
  }

  const generation = runGeneration(
    guide.id,
    user.id,
    topics,
    body.folder_id ?? null,
    body.material_ids,
  );
  if (typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(generation);
  } else {
    await generation;
  }

  return jsonResponse({ guide });
});
