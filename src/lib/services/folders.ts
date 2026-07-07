import { supabase } from '@/lib/supabase';
import { Folder } from '@/lib/types';

export interface ServiceResult<T> {
  data: T | null;
  error: string | null;
}

export async function listFolders(): Promise<ServiceResult<Folder[]>> {
  const { data, error } = await supabase
    .from('folders')
    .select('*')
    .order('name');
  return { data: data as Folder[] | null, error: error?.message ?? null };
}

export async function createFolder(name: string): Promise<ServiceResult<Folder>> {
  const trimmed = name.trim();
  if (!trimmed) return { data: null, error: 'Folder name is required' };
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { data: null, error: 'Not signed in' };
  const { data, error } = await supabase
    .from('folders')
    .insert({ name: trimmed, user_id: userData.user.id })
    .select()
    .single();
  if (error?.code === '23505') {
    return { data: null, error: 'You already have a folder with that name' };
  }
  return { data: data as Folder | null, error: error?.message ?? null };
}

export async function renameFolder(
  id: string,
  name: string,
): Promise<ServiceResult<Folder>> {
  const trimmed = name.trim();
  if (!trimmed) return { data: null, error: 'Folder name is required' };
  const { data, error } = await supabase
    .from('folders')
    .update({ name: trimmed })
    .eq('id', id)
    .select()
    .single();
  if (error?.code === '23505') {
    return { data: null, error: 'You already have a folder with that name' };
  }
  return { data: data as Folder | null, error: error?.message ?? null };
}

// Materials in the folder are kept (their folder_id becomes null via
// ON DELETE SET NULL) — deleting a folder never deletes sources.
export async function deleteFolder(id: string): Promise<ServiceResult<true>> {
  const { error } = await supabase.from('folders').delete().eq('id', id);
  return { data: error ? null : true, error: error?.message ?? null };
}
