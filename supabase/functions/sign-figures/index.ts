// Mints short-lived signed GCS URLs for displaying a caller's figures. Figures
// live in the private bucket (figures/<user_id>/…) the client can't read
// directly, so URLs are signed server-side after confirming each figure belongs
// to the caller. Used by the flashcard study screen to render card images.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { createSignedInlineUrl } from '../_shared/gcs.ts';

const MAX_IDS = 200;
const URL_TTL_SECONDS = 3600;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: { figure_ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const ids = [...new Set((body.figure_ids ?? []).filter((id): id is string => !!id))].slice(
    0,
    MAX_IDS,
  );
  if (ids.length === 0) return jsonResponse({ urls: {} });

  const admin = adminClient();
  const { data: figures, error } = await admin
    .from('material_figures')
    .select('id, gcs_object, mime_type')
    .in('id', ids)
    .eq('user_id', user.id);
  if (error) return errorResponse(error.message, 500);

  try {
    const entries = await Promise.all(
      (figures ?? []).map(async (fig) => {
        const url = await createSignedInlineUrl(
          fig.gcs_object as string,
          (fig.mime_type as string) || 'image/jpeg',
          URL_TTL_SECONDS,
        );
        return [fig.id as string, url] as const;
      }),
    );
    return jsonResponse({ urls: Object.fromEntries(entries) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('sign-figures failed:', message);
    return errorResponse('Could not prepare figure URLs.', 500);
  }
});
