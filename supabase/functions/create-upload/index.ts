// Mints a direct-to-GCS resumable upload session for a new material so the
// file never passes through Supabase Storage or the edge runtime. Creates
// the materials row (status 'uploading', gcs_object preassigned) and returns
// the session URI; the client PUTs the bytes straight to GCS and then calls
// sync-material. The session pins the object name, content type, and exact
// byte length declared here, so the client can only upload what it asked to.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { createResumableUploadSession } from '../_shared/gcs.ts';
import { contentObjectName } from '../_shared/discovery.ts';

// Must stay in sync with SUPPORTED_MIME_TYPES in src/lib/services/upload.ts.
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/aac',
  'audio/flac',
  'audio/ogg',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

const MAX_FILE_BYTES = 100 * 1024 * 1024;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: {
    file_name?: string;
    title?: string;
    mime_type?: string;
    file_size?: number;
    folder_id?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const fileName = (body.file_name ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
  if (!fileName) return errorResponse('file_name is required');
  const mimeType = body.mime_type ?? '';
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) return errorResponse('Unsupported file type');
  const fileSize = body.file_size;
  if (!Number.isInteger(fileSize) || fileSize! <= 0) {
    return errorResponse('file_size is required');
  }
  if (fileSize! > MAX_FILE_BYTES) return errorResponse('File is larger than 100 MB.');
  const title = (body.title ?? '').trim().slice(0, 200) || fileName.slice(0, 200);

  const admin = adminClient();

  // The insert runs with the service role (RLS bypassed), so folder
  // ownership must be checked explicitly.
  if (body.folder_id) {
    const { data: folder } = await admin
      .from('folders')
      .select('id')
      .eq('id', body.folder_id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!folder) return errorResponse('Folder not found', 404);
  }

  const materialId = crypto.randomUUID();
  const gcsObject = contentObjectName(user.id, materialId, fileName);

  const { data: material, error: insertError } = await admin
    .from('materials')
    .insert({
      id: materialId,
      user_id: user.id,
      folder_id: body.folder_id ?? null,
      title,
      file_name: fileName,
      mime_type: mimeType,
      file_size: fileSize,
      gcs_object: gcsObject,
      status: 'uploading',
    })
    .select()
    .single();
  if (insertError || !material) {
    return errorResponse(insertError?.message ?? 'Could not create material', 500);
  }

  try {
    const uploadUrl = await createResumableUploadSession(
      gcsObject,
      mimeType,
      fileSize!,
      req.headers.get('origin') ?? undefined,
    );
    return jsonResponse({ material, upload_url: uploadUrl });
  } catch (err) {
    await admin.from('materials').delete().eq('id', materialId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`create-upload failed for ${materialId}:`, message);
    return errorResponse(message, 500);
  }
});
