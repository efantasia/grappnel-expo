import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { invokeFunction } from '@/lib/functions';
import { syncMaterial } from '@/lib/services/materials';
import { supabase } from '@/lib/supabase';
import { Material } from '@/lib/types';

// Documents are formats Vertex AI Search can index directly (same set the
// honeylove KB uses); audio/video is transcribed first (Cloud Run job +
// Velma) and the transcript is indexed. Everything else is rejected at
// pick time. Must stay in sync with the allowlist in
// supabase/functions/create-upload/index.ts.
export const SUPPORTED_MIME_TYPES = [
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
];

const EXTENSION_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // enforced again by the GCS session

export interface UploadOutcome {
  fileName: string;
  material: Material | null;
  error: string | null;
}

function resolveMimeType(fileName: string, pickerMime?: string): string | null {
  if (pickerMime && SUPPORTED_MIME_TYPES.includes(pickerMime)) return pickerMime;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME_TYPES[ext] ?? null;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

function defaultTitle(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  return (base.replace(/[_-]+/g, ' ').trim() || fileName).slice(0, 200);
}

export async function pickMaterials(): Promise<DocumentPicker.DocumentPickerAsset[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: SUPPORTED_MIME_TYPES,
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets;
}

// The GCS session pins the exact byte length, so the size must be known
// up front.
async function resolveFileSize(
  asset: DocumentPicker.DocumentPickerAsset,
): Promise<number | null> {
  if (asset.size != null) return asset.size;
  if (Platform.OS === 'web') return asset.file?.size ?? null;
  const info = await FileSystem.getInfoAsync(asset.uri);
  return info.exists && !info.isDirectory ? info.size : null;
}

// PUT the bytes to the GCS resumable session in one shot; the object's name,
// content type, and length were pinned when the session was created.
async function putFile(
  uploadUrl: string,
  asset: DocumentPicker.DocumentPickerAsset,
  mimeType: string,
): Promise<void> {
  if (Platform.OS === 'web') {
    const body = asset.file ?? (await (await fetch(asset.uri)).blob());
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body,
    });
    if (!response.ok) throw new Error(`Upload failed (${response.status})`);
    return;
  }
  // Native streams from disk — no base64 round-trip through memory.
  const result = await FileSystem.uploadAsync(uploadUrl, asset.uri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': mimeType },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Upload failed (${result.status})`);
  }
}

async function uploadOne(
  folderId: string | null,
  asset: DocumentPicker.DocumentPickerAsset,
): Promise<UploadOutcome> {
  const fileName = sanitizeFileName(asset.name);
  const mimeType = resolveMimeType(fileName, asset.mimeType);
  if (!mimeType) {
    return {
      fileName: asset.name,
      material: null,
      error:
        'Unsupported file type. Use PDF, TXT, MD, HTML, DOCX, PPTX, XLSX, or an audio/video file (MP3, M4A, WAV, MP4, MOV, …).',
    };
  }
  const fileSize = await resolveFileSize(asset);
  if (fileSize == null || fileSize <= 0) {
    return { fileName: asset.name, material: null, error: 'Could not determine the file size.' };
  }
  if (fileSize > MAX_FILE_BYTES) {
    return { fileName: asset.name, material: null, error: 'File is larger than 100 MB.' };
  }

  // create-upload makes the row (status 'uploading') and mints a resumable
  // GCS session; the bytes then stream straight to GCS — no Supabase
  // Storage hop.
  const { data, error } = await invokeFunction<{ material: Material; upload_url: string }>(
    'create-upload',
    {
      file_name: fileName,
      title: defaultTitle(asset.name),
      mime_type: mimeType,
      file_size: fileSize,
      folder_id: folderId,
    },
  );
  if (error || !data) {
    return { fileName: asset.name, material: null, error: error ?? 'Could not start the upload.' };
  }

  try {
    await putFile(data.upload_url, asset, mimeType);
  } catch (err) {
    // An unfinished session never becomes a GCS object, so removing the row
    // leaves nothing behind.
    await supabase.from('materials').delete().eq('id', data.material.id);
    const message = err instanceof Error ? err.message : String(err);
    return { fileName: asset.name, material: null, error: message };
  }

  // Kick off transcription/indexing; if it fails the material stays visible
  // with an error status and can be retried.
  const synced = await syncMaterial(data.material.id);
  return {
    fileName: asset.name,
    material: synced.data ?? data.material,
    error: null,
  };
}

export async function uploadMaterials(
  folderId: string | null,
  assets: DocumentPicker.DocumentPickerAsset[],
): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = [];
  for (const asset of assets) {
    outcomes.push(await uploadOne(folderId, asset));
  }
  return outcomes;
}
