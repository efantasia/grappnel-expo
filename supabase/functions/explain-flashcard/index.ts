// Generates an on-demand, deeper explanation of a single flashcard's answer.
// The student taps "Explain" while studying; this retrieves a few relevant
// chunks from the same materials the deck was built from (scoped by user_id
// and the deck's folder) and has Gemini write a short, grounded explanation.
// The result is cached on flashcards.explanation so re-opening the card is
// instant and never re-bills.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { searchChunks, RetrievedChunk } from '../_shared/discovery.ts';
import { generateText } from '../_shared/gemini.ts';

const SYSTEM_PROMPT = `You are Grappnel, an expert study assistant helping a student understand a flashcard more deeply.

You are given a flashcard (its question and answer), the deck's topic, and excerpts retrieved from the student's own course materials. Write a short explanation that helps the student truly understand WHY the answer is what it is — the reasoning, mechanism, or context behind it — not just a restatement.

Requirements:
- Ground the explanation in the provided excerpts. Do not invent facts that are not supported by them or by well-established knowledge of the topic.
- Be concise: 2-4 sentences (or a few short bullet points only if that is genuinely clearer). Do not repeat the question or the answer verbatim.
- Write plain text. Do NOT use Markdown, HTML, or LaTeX delimiters. Write formulas and symbols in readable plain text (e.g. "GFR < 60 mL/min/1.73m^2").
- Focus on building intuition and connections, not on padding.`;

const CHUNK_CAP = 6;

function buildContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return 'No excerpts were retrieved for this card.';
  return chunks.map((chunk, i) => `[${i + 1}] ${chunk.title}\n${chunk.content}`).join('\n\n---\n\n');
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: { card_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }
  const cardId = body.card_id?.trim();
  if (!cardId) return errorResponse('card_id is required');

  const admin = adminClient();

  // Load the card (scoped to the user) plus the deck's folder for search scope.
  const { data: card, error: cardError } = await admin
    .from('flashcards')
    .select('id, front, back, explanation, deck_id, flashcard_decks(folder_id, topic)')
    .eq('id', cardId)
    .eq('user_id', user.id)
    .single();
  if (cardError || !card) return errorResponse('Card not found', 404);

  // Cached from a previous tap — return it without re-generating.
  if (typeof card.explanation === 'string' && card.explanation.trim()) {
    return jsonResponse({ explanation: card.explanation });
  }

  // deck_id is a to-one FK, so this embeds a single row; normalize in case the
  // client types/returns it as a one-element array.
  const deckRel = card.flashcard_decks as unknown;
  const deck = (Array.isArray(deckRel) ? deckRel[0] : deckRel) as
    | { folder_id: string | null; topic: string | null }
    | null
    | undefined;

  try {
    const chunks = await searchChunks(
      `${card.front}\n${card.back}`.slice(0, 2000),
      { userId: user.id, folderId: deck?.folder_id ?? null },
      CHUNK_CAP,
    );

    const prompt = `Topic: ${deck?.topic ?? 'the deck topic'}

Flashcard question:
${card.front}

Flashcard answer:
${card.back}

Excerpts from my materials:

${buildContext(chunks)}`;

    const explanation = (await generateText(SYSTEM_PROMPT, prompt)).trim().slice(0, 4000);
    if (!explanation) return errorResponse('Could not generate an explanation', 502);

    // Persist so the next tap is instant. A write failure is non-fatal — the
    // student still gets the explanation this time.
    await admin
      .from('flashcards')
      .update({ explanation })
      .eq('id', cardId)
      .eq('user_id', user.id);

    return jsonResponse({ explanation });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`explain-flashcard failed for ${cardId}:`, message);
    return errorResponse(message, 500);
  }
});
