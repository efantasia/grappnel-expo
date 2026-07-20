// Generates a flashcard deck: retrieves the most relevant chunks from the
// user's indexed materials (scoped by user_id and optionally a folder or
// explicit materials), offers Gemini the figures extracted from those same
// materials, and asks it to write a deck of Q/A cards — some of which attach a
// figure so the card can show an image from the student's own materials.
//
// Like generate-guide, the deck row is created immediately with status
// 'generating' and the heavy work runs via EdgeRuntime.waitUntil; clients poll
// the flashcard_decks row for completion.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { searchChunks, RetrievedChunk } from '../_shared/discovery.ts';
import { generateJson, generateJsonFromParts } from '../_shared/gemini.ts';
import { readObjectBase64 } from '../_shared/gcs.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

type CardType = 'basic' | 'cloze' | 'image_occlusion';
const ALL_CARD_TYPES: CardType[] = ['basic', 'cloze', 'image_occlusion'];

// The count the student requested, and the bounds we clamp it to.
const DEFAULT_CARD_COUNT = 15;
const MIN_CARD_COUNT = 3;
const MAX_CARD_COUNT = 40;

// One description per card type; only the allowed types are shown to Gemini.
const CARD_TYPE_BLURBS: Record<CardType, string> = {
  basic: '- "basic": "front" is a question, "back" is the answer. Use basic for conceptual or reasoning questions.',
  cloze:
    '- "cloze": a fill-in-the-blank. "front" is a complete statement with the single most important term replaced by exactly "_____" (five underscores); "back" is that missing term only. Example: front "The _____ is the primary site of glucose reabsorption in the nephron.", back "proximal convoluted tubule". Use cloze for definitions, key terms, and labeling facts.',
  image_occlusion:
    '- "image_occlusion": a figure with ONE of its labels masked out for the student to name — only for a figure that lists "Labels". Set "type":"image_occlusion", "figure_index" to that figure, and "label_index" to the label to hide. Write "front" as the prompt (e.g. "Name the highlighted structure in the diagram.") and do NOT include the hidden label\'s text anywhere in the front. The hidden label is the answer. Strongly prefer these for anatomical/labeled-diagram figures — they are the best way to study labeling. You may make several image_occlusion cards from the same figure (one per label): the other quizzed labels are automatically kept covered on every card, so no card ever reveals another card\'s answer.',
};

function buildSystemPrompt(allowed: CardType[], count: number): string {
  const typeLines = allowed.map((t) => CARD_TYPE_BLURBS[t]).join('\n');
  const mixLine =
    allowed.length > 1
      ? `Use a balanced mix of the allowed card types (${allowed.join(', ')}) — do not lean entirely on one type${
          allowed.includes('image_occlusion')
            ? ', and use image_occlusion whenever a figure has labels'
            : ''
        }.`
      : `Every card must be of type "${allowed[0]}".`;
  return `You are Grappnel, an expert study assistant that builds flashcards for students from their own course materials.

You will receive one or more topics, numbered excerpts retrieved from the student's uploaded materials, and a numbered list of figures (images) extracted from those materials. Write a set of study flashcards based ONLY on those excerpts and figures.

Card types — set "type" on every card (use ONLY these types):
${typeLines}
${mixLine}

Requirements:
- Produce exactly ${count} flashcards. Every card must be high quality — do not pad with trivial or repetitive cards, but do reach the requested count.
- Keep the front focused on a single idea; keep the back concise but complete.
- Write plain text. Do NOT use Markdown, HTML, or LaTeX delimiters. Write formulas and symbols in readable plain text (e.g. "GFR < 60 mL/min/1.73m^2").
- "hint" is optional: a short nudge that helps recall without giving away the answer.
- Figures: when a listed figure helps a card, set "figure_index" to that figure's number. IMPORTANT: attached images are automatically reviewed and REMOVED if the card's answer is visibly shown on the image (a printed label, title, or caption) — that would give the answer away. So never rely on the image to carry the answer: for a labeling or cloze card, attach a figure only when the answer is NOT written on it, and phrase the card so it still makes sense if the image is removed. Do not attach unrelated figures, and never invent a figure that is not in the list. Omit figure_index (or use -1) for text-only cards.
- "source" is the name of the material the card's content came from, exactly as it appears in the excerpt label (e.g. "Cell Biology Ch 3"). Include it when a card draws on a specific source.
- Cover the topic(s) broadly; when several topics are given, include cards for each.
- Do not invent facts that are not supported by the excerpts or figures.`;
}

function buildCardSchema(allowed: CardType[]) {
  return {
    type: 'OBJECT',
    properties: {
      cards: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            type: { type: 'STRING', enum: allowed },
            front: { type: 'STRING' },
            back: { type: 'STRING' },
            hint: { type: 'STRING' },
            figure_index: { type: 'INTEGER' }, // -1 (or omitted) => no figure
            label_index: { type: 'INTEGER' }, // for image_occlusion: which label to hide
            source: { type: 'STRING' },
          },
          required: ['type', 'front', 'back'],
        },
      },
    },
    required: ['cards'],
  };
}

interface GeneratedCard {
  type?: string;
  front?: string;
  back?: string;
  hint?: string;
  figure_index?: number;
  label_index?: number;
  source?: string;
}

interface SourceInfo {
  name: string;
}

interface FigureLabel {
  text: string;
  box: number[]; // [x, y, w, h] fractions
}

interface FigureOption {
  id: string;
  materialId: string;
  caption: string | null;
  altText: string | null;
  gcsObject: string;
  mimeType: string;
  labels: FigureLabel[];
}

const CHUNK_CAP = 20;
const MAX_TOPICS = 8;
const MAX_FIGURES_OFFERED = 30;

// Round-robin retrieval across topics (mirrors generate-guide) so every topic
// gets balanced representation. Deduped by (material, chunk text).
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

// Source names from the materials table (Vertex titles can degrade to ids).
async function sourcesByMaterial(
  admin: SupabaseClient,
  userId: string,
  materialIds: string[],
): Promise<Map<string, SourceInfo>> {
  if (materialIds.length === 0) return new Map();
  const { data } = await admin
    .from('materials')
    .select('id, file_name, title, source_type')
    .in('id', materialIds)
    .eq('user_id', userId);
  return new Map(
    (data ?? []).map((m) => [
      m.id as string,
      { name: (m.source_type === 'youtube' ? m.title : m.file_name) as string },
    ]),
  );
}

// Figures from the materials the retrieval matched — the relevance heuristic is
// "figures from the sources this topic draws on".
async function figuresForMaterials(
  admin: SupabaseClient,
  userId: string,
  materialIds: string[],
): Promise<FigureOption[]> {
  if (materialIds.length === 0) return [];
  const { data } = await admin
    .from('material_figures')
    .select('id, material_id, caption, alt_text, ordinal, gcs_object, mime_type, labels')
    .in('material_id', materialIds)
    .eq('user_id', userId)
    .order('material_id', { ascending: true })
    .order('ordinal', { ascending: true })
    .limit(MAX_FIGURES_OFFERED);
  return (data ?? []).map((f) => ({
    id: f.id as string,
    materialId: f.material_id as string,
    caption: (f.caption as string | null) ?? null,
    altText: (f.alt_text as string | null) ?? null,
    gcsObject: f.gcs_object as string,
    mimeType: (f.mime_type as string) || 'image/jpeg',
    labels: (Array.isArray(f.labels) ? f.labels : []) as FigureLabel[],
  }));
}

// Gemini reviews the actual image for each figure-bearing card and drops the
// figure if the card's answer is visibly shown on it (a printed label, title,
// or caption) — so no card ever reveals its own answer in its picture. Runs
// concurrently; a review failure fails safe (drops the image).
const REVIEW_SYSTEM =
  "You check whether a flashcard's answer is visibly present in an image — " +
  'printed as a label, title, caption, or otherwise plainly readable — which ' +
  'would give the answer away to a student studying the card.';

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: { revealed: { type: 'BOOLEAN' } },
  required: ['revealed'],
};

async function reviewFigureReveals(
  rows: { type: string; figure_id: string | null; back: string }[],
  figuresById: Map<string, FigureOption>,
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      // Occlusion cards mask the answer on the image, so they never reveal it.
      if (!row.figure_id || row.type === 'image_occlusion') return;
      const figure = figuresById.get(row.figure_id);
      if (!figure) return;
      try {
        const data = await readObjectBase64(figure.gcsObject);
        const result = await generateJsonFromParts<{ revealed?: boolean }>(
          REVIEW_SYSTEM,
          [
            { inlineData: { mimeType: figure.mimeType, data } },
            {
              text: `The flashcard answer is: "${row.back}". Is this answer visibly revealed in the image (e.g. printed as a label, title, or caption)? Return {"revealed": true} if it is clearly shown, otherwise {"revealed": false}.`,
            },
          ],
          REVIEW_SCHEMA,
        );
        if (result.revealed) row.figure_id = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`figure review failed; dropping image to be safe: ${message}`);
        row.figure_id = null;
      }
    }),
  );
}

function buildContext(chunks: RetrievedChunk[], sources: Map<string, SourceInfo>): string {
  return chunks
    .map((chunk, i) => `[${i + 1}] ${sources.get(chunk.materialId)?.name ?? chunk.title}\n${chunk.content}`)
    .join('\n\n---\n\n');
}

function buildFigureList(
  figures: FigureOption[],
  sources: Map<string, SourceInfo>,
  includeLabels: boolean,
): string {
  if (figures.length === 0) return 'No figures are available for these sources.';
  return figures
    .map((fig, i) => {
      const source = sources.get(fig.materialId)?.name ?? 'source';
      const desc = fig.caption ?? fig.altText ?? 'figure (no description)';
      // Labels drive image_occlusion cards only; omit them when that type is
      // off so Gemini doesn't try to reference occlusion targets.
      const labels =
        includeLabels && fig.labels.length
          ? ` Labels: ${fig.labels.map((l, j) => `[${j}] ${l.text}`).join('; ')}`
          : '';
      return `[${i}] (Source: ${source}) ${desc}${labels}`;
    })
    .join('\n');
}

async function runGeneration(
  deckId: string,
  userId: string,
  topics: string[],
  folderId: string | null,
  materialIds: string[] | undefined,
  cardCount: number,
  allowedTypes: CardType[],
): Promise<void> {
  const admin = adminClient();
  const allowedSet = new Set(allowedTypes);
  const occlusionAllowed = allowedSet.has('image_occlusion');
  try {
    const chunks = await retrieveForTopics(topics, { userId, folderId, materialIds });
    if (chunks.length === 0) {
      await admin
        .from('flashcard_decks')
        .update({
          status: 'error',
          error_message:
            'No indexed material matched these topics. Make sure your sources have finished indexing, or try broader topics.',
        })
        .eq('id', deckId);
      return;
    }

    const chunkMaterialIds = [...new Set(chunks.map((c) => c.materialId).filter(Boolean))];
    const sources = await sourcesByMaterial(admin, userId, chunkMaterialIds);
    const figures = await figuresForMaterials(admin, userId, chunkMaterialIds);

    const topicLabel =
      topics.length === 1
        ? `Topic: ${topics[0]}`
        : `Topics:\n${topics.map((t) => `- ${t}`).join('\n')}`;

    const prompt = `${topicLabel}

Excerpts from my materials:

${buildContext(chunks, sources)}

Figures available to attach (reference by the bracketed number in "figure_index"):
${buildFigureList(figures, sources, occlusionAllowed)}`;

    const result = await generateJson<{ cards?: GeneratedCard[] }>(
      buildSystemPrompt(allowedTypes, cardCount),
      prompt,
      buildCardSchema(allowedTypes),
    );

    const cards = (result.cards ?? [])
      .filter((c) => c.front?.trim() && c.back?.trim())
      .slice(0, cardCount);
    if (cards.length === 0) {
      await admin
        .from('flashcard_decks')
        .update({ status: 'error', error_message: 'Could not build cards from these sources.' })
        .eq('id', deckId);
      return;
    }

    const rows = cards.map((card, i) => {
      const idx = typeof card.figure_index === 'number' ? card.figure_index : -1;
      const figure = idx >= 0 && idx < figures.length ? figures[idx] : null;

      let type: CardType =
        card.type === 'cloze'
          ? 'cloze'
          : card.type === 'image_occlusion'
            ? 'image_occlusion'
            : 'basic';
      // Enforce the requested type mix — coerce anything the model returned
      // outside it (the schema enum makes this a safety net).
      if (!allowedSet.has(type)) {
        type =
          type !== 'basic' && card.front?.includes('_____') && allowedSet.has('cloze')
            ? 'cloze'
            : allowedSet.has('basic')
              ? 'basic'
              : allowedTypes[0];
      }
      let figureId = figure?.id ?? null;
      let occlusion: number[][] | null = null;
      let back = card.back!.trim().slice(0, 4000);

      if (type === 'image_occlusion') {
        const li = typeof card.label_index === 'number' ? card.label_index : -1;
        const label = figure && li >= 0 && li < figure.labels.length ? figure.labels[li] : null;
        if (figure && label) {
          const key = label.text.trim().toLowerCase();
          // Mask every occurrence of the answer text, so a duplicate label
          // elsewhere on the figure can't give it away.
          const boxes = figure.labels
            .filter(
              (l) =>
                l.text.trim().toLowerCase() === key &&
                Array.isArray(l.box) &&
                l.box.length === 4,
            )
            .map((l) => l.box);
          if (boxes.length > 0) {
            occlusion = boxes;
            figureId = figure.id;
            back = label.text.slice(0, 4000); // authoritative answer, not model text
          }
        }
        if (!occlusion) {
          // Invalid occlusion reference — degrade to a plain text card,
          // preferring a type the student allowed.
          type =
            card.front?.includes('_____') && allowedSet.has('cloze')
              ? 'cloze'
              : allowedSet.has('basic')
                ? 'basic'
                : 'basic';
          figureId = null;
        }
      }

      return {
        deck_id: deckId,
        user_id: userId,
        ordinal: i,
        type,
        front: card.front!.trim().slice(0, 4000),
        back,
        hint: card.hint?.trim() ? card.hint.trim().slice(0, 1000) : null,
        figure_id: figureId,
        occlusion,
        occlusion_context: null as number[][] | null,
        citation: card.source?.trim() ? card.source.trim().slice(0, 200) : null,
      };
    });

    // Hide-all-guess-one: when several occlusion cards share a figure, keep
    // every OTHER card's quizzed label covered on this card too, so no card
    // gives away a sibling's answer. `occlusion` stays the card's own target
    // (revealed on the answer); `occlusion_context` holds the sibling targets
    // (masked in every state).
    const occlusionByFigure = new Map<string, typeof rows>();
    for (const row of rows) {
      if (row.type === 'image_occlusion' && row.figure_id && row.occlusion?.length) {
        const group = occlusionByFigure.get(row.figure_id) ?? [];
        group.push(row);
        occlusionByFigure.set(row.figure_id, group);
      }
    }
    for (const group of occlusionByFigure.values()) {
      // Distinct quizzed answer -> its box(es), taken from each card's target.
      const boxesByAnswer = new Map<string, number[][]>();
      for (const row of group) {
        const key = row.back.trim().toLowerCase();
        if (!boxesByAnswer.has(key)) boxesByAnswer.set(key, row.occlusion ?? []);
      }
      for (const row of group) {
        const selfKey = row.back.trim().toLowerCase();
        const context: number[][] = [];
        for (const [key, boxes] of boxesByAnswer) {
          if (key !== selfKey) context.push(...boxes);
        }
        row.occlusion_context = context.length > 0 ? context : null;
      }
    }

    // Drop any figure whose card answer is visible on the image (Gemini review).
    const figuresById = new Map(figures.map((f) => [f.id, f]));
    await reviewFigureReveals(rows, figuresById);

    const { error: insertError } = await admin.from('flashcards').insert(rows);
    if (insertError) throw new Error(insertError.message);

    await admin
      .from('flashcard_decks')
      .update({
        status: 'complete',
        card_count: rows.length,
        source_count: chunkMaterialIds.length,
        error_message: null,
      })
      .eq('id', deckId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`generate-flashcards failed for ${deckId}:`, message);
    await admin
      .from('flashcard_decks')
      .update({ status: 'error', error_message: message })
      .eq('id', deckId);
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
    count?: number;
    card_types?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const rawTopics = Array.isArray(body.topics) ? body.topics : [body.topic];
  const topics = [
    ...new Set(rawTopics.map((t) => t?.trim()).filter((t): t is string => !!t)),
  ].slice(0, MAX_TOPICS);
  if (topics.length === 0) return errorResponse('at least one topic is required');
  const topicSummary = topics.join(', ');

  // How many cards, and which card types the student asked for. Both are
  // clamped/validated here; the canonical type order is kept.
  const rawCount =
    typeof body.count === 'number' && Number.isFinite(body.count)
      ? Math.round(body.count)
      : DEFAULT_CARD_COUNT;
  const cardCount = Math.min(MAX_CARD_COUNT, Math.max(MIN_CARD_COUNT, rawCount));

  const requestedTypes = Array.isArray(body.card_types)
    ? ALL_CARD_TYPES.filter((t) => body.card_types!.includes(t))
    : [];
  const allowedTypes = requestedTypes.length > 0 ? requestedTypes : ALL_CARD_TYPES;

  const admin = adminClient();
  const { data: deck, error: insertError } = await admin
    .from('flashcard_decks')
    .insert({
      user_id: user.id,
      folder_id: body.folder_id ?? null,
      title: body.title?.trim() || topicSummary,
      topic: topicSummary,
      status: 'generating',
    })
    .select()
    .single();
  if (insertError || !deck) {
    return errorResponse(insertError?.message ?? 'Could not create deck', 500);
  }

  const generation = runGeneration(
    deck.id,
    user.id,
    topics,
    body.folder_id ?? null,
    body.material_ids,
    cardCount,
    allowedTypes,
  );
  if (typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(generation);
  } else {
    await generation;
  }

  return jsonResponse({ deck });
});
