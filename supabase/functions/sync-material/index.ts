// Copies an uploaded material from Supabase Storage into the GCS content
// bucket, then triggers an incremental Vertex AI Search import for it.
// Also used to re-sync metadata (title/folder changes) without re-copying
// the file by passing metadata_only: true.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { uploadObject } from '../_shared/gcs.ts';
import { importMaterialDocument, contentObjectName } from '../_shared/discovery.ts';

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: { material_id?: string; metadata_only?: boolean };
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

  await admin
    .from('materials')
    .update({ status: 'syncing', error_message: null })
    .eq('id', material.id);

  try {
    let gcsObject = material.gcs_object as string | null;

    if (!body.metadata_only || !gcsObject) {
      gcsObject = contentObjectName(user.id, material.id, material.file_name);
      const { data: signed, error: signError } = await admin.storage
        .from('materials')
        .createSignedUrl(material.storage_path, 600);
      if (signError || !signed) {
        throw new Error(`Could not read uploaded file: ${signError?.message ?? 'no signed URL'}`);
      }
      const fileResponse = await fetch(signed.signedUrl);
      if (!fileResponse.ok || !fileResponse.body) {
        throw new Error(`Download from storage failed (${fileResponse.status})`);
      }
      await uploadObject(gcsObject, fileResponse.body, material.mime_type);
    }

    const operationName = await importMaterialDocument({
      materialId: material.id,
      userId: user.id,
      folderId: material.folder_id,
      title: material.title,
      fileName: material.file_name,
      mimeType: material.mime_type,
      gcsObject,
    });

    const { data: updated } = await admin
      .from('materials')
      .update({
        gcs_object: gcsObject,
        index_operation: operationName,
        status: 'indexing',
      })
      .eq('id', material.id)
      .select()
      .single();

    return jsonResponse({ material: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`sync-material failed for ${material.id}:`, message);
    await admin
      .from('materials')
      .update({ status: 'error', error_message: message })
      .eq('id', material.id);
    return errorResponse(message, 500);
  }
});
