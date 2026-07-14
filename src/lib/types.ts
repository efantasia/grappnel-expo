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
  | 'uploading'
  | 'uploaded' // legacy: file in Supabase Storage, pre-direct-to-GCS
  | 'syncing'
  | 'transcribing'
  | 'indexing'
  | 'indexed'
  | 'error';

export type MaterialSourceType = 'upload' | 'youtube';

export type TopicsStatus = 'pending' | 'extracting' | 'extracted' | 'error';

export interface Material {
  id: string;
  user_id: string;
  folder_id: string | null;
  title: string;
  file_name: string;
  mime_type: string;
  file_size: number | null;
  source_type: MaterialSourceType;
  source_url: string | null;
  storage_path: string | null;
  gcs_object: string | null;
  transcript_object: string | null;
  status: MaterialStatus;
  error_message: string | null;
  index_operation: string | null;
  topics_status: TopicsStatus;
  topics_error: string | null;
  created_at: string;
  updated_at: string;
}

// One main topic of a material: a single official OpenAlex topic the material
// covers. Extracted by Gemini after indexing (which matches content to the
// authoritative openalex_topics list), a material usually has several. There is
// no freeform label — the display name is the OpenAlex topic's display_name
// (openalex_topic) and any description comes from the openalex_topics row.
export interface MaterialTopic {
  id: string;
  user_id: string;
  material_id: string;
  openalex_domain: string | null;
  openalex_field: string | null;
  openalex_subfield: string | null;
  openalex_topic: string | null;
  openalex_domain_id: string | null;
  openalex_field_id: string | null;
  openalex_subfield_id: string | null;
  openalex_topic_id: string;
  wikipedia_url: string | null;
  wikipedia_title: string | null;
  created_at: string;
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
