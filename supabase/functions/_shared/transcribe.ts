// Audio/video materials can't be indexed by Vertex AI Search directly, so
// they take a detour: sync-material starts the grappnel-transcribe Cloud Run
// job (gcp/transcribe-job), which extracts the audio track with ffmpeg,
// transcribes it with Modulate's Velma batch API, and writes the transcript
// to GCS. check-material polls for the transcript (or error marker) object
// and then imports the transcript into the search index like any document.

import { getGoogleAccessToken } from './google-auth.ts';
import { gcpConfig } from './config.ts';
import { deleteObject } from './gcs.ts';

export function isMediaMimeType(mimeType: string): boolean {
  return mimeType.startsWith('audio/') || mimeType.startsWith('video/');
}

export function transcriptObjectName(userId: string, materialId: string): string {
  return `transcripts/${userId}/${materialId}.txt`;
}

// Written by the job instead of the transcript when transcription fails; its
// content is the error message.
export function transcriptErrorObjectName(userId: string, materialId: string): string {
  return `transcripts/${userId}/${materialId}.error.txt`;
}

// Starts one execution of the transcription job for a material already
// copied to GCS. Fire-and-forget: completion is observed via the transcript
// or error object, not the execution.
export async function runTranscribeJob(
  inputObject: string,
  transcriptObject: string,
  errorObject: string,
): Promise<void> {
  const token = await getGoogleAccessToken();
  const jobPath = `projects/${gcpConfig.projectId}/locations/${gcpConfig.transcribeRegion}/jobs/${gcpConfig.transcribeJob}`;
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
              { name: 'INPUT_OBJECT', value: inputObject },
              { name: 'TRANSCRIPT_OBJECT', value: transcriptObject },
              { name: 'ERROR_OBJECT', value: errorObject },
            ],
          },
        ],
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Transcription job start failed (${response.status}): ${await response.text()}`);
  }
  await response.body?.cancel();
}

// Clears stale transcript/error markers from any previous run (so
// check-material can't mistake them for this run's) and starts the job.
export async function startTranscription(
  userId: string,
  materialId: string,
  inputObject: string,
): Promise<void> {
  const transcriptObject = transcriptObjectName(userId, materialId);
  const errorObject = transcriptErrorObjectName(userId, materialId);
  await deleteObject(transcriptObject);
  await deleteObject(errorObject);
  await runTranscribeJob(inputObject, transcriptObject, errorObject);
}
