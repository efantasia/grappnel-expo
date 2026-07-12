// Adds a YouTube lecture/video to the user's library: validates the link,
// looks up the title (oEmbed), inserts the material row, fetches the video's
// caption track as a timestamped transcript, and starts the Vertex import.
// YouTube materials skip the transcription job entirely — captions already
// carry timestamps — so the lifecycle is syncing -> indexing -> indexed.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { uploadObject } from '../_shared/gcs.ts';
import { importMaterialDocument } from '../_shared/discovery.ts';
import { transcriptObjectName } from '../_shared/transcribe.ts';
import {
  canonicalYouTubeUrl,
  fetchYouTubeTranscript,
  lookupYouTubeVideo,
  parseYouTubeVideoId,
} from '../_shared/youtube.ts';

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: { url?: string; folder_id?: string | null };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const videoId = parseYouTubeVideoId(body.url ?? '');
  if (!videoId) {
    return errorResponse(
      'Enter a valid YouTube video link (youtube.com/watch?v=… or youtu.be/…).',
    );
  }
  const sourceUrl = canonicalYouTubeUrl(videoId);

  const admin = adminClient();

  if (body.folder_id) {
    const { data: folder } = await admin
      .from('folders')
      .select('id')
      .eq('id', body.folder_id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!folder) return errorResponse('Folder not found', 404);
  }

  const lookup = await lookupYouTubeVideo(videoId);
  if (lookup.unavailable) {
    return errorResponse('This YouTube video is private or unavailable — check the link.');
  }

  const { data: material, error: insertError } = await admin
    .from('materials')
    .insert({
      user_id: user.id,
      folder_id: body.folder_id ?? null,
      title: lookup.title ?? `YouTube video ${videoId}`,
      file_name: `youtube-${videoId}`,
      mime_type: 'video/youtube',
      source_type: 'youtube',
      source_url: sourceUrl,
      status: 'syncing',
    })
    .select()
    .single();
  if (insertError || !material) {
    return errorResponse(insertError?.message ?? 'Could not create material', 500);
  }

  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`add-youtube-material failed for ${material.id}:`, message);
    await admin
      .from('materials')
      .update({ status: 'error', error_message: message })
      .eq('id', material.id);
    return errorResponse(message, 500);
  }
});
