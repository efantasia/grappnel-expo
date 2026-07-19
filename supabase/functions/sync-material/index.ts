// Triggers indexing for a material whose bytes are already in GCS (the
// client uploads directly via a create-upload resumable session): documents
// go straight to an incremental Vertex AI Search import; audio/video first
// runs the transcription job (ffmpeg + Velma) and check-material imports the
// transcript when it lands. YouTube materials have no uploaded file — their
// timestamped transcript is re-fetched from the video's captions and
// imported directly. Also used to re-sync metadata (title/folder changes)
// without re-ingesting content by passing metadata_only: true.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { uploadObject, objectExists } from '../_shared/gcs.ts';
import { importMaterialDocument } from '../_shared/discovery.ts';
import {
  isMediaMimeType,
  startTranscription,
  transcriptObjectName,
} from '../_shared/transcribe.ts';
import { isFigureBearingMimeType, startFigureExtraction } from '../_shared/figures.ts';
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

  // Full syncs (re)ingest content, so queue a fresh topic + figure extraction
  // too; metadata-only re-syncs keep the already-extracted topics and figures.
  // Surface the error instead of swallowing it — otherwise a failed status
  // update (e.g. a schema/deploy mismatch) silently strands the row at its
  // previous status ('uploading') with no signal to the client.
  const { error: syncingError } = await admin
    .from('materials')
    .update({
      status: 'syncing',
      error_message: null,
      ...(body.metadata_only
        ? {}
        : {
            topics_status: 'pending',
            topics_error: null,
            figures_status: isFigureBearingMimeType(material.mime_type)
              ? 'pending'
              : 'skipped',
            figures_error: null,
          }),
    })
    .eq('id', material.id);
  if (syncingError) throw new Error(syncingError.message);

  try {
    // YouTube full sync (also the retry path): re-fetch the caption
    // transcript and re-import it — no uploaded file, no transcription job.
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

    // YouTube reaches here only for metadata-only re-syncs (full syncs
    // returned above); everything else must have its bytes in GCS already
    // (create-upload preassigns gcs_object and the client streams to it).
    const gcsObject = material.gcs_object as string | null;
    if (!isYouTube && !gcsObject) {
      throw new Error('This material has no uploaded file — delete it and upload it again.');
    }
    if (!body.metadata_only && !(await objectExists(gcsObject!))) {
      throw new Error('The upload never finished — delete this material and upload it again.');
    }

    // Media full sync: (re)transcribe from the GCS object.
    if (isMedia && !body.metadata_only) {
      await startTranscription(user.id, material.id, gcsObject!);

      const { data: updated } = await admin
        .from('materials')
        .update({
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

    // In parallel with indexing, pull embedded figures out of document uploads
    // (full syncs only). A failure to start must not fail the whole sync — the
    // index import already succeeded — so it degrades figures_status instead.
    let figuresStatus: string | undefined;
    if (
      !body.metadata_only &&
      !isMedia &&
      isFigureBearingMimeType(material.mime_type) &&
      gcsObject
    ) {
      try {
        await startFigureExtraction(user.id, material.id, gcsObject, material.mime_type);
        figuresStatus = 'processing';
      } catch (err) {
        console.error(`figure extraction start failed for ${material.id}:`, err);
        figuresStatus = 'error';
      }
    }

    const { data: updated } = await admin
      .from('materials')
      .update({
        index_operation: operationName,
        status: 'indexing',
        ...(figuresStatus
          ? {
              figures_status: figuresStatus,
              figures_error:
                figuresStatus === 'error' ? 'Could not start figure extraction.' : null,
            }
          : {}),
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
