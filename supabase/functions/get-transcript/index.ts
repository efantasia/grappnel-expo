// Returns the plain-text transcript for one of the user's materials so the
// client can save/share it. Transcripts live in GCS (transcripts/<user>/…),
// which the client can't read directly, so this reads the object with the
// service role after confirming the material belongs to the caller.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { readObjectText } from '../_shared/gcs.ts';

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: { material_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }
  const materialId = body.material_id;
  if (!materialId) return errorResponse('material_id is required');

  const admin = adminClient();
  const { data: material, error } = await admin
    .from('materials')
    .select('id, title, transcript_object')
    .eq('id', materialId)
    .eq('user_id', user.id)
    .single();
  if (error || !material) return errorResponse('Material not found', 404);
  if (!material.transcript_object) {
    return errorResponse('No transcript is available for this material yet.', 404);
  }

  try {
    const transcript = await readObjectText(material.transcript_object);
    return jsonResponse({ transcript, title: material.title });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`get-transcript failed for ${materialId}:`, message);
    return errorResponse('Could not read the transcript file.', 500);
  }
});
