// Google Cloud Storage helpers via the JSON REST API (no SDK — Deno edge
// compatible). Modeled on honeylove-data-bot/rag-sync.

import {
  getGoogleAccessToken,
  loadServiceAccount,
  signRsaSha256,
} from './google-auth.ts';
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

// Strict RFC 3986 percent-encoding (encodeURIComponent leaves !'()* alone,
// which breaks V4 signature verification).
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// attachment + both filename forms: a plain-ASCII fallback plus RFC 5987
// UTF-8 for everything else, so browsers save under the user's filename.
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc3986Encode(filename)}`;
}

// Mints a V4 signed download URL for an object, valid for `expiresSeconds`.
// The bucket is private, so this is how clients fetch original files; signing
// happens locally with the service account key (no IAM signBlob round trip).
// Spec: https://cloud.google.com/storage/docs/authentication/signatures
export async function createSignedDownloadUrl(
  objectName: string,
  filename: string,
  expiresSeconds = 900,
): Promise<string> {
  const host = 'storage.googleapis.com';
  const sa = loadServiceAccount();
  const iso = new Date().toISOString();
  const datestamp = iso.slice(0, 10).replace(/-/g, '');
  const timestamp = `${datestamp}T${iso.slice(11, 19).replace(/:/g, '')}Z`;
  const scope = `${datestamp}/auto/storage/goog4_request`;

  const path = `/${gcpConfig.gcsBucket}/${objectName.split('/').map(rfc3986Encode).join('/')}`;
  const query = [
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', `${sa.client_email}/${scope}`],
    ['X-Goog-Date', timestamp],
    ['X-Goog-Expires', String(expiresSeconds)],
    ['X-Goog-SignedHeaders', 'host'],
    ['response-content-disposition', attachmentDisposition(filename)],
  ]
    .map(([key, value]) => `${rfc3986Encode(key)}=${rfc3986Encode(value)}`)
    .sort()
    .join('&');

  const canonicalRequest = [
    'GET',
    path,
    query,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const requestHash = hex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)),
    ),
  );
  const stringToSign = ['GOOG4-RSA-SHA256', timestamp, scope, requestHash].join('\n');
  const signature = hex(await signRsaSha256(stringToSign));
  return `https://${host}${path}?${query}&X-Goog-Signature=${signature}`;
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
