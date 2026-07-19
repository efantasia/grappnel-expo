// Returns a short-lived signed GCS URL for a material's original uploaded
// file so the client can download it. Files live in a private bucket
// (content/<user>/…) the client can't read directly, so the URL is signed
// server-side after confirming the material belongs to the caller. YouTube
// materials have no file — clients offer "Open video" / transcript instead.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { createSignedDownloadUrl, objectExists } from '../_shared/gcs.ts';

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
    .select('id, file_name, mime_type, gcs_object')
    .eq('id', materialId)
    .eq('user_id', user.id)
    .single();
  if (error || !material) return errorResponse('Material not found', 404);
  if (!material.gcs_object) {
    return errorResponse('This material has no downloadable file.', 404);
  }

  try {
    if (!(await objectExists(material.gcs_object))) {
      return errorResponse(
        'The file for this material has not finished uploading.',
        404,
      );
    }
    const url = await createSignedDownloadUrl(
      material.gcs_object,
      material.file_name,
    );
    return jsonResponse({
      url,
      file_name: material.file_name,
      mime_type: material.mime_type,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`download-material failed for ${materialId}:`, message);
    return errorResponse('Could not prepare the download.', 500);
  }
});
