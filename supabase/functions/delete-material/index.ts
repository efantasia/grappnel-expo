// Deletes a material everywhere: Vertex AI Search document, GCS content +
// manifest objects, and finally the DB row. Each cleanup step tolerates
// "already gone" so retries converge.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { deleteObject, listObjects } from '../_shared/gcs.ts';
import { deleteDocument, metadataObjectName } from '../_shared/discovery.ts';
import {
  isMediaMimeType,
  transcriptObjectName,
  transcriptErrorObjectName,
} from '../_shared/transcribe.ts';
import { figuresPrefix } from '../_shared/figures.ts';

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
  if (!body.material_id) return errorResponse('material_id is required');

  const admin = adminClient();
  const { data: material, error: fetchError } = await admin
    .from('materials')
    .select('*')
    .eq('id', body.material_id)
    .eq('user_id', user.id)
    .single();
  if (fetchError || !material) return errorResponse('Material not found', 404);

  try {
    await deleteDocument(material.id);
    await deleteObject(metadataObjectName(user.id, material.id));
    if (material.gcs_object) {
      await deleteObject(material.gcs_object);
    }
    if (material.source_type === 'youtube' || isMediaMimeType(material.mime_type)) {
      await deleteObject(transcriptObjectName(user.id, material.id));
      await deleteObject(transcriptErrorObjectName(user.id, material.id));
    }
    // Extracted figures + manifest/error markers (material_figures rows cascade
    // from the materials FK). Tolerates an empty prefix.
    const figureObjects = await listObjects(figuresPrefix(user.id, material.id));
    await Promise.all(figureObjects.map((name) => deleteObject(name)));
    // Only legacy rows (uploaded before direct-to-GCS) still have a
    // Supabase Storage file to clean up.
    if (material.storage_path) {
      await admin.storage.from('materials').remove([material.storage_path]);
    }
    const { error: deleteError } = await admin
      .from('materials')
      .delete()
      .eq('id', material.id)
      .eq('user_id', user.id);
    if (deleteError) throw new Error(deleteError.message);

    return jsonResponse({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`delete-material failed for ${material.id}:`, message);
    return errorResponse(message, 500);
  }
});
