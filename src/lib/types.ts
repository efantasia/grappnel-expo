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

// One main topic of a material, classified under three systems: the OpenAlex
// 4-level hierarchy (one column per level), the bepress Digital Commons
// 3-tier taxonomy, and Wikipedia categories. Extracted by Gemini after
// indexing; a material usually has several.
export interface MaterialTopic {
  id: string;
  user_id: string;
  material_id: string;
  name: string;
  summary: string | null;
  openalex_domain: string | null;
  openalex_field: string | null;
  openalex_subfield: string | null;
  openalex_topic: string | null;
  digital_commons_tier1: string | null;
  digital_commons_tier2: string | null;
  digital_commons_tier3: string | null;
  wikipedia_categories: string[];
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
