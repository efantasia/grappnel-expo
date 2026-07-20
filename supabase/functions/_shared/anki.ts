// Anki .apkg export. export-anki writes a spec JSON to GCS and starts the
// grappnel-anki-export Cloud Run job (gcp/anki-export-job), which builds the
// .apkg and writes it back to GCS; check-export polls for it (or the error
// marker) and signs a download URL. GCS in / GCS out — same shape as the
// transcribe and figure jobs.

import { getGoogleAccessToken } from './google-auth.ts';
import { gcpConfig } from './config.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertExportId(value: string): void {
  if (!UUID_RE.test(value)) throw new Error('Invalid export id');
}

export function exportPrefix(userId: string, exportId: string): string {
  return `exports/${userId}/${exportId}/`;
}

export function specObjectName(userId: string, exportId: string): string {
  return `${exportPrefix(userId, exportId)}spec.json`;
}

export function apkgObjectName(userId: string, exportId: string): string {
  return `${exportPrefix(userId, exportId)}deck.apkg`;
}

export function exportErrorObjectName(userId: string, exportId: string): string {
  return `${exportPrefix(userId, exportId)}error.txt`;
}

// Starts one execution of the export job. Fire-and-forget: completion is
// observed via the .apkg or error object, not the execution.
export async function startAnkiExportJob(
  specObject: string,
  outputObject: string,
  errorObject: string,
): Promise<void> {
  const token = await getGoogleAccessToken();
  const jobPath = `projects/${gcpConfig.projectId}/locations/${gcpConfig.ankiExportRegion}/jobs/${gcpConfig.ankiExportJob}`;
  const response = await fetch(`https://run.googleapis.com/v2/${jobPath}:run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: 'SPEC_OBJECT', value: specObject },
              { name: 'OUTPUT_OBJECT', value: outputObject },
              { name: 'ERROR_OBJECT', value: errorObject },
            ],
          },
        ],
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Anki export job start failed (${response.status}): ${await response.text()}`);
  }
  await response.body?.cancel();
}
