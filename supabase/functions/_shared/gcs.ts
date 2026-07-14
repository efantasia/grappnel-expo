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

// Starts a resumable upload session and returns the session URI, which
// accepts the bytes with no further auth — safe to hand to the client for a
// direct upload. The session is bound to the object name, content type, and
// exact byte length declared here, so the client can't upload anything else.
// Forwarding the browser's Origin makes GCS answer CORS on the session URI.
export async function createResumableUploadSession(
  objectName: string,
  contentType: string,
  contentLength: number,
  origin?: string,
): Promise<string> {
  const token = await getGoogleAccessToken();
  const url = `${UPLOAD_API}/b/${gcpConfig.gcsBucket}/o?uploadType=resumable&name=${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(contentLength),
      ...(origin ? { Origin: origin } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `GCS upload session failed for ${objectName} (${response.status}): ${await response.text()}`,
    );
  }
  await response.body?.cancel();
  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`GCS upload session for ${objectName} returned no session URI`);
  }
  return location;
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
