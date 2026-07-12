import { invokeFunction } from '@/lib/functions';
import { ServiceResult } from '@/lib/services/folders';
import { supabase } from '@/lib/supabase';
import { Material } from '@/lib/types';

export async function listMaterials(
  folderId?: string | null,
): Promise<ServiceResult<Material[]>> {
  let query = supabase
    .from('materials')
    .select('*')
    .order('created_at', { ascending: false });
  if (folderId === null) query = query.is('folder_id', null);
  else if (folderId) query = query.eq('folder_id', folderId);
  const { data, error } = await query;
  return { data: data as Material[] | null, error: error?.message ?? null };
}

// Adds a YouTube lecture/video by link. The edge function validates the URL,
// fetches the video title, and starts transcription; from there the material
// polls through the normal transcribing -> indexing lifecycle.
export async function addYouTubeMaterial(
  url: string,
  folderId: string | null,
): Promise<ServiceResult<Material>> {
  const { data, error } = await invokeFunction<{ material: Material }>(
    'add-youtube-material',
    { url: url.trim(), folder_id: folderId },
  );
  return { data: data?.material ?? null, error };
}

// Kicks off (or retries) the GCS copy + Vertex AI Search import.
export async function syncMaterial(
  materialId: string,
  metadataOnly = false,
): Promise<ServiceResult<Material>> {
  const { data, error } = await invokeFunction<{ material: Material }>(
    'sync-material',
    { material_id: materialId, metadata_only: metadataOnly },
  );
  return { data: data?.material ?? null, error };
}

// Polls the import operation while a material is 'indexing'.
export async function checkMaterial(
  materialId: string,
): Promise<ServiceResult<Material>> {
  const { data, error } = await invokeFunction<{ material: Material }>(
    'check-material',
    { material_id: materialId },
  );
  return { data: data?.material ?? null, error };
}

export async function deleteMaterial(
  materialId: string,
): Promise<ServiceResult<true>> {
  const { error } = await invokeFunction<{ ok: true }>('delete-material', {
    material_id: materialId,
  });
  return { data: error ? null : true, error };
}

// Title/folder live in the search index's structData too, so after a local
// update we re-sync metadata (no file re-copy) for anything already in GCS.
async function updateAndResync(
  materialId: string,
  patch: Partial<Pick<Material, 'title' | 'folder_id'>>,
): Promise<ServiceResult<Material>> {
  const { data, error } = await supabase
    .from('materials')
    .update(patch)
    .eq('id', materialId)
    .select()
    .single();
  if (error) return { data: null, error: error.message };
  const material = data as Material;
  if (material.gcs_object) {
    const synced = await syncMaterial(materialId, true);
    if (synced.data) return synced;
  }
  return { data: material, error: null };
}

export function renameMaterial(materialId: string, title: string) {
  const trimmed = title.trim();
  if (!trimmed) {
    return Promise.resolve({ data: null, error: 'Title is required' } as ServiceResult<Material>);
  }
  return updateAndResync(materialId, { title: trimmed });
}

export function moveMaterial(materialId: string, folderId: string | null) {
  return updateAndResync(materialId, { folder_id: folderId });
}
