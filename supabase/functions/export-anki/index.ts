// Kicks off an Anki .apkg export for a deck: gathers the deck's cards (with
// their figures/occlusion), writes a spec JSON to GCS, and starts the
// grappnel-anki-export Cloud Run job. Returns an export id the client polls
// via check-export. Everything is user-scoped (RLS bypass -> explicit user_id).

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { uploadObject } from '../_shared/gcs.ts';
import {
  apkgObjectName,
  exportErrorObjectName,
  specObjectName,
  startAnkiExportJob,
} from '../_shared/anki.ts';

interface FigureJoin {
  gcs_object: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: { deck_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }
  if (!body.deck_id) return errorResponse('deck_id is required');

  const admin = adminClient();
  const { data: deck } = await admin
    .from('flashcard_decks')
    .select('id, title, status')
    .eq('id', body.deck_id)
    .eq('user_id', user.id)
    .single();
  if (!deck) return errorResponse('Deck not found', 404);
  if (deck.status !== 'complete') return errorResponse('This deck is not ready to export yet.');

  const { data: cards } = await admin
    .from('flashcards')
    .select('type, front, back, citation, occlusion, material_figures(gcs_object, mime_type, width, height)')
    .eq('deck_id', deck.id)
    .eq('user_id', user.id)
    .order('ordinal', { ascending: true });
  if (!cards?.length) return errorResponse('This deck has no cards to export.');

  const spec = {
    deck: deck.title as string,
    cards: cards.map((c) => {
      // A to-one embed resolves to an object at runtime, but the untyped client
      // widens it to an array — accept either.
      const raw = c.material_figures as unknown;
      const figure = (Array.isArray(raw) ? raw[0] : raw) as FigureJoin | null;
      return {
        type: c.type as string,
        front: (c.front as string) ?? '',
        back: (c.back as string) ?? '',
        citation: (c.citation as string | null) ?? null,
        occlusion: (c.occlusion as number[][] | null) ?? null,
        figure: figure?.gcs_object
          ? {
              object: figure.gcs_object,
              mime: figure.mime_type ?? 'image/jpeg',
              width: figure.width ?? null,
              height: figure.height ?? null,
            }
          : null,
      };
    }),
  };

  const exportId = crypto.randomUUID();
  try {
    await uploadObject(
      specObjectName(user.id, exportId),
      JSON.stringify(spec),
      'application/json; charset=utf-8',
    );
    await startAnkiExportJob(
      specObjectName(user.id, exportId),
      apkgObjectName(user.id, exportId),
      exportErrorObjectName(user.id, exportId),
    );
    return jsonResponse({ export_id: exportId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`export-anki failed for deck ${deck.id}:`, message);
    return errorResponse('Could not start the export.', 500);
  }
});
