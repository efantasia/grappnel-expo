// Copies an uploaded material from Supabase Storage into the GCS content
// bucket, then triggers indexing: documents go straight to an incremental
// Vertex AI Search import; audio/video first runs the transcription job
// (ffmpeg + Velma) and check-material imports the transcript when it lands.
// YouTube materials skip both the copy and the job — their timestamped
// transcript is re-fetched from the video's captions and imported directly.
// Also used to re-sync metadata (title/folder changes) without re-copying
// the file by passing metadata_only: true.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { uploadObject } from '../_shared/gcs.ts';
import { importMaterialDocument, contentObjectName } from '../_shared/discovery.ts';
import {
  isMediaMimeType,
  startTranscription,
  transcriptObjectName,
} from '../_shared/transcribe.ts';
import { fetchYouTubeTranscript, parseYouTubeVideoId } from '../_shared/youtube.ts';

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

  const isYouTube = material.source_type === 'youtube';
  const isMedia = isYouTube || isMediaMimeType(material.mime_type);

  // Metadata-only re-sync of a media material that hasn't finished
  // transcribing: nothing to re-import yet — check-material reads the row
  // fresh at import time, so the new title/folder is picked up then.
  if (body.metadata_only && isMedia && !material.transcript_object) {
    return jsonResponse({ material });
  }

  await admin
    .from('materials')
    .update({ status: 'syncing', error_message: null })
    .eq('id', material.id);

  try {
    // YouTube full sync (also the retry path): re-fetch the caption
    // transcript and re-import it — no Storage file, no transcription job.
    if (isYouTube && !body.metadata_only) {
      const videoId = parseYouTubeVideoId(material.source_url ?? '');
      if (!videoId) throw new Error('This material has no valid YouTube link.');

      const transcript = await fetchYouTubeTranscript(videoId);
      const transcriptObject = transcriptObjectName(user.id, material.id);
      await uploadObject(transcriptObject, transcript, 'text/plain; charset=utf-8');

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

    let gcsObject = material.gcs_object as string | null;
    const needsCopy = !isYouTube && (!body.metadata_only || !gcsObject);

    if (needsCopy) {
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

    // Media with a fresh copy: (re)transcribe from the GCS object.
    if (isMedia && needsCopy) {
      await startTranscription(user.id, material.id, gcsObject!);

      const { data: updated } = await admin
        .from('materials')
        .update({
          gcs_object: gcsObject,
          transcript_object: null,
          index_operation: null,
          status: 'transcribing',
        })
        .eq('id', material.id)
        .select()
        .single();
      return jsonResponse({ material: updated });
    }

    // Documents (any sync) and media metadata-only re-syncs import directly;
    // for media the indexed object is the transcript, not the upload.
    const operationName = await importMaterialDocument({
      materialId: material.id,
      userId: user.id,
      folderId: material.folder_id,
      title: material.title,
      fileName: material.file_name,
      mimeType: isMedia ? 'text/plain' : material.mime_type,
      gcsObject: isMedia ? material.transcript_object : gcsObject!,
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
