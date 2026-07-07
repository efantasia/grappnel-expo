// Google Cloud Storage helpers via the JSON REST API (no SDK — Deno edge
// compatible). Modeled on honeylove-data-bot/rag-sync.

import { getGoogleAccessToken } from './google-auth.ts';
import { gcpConfig } from './config.ts';

const STORAGE_API = 'https://storage.googleapis.com/storage/v1';
const UPLOAD_API = 'https://storage.googleapis.com/upload/storage/v1';

export async function uploadObject(
  objectName: string,
  body: ReadableStream<Uint8Array> | Uint8Array | string,
  contentType: string,
): Promise<void> {
  const token = await getGoogleAccessToken();
  const url = `${UPLOAD_API}/b/${gcpConfig.gcsBucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`GCS upload failed for ${objectName} (${response.status}): ${await response.text()}`);
  }
}

export async function objectExists(objectName: string): Promise<boolean> {
  const token = await getGoogleAccessToken();
  const url = `${STORAGE_API}/b/${gcpConfig.gcsBucket}/o/${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  if (!response.ok) {
    throw new Error(`GCS stat failed for ${objectName} (${response.status}): ${await response.text()}`);
  }
  await response.body?.cancel();
  return true;
}

export async function readObjectText(objectName: string): Promise<string> {
  const token = await getGoogleAccessToken();
  const url = `${STORAGE_API}/b/${gcpConfig.gcsBucket}/o/${encodeURIComponent(objectName)}?alt=media`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GCS read failed for ${objectName} (${response.status}): ${await response.text()}`);
  }
  return response.text();
}

export async function deleteObject(objectName: string): Promise<void> {
  const token = await getGoogleAccessToken();
  const url = `${STORAGE_API}/b/${gcpConfig.gcsBucket}/o/${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 means already gone — fine for cleanup paths.
  if (!response.ok && response.status !== 404) {
    throw new Error(`GCS delete failed for ${objectName} (${response.status}): ${await response.text()}`);
  }
}
