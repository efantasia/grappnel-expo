// Audio/video materials can't be indexed by Vertex AI Search directly, so
// they take a detour: sync-material starts the grappnel-transcribe Cloud Run
// job (gcp/transcribe-job), which extracts the audio track with ffmpeg,
// transcribes it with Modulate's Velma batch API, and writes the transcript
// to GCS. check-material polls for the transcript (or error marker) object
// and then imports the transcript into the search index like any document.

import { getGoogleAccessToken } from './google-auth.ts';
import { gcpConfig } from './config.ts';

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
export async function runTranscribeJob(input: {
  inputObject: string;
  inputMimeType: string;
  transcriptObject: string;
  errorObject: string;
}): Promise<void> {
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
              { name: 'INPUT_OBJECT', value: input.inputObject },
              { name: 'INPUT_MIME', value: input.inputMimeType },
              { name: 'TRANSCRIPT_OBJECT', value: input.transcriptObject },
              { name: 'ERROR_OBJECT', value: input.errorObject },
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
