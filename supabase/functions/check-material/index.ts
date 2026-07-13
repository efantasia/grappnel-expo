// Settles in-flight material statuses; called by the client while any
// material is 'transcribing' or 'indexing'.
//   transcribing: watches GCS for the transcription job's transcript (then
//                 imports it into the search index) or error marker.
//   indexing:     polls the Vertex AI Search import operation
//                 (indexing -> indexed | error).
// When a material lands on 'indexed' with topics still pending, Gemini topic
// extraction runs in the background (EdgeRuntime.waitUntil) — clients don't
// wait on it; material_topics rows appear when it finishes.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { getImportOperation, importMaterialDocument } from '../_shared/discovery.ts';
import { objectExists, readObjectText } from '../_shared/gcs.ts';
import { transcriptObjectName, transcriptErrorObjectName } from '../_shared/transcribe.ts';
import { extractMaterialTopics, TopicSourceMaterial } from '../_shared/topics.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

async function startTopicExtraction(
  admin: SupabaseClient,
  material: TopicSourceMaterial,
): Promise<void> {
  const extraction = extractMaterialTopics(admin, material);
  if (typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(extraction);
  } else {
    await extraction;
  }
}

// A transcription run that has produced neither a transcript nor an error
// marker after this long is presumed dead (job crash without cleanup).
const TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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
    if (material.status === 'transcribing') {
      const transcriptObject = transcriptObjectName(user.id, material.id);
      if (await objectExists(transcriptObject)) {
        const operationName = await importMaterialDocument({
          materialId: material.id,
          userId: user.id,
          folderId: material.folder_id,
          title: material.title,
          fileName: material.file_name,
          mimeType: 'text/plain',
          gcsObject: transcriptObject,
        });
        const { data: updated } = await admin
          .from('materials')
          .update({
            transcript_object: transcriptObject,
            index_operation: operationName,
            status: 'indexing',
          })
          .eq('id', material.id)
          .select()
          .single();
        return jsonResponse({ material: updated });
      }

      const errorObject = transcriptErrorObjectName(user.id, material.id);
      if (await objectExists(errorObject)) {
        const message = (await readObjectText(errorObject)).trim().slice(0, 500);
        const { data: updated } = await admin
          .from('materials')
          .update({
            status: 'error',
            error_message: message || 'Transcription failed.',
          })
          .eq('id', material.id)
          .select()
          .single();
        return jsonResponse({ material: updated });
      }

      const startedAt = new Date(material.updated_at as string).getTime();
      if (Date.now() - startedAt > TRANSCRIBE_TIMEOUT_MS) {
        const { data: updated } = await admin
          .from('materials')
          .update({
            status: 'error',
            error_message: 'Transcription timed out. Try syncing the material again.',
          })
          .eq('id', material.id)
          .select()
          .single();
        return jsonResponse({ material: updated });
      }

      return jsonResponse({ material });
    }

    if (material.status !== 'indexing' || !material.index_operation) {
      // Recover extractions the indexed transition missed (e.g. the runtime
      // died before the background task finished claiming the material).
      if (material.status === 'indexed' && material.topics_status === 'pending') {
        await startTopicExtraction(admin, material);
      }
      return jsonResponse({ material });
    }

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
    if (updated && !status.error) {
      await startTopicExtraction(admin, updated);
    }
    return jsonResponse({ material: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`check-material failed for ${material.id}:`, message);
    return errorResponse(message, 500);
  }
});
