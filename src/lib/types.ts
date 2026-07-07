export interface Profile {
  id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type MaterialStatus =
  | 'uploaded'
  | 'syncing'
  | 'indexing'
  | 'indexed'
  | 'error';

export interface Material {
  id: string;
  user_id: string;
  folder_id: string | null;
  title: string;
  file_name: string;
  mime_type: string;
  file_size: number | null;
  storage_path: string;
  gcs_object: string | null;
  status: MaterialStatus;
  error_message: string | null;
  index_operation: string | null;
  created_at: string;
  updated_at: string;
}

export type GuideStatus = 'generating' | 'complete' | 'error';

export interface StudyGuide {
  id: string;
  user_id: string;
  folder_id: string | null;
  title: string;
  topic: string;
  content: string | null;
  status: GuideStatus;
  error_message: string | null;
  source_count: number | null;
  created_at: string;
  updated_at: string;
}
