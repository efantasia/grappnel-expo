// Cloud Run job for Grappnel media materials (uploads only — YouTube
// materials use the video's own captions, fetched by the edge functions).
// One execution per material:
//
//   1. download INPUT_OBJECT (audio or video) from the GCS bucket
//   2. ffmpeg -> mono 16 kHz MP3 (strips video; shrinks an hour of anything
//      to ~15 MB, comfortably under Velma's 100 MB request cap)
//   3. POST to Modulate's Velma batch STT API (synchronous — the transcript
//      comes back in the response)
//   4. write the transcript to TRANSCRIPT_OBJECT as one timestamped sentence
//      per line ("[12:04] …", blank-line separated) built from Velma's
//      utterances — the same shape as YouTube caption transcripts, so search
//      chunks and study-guide citations carry dense per-sentence timestamps
//
// On any failure the error message is written to ERROR_OBJECT instead and
// the process exits 0 — check-material reads the marker; a non-zero exit is
// reserved for crashes so Cloud Run's retry only re-runs those.
//
// Auth: GCS via the runtime service account (metadata server token); Velma
// via the VELMA_API_KEY env var (Secret Manager, wired up by setup-gcp.sh).

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Agent, fetch as undiciFetch, FormData } from 'undici';

const VELMA_URL = 'https://platform.modulate.ai/api/velma-2-stt-batch';
const VELMA_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Velma's batch endpoint holds the connection until the transcript is ready,
// so lift undici's default 5-minute header/body timeouts well past it.
const velmaAgent = new Agent({ headersTimeout: 45 * 60_000, bodyTimeout: 45 * 60_000 });

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function gcsAccessToken() {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!response.ok) {
    throw new Error(`Metadata token fetch failed (${response.status})`);
  }
  const data = await response.json();
  return data.access_token;
}

async function downloadObject(bucket, objectName, filePath) {
  const token = await gcsAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) {
    throw new Error(`GCS download failed for ${objectName} (${response.status}): ${await response.text()}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
}

async function uploadObjectText(bucket, objectName, text, contentType) {
  const token = await gcsAccessToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: text,
  });
  if (!response.ok) {
    throw new Error(`GCS upload failed for ${objectName} (${response.status}): ${await response.text()}`);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function extractAudio(inputPath, outputPath) {
  await run('ffmpeg', [
    '-hide_banner', '-nostdin', '-y',
    '-i', inputPath,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    outputPath,
  ]);
}

async function transcribe(audioPath, apiKey) {
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append('upload_file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('speaker_diarization', 'true');

  const response = await undiciFetch(VELMA_URL, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
    body: form,
    dispatcher: velmaAgent,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Velma transcription failed (${response.status}): ${detail}`);
  }
  const result = await response.json();
  if (typeof result.text !== 'string' || result.text.trim() === '') {
    throw new Error('Velma returned an empty transcript — the file may contain no speech.');
  }
  return result;
}

// Sentence splitting mirrors supabase/functions/_shared/youtube.ts so uploaded-
// media transcripts look exactly like YouTube ones: sentence-final punctuation
// (optionally wrapped in closing quotes/brackets) at a whitespace boundary, so
// decimals ("3.14") don't split.
const SENTENCE_SPLIT_RE = /(?<=[.!?…]["')\]]*)\s+/;
const SENTENCE_END_RE = /[.!?…]["')\]]*$/;
// If a stretch carries no sentence-final punctuation, break on time instead so
// timestamps stay dense enough to cite.
const SENTENCE_MAX_SECONDS = 30;

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Velma utterances as { offset(seconds), text } segments — the analog of a
// YouTube caption cue. A sentence is stamped with the offset of the utterance
// it starts in.
function utteranceSegments(result) {
  return (Array.isArray(result.utterances) ? result.utterances : [])
    .map((u) => ({
      offset:
        typeof u.start_ms === 'number' && Number.isFinite(u.start_ms) ? u.start_ms / 1000 : null,
      text: typeof u.text === 'string' ? u.text.trim() : '',
    }))
    .filter((s) => s.offset !== null && s.text !== '');
}

// Renders the transcript as one timestamped sentence per line, blank-line
// separated — identical to _shared/youtube.ts's formatCaptionTranscript. Falls
// back to the flat text if the response carries no usable (timed) utterances.
function formatTranscript(result) {
  const segments = utteranceSegments(result).sort((a, b) => a.offset - b.offset);
  if (segments.length === 0) return typeof result.text === 'string' ? result.text : '';

  const lines = [];
  let pending = [];
  let start = 0;
  const flush = () => {
    if (pending.length === 0) return;
    lines.push(`[${formatTimestamp(start)}] ${pending.join(' ')}`);
    pending = [];
  };

  for (const segment of segments) {
    if (pending.length > 0 && segment.offset - start >= SENTENCE_MAX_SECONDS) flush();
    for (const piece of segment.text.split(SENTENCE_SPLIT_RE)) {
      const trimmed = piece.trim();
      if (trimmed === '') continue;
      if (pending.length === 0) start = segment.offset;
      pending.push(trimmed);
      if (SENTENCE_END_RE.test(trimmed)) flush();
    }
  }
  flush();

  return lines.join('\n\n');
}

async function main() {
  const bucket = requiredEnv('GCS_BUCKET');
  const apiKey = requiredEnv('VELMA_API_KEY');
  const inputObject = requiredEnv('INPUT_OBJECT');
  const transcriptObject = requiredEnv('TRANSCRIPT_OBJECT');

  const workDir = await mkdtemp(join(tmpdir(), 'transcribe-'));
  const inputPath = join(workDir, 'input');
  const audioPath = join(workDir, 'audio.mp3');

  console.log(`Downloading gs://${bucket}/${inputObject}`);
  await downloadObject(bucket, inputObject, inputPath);

  console.log('Extracting audio');
  await extractAudio(inputPath, audioPath);
  const { size } = await stat(audioPath);
  if (size > VELMA_MAX_UPLOAD_BYTES) {
    throw new Error('Audio track is too long to transcribe (over 100 MB after compression).');
  }

  console.log(`Transcribing ${Math.round(size / 1024)} KB of audio`);
  const result = await transcribe(audioPath, apiKey);
  const transcript = formatTranscript(result);

  console.log(`Writing transcript to gs://${bucket}/${transcriptObject}`);
  await uploadObjectText(bucket, transcriptObject, transcript, 'text/plain; charset=utf-8');
  console.log('Done');
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Transcription failed:', message);
  try {
    await uploadObjectText(
      requiredEnv('GCS_BUCKET'),
      requiredEnv('ERROR_OBJECT'),
      message,
      'text/plain; charset=utf-8',
    );
  } catch (markerErr) {
    // Couldn't record the failure — exit non-zero so Cloud Run retries and
    // check-material's timeout is the last resort.
    console.error('Failed to write error marker:', markerErr);
    process.exit(1);
  }
}
