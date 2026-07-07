// Google Cloud configuration for the Grappnel RAG pipeline. All values come
// from function secrets (supabase secrets set / .env for local serve).
// See scripts/setup-gcp.sh for provisioning the referenced resources.

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const gcpConfig = {
  get projectId() {
    return required('GCP_PROJECT_ID');
  },
  get gcsBucket() {
    return required('GCS_BUCKET');
  },
  // Discovery Engine multi-region: "global", "us", or "eu"
  get searchLocation() {
    return Deno.env.get('VERTEX_SEARCH_LOCATION') ?? 'global';
  },
  get dataStoreId() {
    return required('VERTEX_SEARCH_DATASTORE_ID');
  },
  get collection() {
    return Deno.env.get('VERTEX_SEARCH_COLLECTION') ?? 'default_collection';
  },
  get geminiModel() {
    return Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash';
  },
  // Vertex AI (Gemini) location; "global" routes to the global endpoint
  get geminiLocation() {
    return Deno.env.get('GEMINI_LOCATION') ?? 'global';
  },
};

// Discovery Engine REST base URL is location-aware.
export function discoveryApiBase(): string {
  const location = gcpConfig.searchLocation;
  return location === 'global'
    ? 'https://discoveryengine.googleapis.com/v1'
    : `https://${location}-discoveryengine.googleapis.com/v1`;
}

export function dataStorePath(): string {
  return `projects/${gcpConfig.projectId}/locations/${gcpConfig.searchLocation}/collections/${gcpConfig.collection}/dataStores/${gcpConfig.dataStoreId}`;
}
