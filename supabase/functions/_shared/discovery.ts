// Vertex AI Search (Discovery Engine) REST helpers. The datastore is an
// unstructured store with metadata; every document carries structData with
// user_id / folder_id / material_id so queries can be scoped per user.
// Imports are INCREMENTAL (one JSONL manifest per material) so one user's
// sync never touches another user's documents.

import { getGoogleAccessToken } from './google-auth.ts';
import { discoveryApiBase, dataStorePath, gcpConfig } from './config.ts';
import { uploadObject } from './gcs.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// structData values are interpolated into search filter expressions, so only
// UUIDs (or the literal 'root') are ever allowed as scope values.
export function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${label}: not a UUID`);
}

export interface MaterialDocMetadata {
  materialId: string;
  userId: string;
  folderId: string | null;
  title: string;
  fileName: string;
  mimeType: string;
  gcsObject: string; // content object name within the bucket
}

async function discoveryFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getGoogleAccessToken();
  return fetch(`${discoveryApiBase()}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export function metadataObjectName(userId: string, materialId: string): string {
  return `metadata/${userId}/${materialId}.jsonl`;
}

export function contentObjectName(userId: string, materialId: string, fileName: string): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : 'bin';
  return `content/${userId}/${materialId}.${ext}`;
}

// Writes the per-material JSONL manifest to GCS and triggers an incremental
// import for just that manifest. Returns the long-running operation name.
export async function importMaterialDocument(meta: MaterialDocMetadata): Promise<string> {
  assertUuid(meta.userId, 'user_id');
  assertUuid(meta.materialId, 'material_id');
  if (meta.folderId) assertUuid(meta.folderId, 'folder_id');

  const manifestLine = JSON.stringify({
    id: meta.materialId,
    structData: {
      user_id: meta.userId,
      folder_id: meta.folderId ?? 'root',
      material_id: meta.materialId,
      title: meta.title,
      file_name: meta.fileName,
    },
    content: {
      mimeType: meta.mimeType,
      uri: `gs://${gcpConfig.gcsBucket}/${meta.gcsObject}`,
    },
  });

  const manifestObject = metadataObjectName(meta.userId, meta.materialId);
  await uploadObject(manifestObject, manifestLine + '\n', 'application/x-ndjson');

  const response = await discoveryFetch(`${dataStorePath()}/branches/default_branch/documents:import`, {
    method: 'POST',
    body: JSON.stringify({
      gcsSource: {
        inputUris: [`gs://${gcpConfig.gcsBucket}/${manifestObject}`],
        dataSchema: 'document',
      },
      reconciliationMode: 'INCREMENTAL',
    }),
  });
  if (!response.ok) {
    throw new Error(`Document import failed (${response.status}): ${await response.text()}`);
  }
  const operation = await response.json();
  return operation.name as string;
}

export interface OperationStatus {
  done: boolean;
  error?: string;
}

export async function getImportOperation(operationName: string): Promise<OperationStatus> {
  const response = await discoveryFetch(operationName);
  if (!response.ok) {
    throw new Error(`Operation poll failed (${response.status}): ${await response.text()}`);
  }
  const op = await response.json();
  if (!op.done) return { done: false };
  if (op.error) return { done: true, error: op.error.message ?? 'Import failed' };
  const failureCount = Number(op.metadata?.failureCount ?? 0);
  if (failureCount > 0) {
    const sample = op.response?.errorSamples?.[0]?.message;
    return { done: true, error: sample ?? `Import reported ${failureCount} failure(s)` };
  }
  return { done: true };
}

export async function deleteDocument(materialId: string): Promise<void> {
  assertUuid(materialId, 'material_id');
  const response = await discoveryFetch(
    `${dataStorePath()}/branches/default_branch/documents/${materialId}`,
    { method: 'DELETE' },
  );
  // 404 = never indexed or already removed; both fine on the delete path.
  if (!response.ok && response.status !== 404) {
    throw new Error(`Document delete failed (${response.status}): ${await response.text()}`);
  }
}

export interface SearchScope {
  userId: string;
  folderId?: string | null;
  materialIds?: string[];
}

export interface RetrievedChunk {
  content: string;
  title: string;
  materialId: string;
}

// Chunk names look like .../documents/<materialId>/chunks/<n> and the
// document id is the material id, so it can be recovered even when the
// chunk response omits structData.
function materialIdFromChunkName(name: string | undefined): string {
  const match = /\/documents\/([0-9a-f-]{36})\//i.exec(name ?? '');
  return match?.[1] ?? '';
}

// Searches the datastore in CHUNKS mode, always filtered to the requesting
// user's documents; optionally narrowed to a folder or explicit materials.
export async function searchChunks(
  query: string,
  scope: SearchScope,
  pageSize = 10,
): Promise<RetrievedChunk[]> {
  assertUuid(scope.userId, 'user_id');
  const filters = [`user_id: ANY("${scope.userId}")`];
  if (scope.materialIds?.length) {
    scope.materialIds.forEach((id) => assertUuid(id, 'material_id'));
    filters.push(`material_id: ANY(${scope.materialIds.map((id) => `"${id}"`).join(',')})`);
  } else if (scope.folderId) {
    assertUuid(scope.folderId, 'folder_id');
    filters.push(`folder_id: ANY("${scope.folderId}")`);
  }

  const response = await discoveryFetch(
    `${dataStorePath()}/servingConfigs/default_search:search`,
    {
      method: 'POST',
      body: JSON.stringify({
        query: query.slice(0, 2000),
        pageSize,
        filter: filters.join(' AND '),
        contentSearchSpec: { searchResultMode: 'CHUNKS' },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Search failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();

  const chunks: RetrievedChunk[] = [];
  for (const result of data.results ?? []) {
    const chunk = result.chunk;
    if (!chunk?.content) continue;
    const structData = chunk.documentMetadata?.structData ?? {};
    chunks.push({
      content: chunk.content,
      title: structData.title ?? chunk.documentMetadata?.title ?? 'Untitled',
      materialId: structData.material_id ?? materialIdFromChunkName(chunk.name),
    });
  }
  return chunks;
}
