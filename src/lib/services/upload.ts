import { decode } from 'base64-arraybuffer';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { syncMaterial } from '@/lib/services/materials';
import { supabase } from '@/lib/supabase';
import { Material } from '@/lib/types';

// Documents are formats Vertex AI Search can index directly (same set the
// honeylove KB uses); audio/video is transcribed first (Cloud Run job +
// Velma) and the transcript is indexed. Everything else is rejected at
// pick time.
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

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // matches the bucket limit

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

async function readAssetBody(
  asset: DocumentPicker.DocumentPickerAsset,
): Promise<ArrayBuffer | Blob> {
  if (Platform.OS === 'web') {
    if (asset.file) return asset.file;
    const response = await fetch(asset.uri);
    return response.blob();
  }
  const base64 = await FileSystem.readAsStringAsync(asset.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return decode(base64);
}

async function uploadOne(
  userId: string,
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
  if (asset.size && asset.size > MAX_FILE_BYTES) {
    return { fileName: asset.name, material: null, error: 'File is larger than 100 MB.' };
  }

  const materialId = Crypto.randomUUID();
  const storagePath = `${userId}/${materialId}/${fileName}`;

  try {
    const body = await readAssetBody(asset);
    const { error: uploadError } = await supabase.storage
      .from('materials')
      .upload(storagePath, body, { contentType: mimeType });
    if (uploadError) throw new Error(uploadError.message);

    const { data, error: insertError } = await supabase
      .from('materials')
      .insert({
        id: materialId,
        user_id: userId,
        folder_id: folderId,
        title: defaultTitle(asset.name),
        file_name: fileName,
        mime_type: mimeType,
        file_size: asset.size ?? null,
        storage_path: storagePath,
        status: 'uploaded',
      })
      .select()
      .single();
    if (insertError) {
      await supabase.storage.from('materials').remove([storagePath]);
      throw new Error(insertError.message);
    }

    // Kick off the GCS copy + search indexing; if it fails the material
    // stays visible with an error status and can be retried.
    const synced = await syncMaterial(materialId);
    return {
      fileName: asset.name,
      material: synced.data ?? (data as Material),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { fileName: asset.name, material: null, error: message };
  }
}

export async function uploadMaterials(
  userId: string,
  folderId: string | null,
  assets: DocumentPicker.DocumentPickerAsset[],
): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = [];
  for (const asset of assets) {
    outcomes.push(await uploadOne(userId, folderId, asset));
  }
  return outcomes;
}
