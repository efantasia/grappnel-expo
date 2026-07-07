// Polls the Vertex AI Search import operation for a material and settles its
// status (indexing -> indexed | error). Called by the client while any
// material is in the 'indexing' state.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { getImportOperation } from '../_shared/discovery.ts';

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

  if (material.status !== 'indexing' || !material.index_operation) {
    return jsonResponse({ material });
  }

  try {
    const status = await getImportOperation(material.index_operation);
    if (!status.done) return jsonResponse({ material });

    const { data: updated } = await admin
      .from('materials')
      .update(
        status.error
          ? { status: 'error', error_message: status.error }
          : { status: 'indexed', error_message: null },
      )
      .eq('id', material.id)
      .select()
      .single();
    return jsonResponse({ material: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`check-material failed for ${material.id}:`, message);
    return errorResponse(message, 500);
  }
});
