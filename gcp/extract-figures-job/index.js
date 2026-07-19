// Cloud Run job for Grappnel figure extraction (document uploads only — audio,
// video, plain text and YouTube materials have no embedded images). One
// execution per material:
//
//   1. download INPUT_OBJECT (PDF or Office file) from the GCS bucket
//   2. pull the embedded images out of it:
//        - PDF   -> `pdfimages -all -p` (raster images, tagged with page)
//        - Office -> `unzip` the ppt/word/xl `media/` entries (zip archives)
//   3. drop decorative junk: too-small / extreme-aspect images, and images
//      whose raw bytes repeat across many pages (logos, slide templates)
//   4. normalize each survivor with sharp (auto-rotate, cap to 1600px, JPEG or
//      PNG-with-alpha) and cap the count to the largest MAX_FIGURES
//   5. caption each with Vertex Gemini (also drops images Gemini judges not to
//      be meaningful figures)
//   6. upload the kept figures to FIGURES_PREFIX and write a manifest JSON to
//      MANIFEST_OBJECT — check-material reads the manifest and records rows
//
// On any failure the message is written to ERROR_OBJECT and the process exits 0
// (check-material reads the marker); a non-zero exit is reserved for crashes so
// Cloud Run's retry only re-runs those. Matches gcp/transcribe-job's contract.
//
// Auth: GCS + Vertex AI both use the runtime service account (metadata server
// token, cloud-platform scope).

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import sharp from 'sharp';

// Only raster formats sharp can decode; pdfimages/unzip may also emit vector
// (emf/wmf/svg) or bilevel (pbm/ppm) files we skip.
const READABLE_EXT = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'gif']);

const MIN_DIM = 150; // px on the shorter side — smaller is an icon/bullet/rule
const ASPECT_MAX = 6; // wider/taller than 6:1 is almost always a rule or banner
const REPEAT_DROP = 3; // an identical image on >3 pages is a logo/template
const MAX_FIGURES = 40; // keep the largest N; caption budget per material
const MAX_EDGE = 1600; // downscale ceiling for stored figures

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function metadataToken() {
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
  const token = await metadataToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) {
    throw new Error(`GCS download failed for ${objectName} (${response.status}): ${await response.text()}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
}

async function uploadObject(bucket, objectName, body, contentType) {
  const token = await metadataToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
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
      // unzip exits 11 when none of the requested members exist (a document
      // with no media) — not a failure for us.
      if (code === 0 || (command === 'unzip' && code === 11)) resolve(stderr);
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// Runs up to `limit` tasks concurrently, preserving input order in the output.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

function extName(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

// pdfimages -p names files "<root>-<page>-<num>.<ext>"; recover the page.
function pageFromPdfImageName(fileName) {
  const match = /-(\d+)-\d+\.[a-z0-9]+$/i.exec(fileName);
  return match ? Number(match[1]) : null;
}

// Returns candidate image file paths (+ source page) extracted from the input.
async function extractImages(inputPath, mimeType, workDir) {
  if (mimeType === 'application/pdf') {
    const root = join(workDir, 'img');
    await run('pdfimages', ['-all', '-p', inputPath, root]);
    const names = await readdir(workDir);
    return names
      .filter((n) => n.startsWith('img-') && READABLE_EXT.has(extName(n)))
      .map((n) => ({ path: join(workDir, n), page: pageFromPdfImageName(n), name: n }));
  }

  // Office Open XML files are zip archives with images under */media/.
  const outDir = join(workDir, 'unzipped');
  await run('unzip', [
    '-o', '-j', inputPath,
    'ppt/media/*', 'word/media/*', 'xl/media/*',
    '-d', outDir,
  ]);
  let names = [];
  try {
    names = await readdir(outDir);
  } catch {
    return []; // no media dir extracted
  }
  return names
    .filter((n) => READABLE_EXT.has(extName(n)))
    .sort()
    .map((n) => ({ path: join(outDir, n), page: null, name: n }));
}

// Filters to real-figure candidates: readable by sharp, big enough, sane
// aspect ratio, and not a byte-for-byte repeat across many pages (decorative).
async function selectCandidates(files) {
  const counts = new Map();
  const enriched = [];
  for (const file of files) {
    let raw;
    try {
      raw = await readFile(file.path);
    } catch {
      continue;
    }
    let meta;
    try {
      meta = await sharp(raw, { failOn: 'none' }).metadata();
    } catch {
      continue; // unreadable format (pbm/emf/…)
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < MIN_DIM || height < MIN_DIM) continue;
    const aspect = width / height;
    if (aspect > ASPECT_MAX || aspect < 1 / ASPECT_MAX) continue;
    const hash = createHash('sha256').update(raw).digest('hex');
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
    enriched.push({ ...file, raw, width, height, hash });
  }

  const seen = new Set();
  const kept = [];
  for (const file of enriched) {
    if (counts.get(file.hash) > REPEAT_DROP) continue; // logo/template
    if (seen.has(file.hash)) continue; // exact duplicate
    seen.add(file.hash);
    kept.push(file);
  }

  // Keep the largest MAX_FIGURES (bigger => more likely a real figure), then
  // restore reading order (page, then original position) for stable ordinals.
  kept.sort((a, b) => b.width * b.height - a.width * a.height);
  const capped = kept.slice(0, MAX_FIGURES);
  capped.sort(
    (a, b) => (a.page ?? 1e9) - (b.page ?? 1e9) || a.name.localeCompare(b.name),
  );
  return capped;
}

// Auto-rotate, downscale, and re-encode to a compact web image. PNG only when
// the source has transparency (diagrams); JPEG otherwise (photos/scans).
async function normalize(raw) {
  const image = sharp(raw, { failOn: 'none' }).rotate();
  const meta = await image.metadata();
  const resized = image.resize({
    width: MAX_EDGE,
    height: MAX_EDGE,
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (meta.hasAlpha) {
    const buffer = await resized.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    return { buffer: buffer.data, ext: 'png', mimeType: 'image/png', width: buffer.info.width, height: buffer.info.height };
  }
  const buffer = await resized.jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { buffer: buffer.data, ext: 'jpg', mimeType: 'image/jpeg', width: buffer.info.width, height: buffer.info.height };
}

const CAPTION_SYSTEM =
  'You are Grappnel\'s figure analyst. You receive one image extracted from a ' +
  'student\'s course material (a page figure, diagram, chart, photo, or an ' +
  'incidental graphic). Decide whether it is a meaningful study figure and, if ' +
  'so, describe it. "meaningful" is false for logos, decorative borders, ' +
  'headshots, icons, UI chrome, or near-blank images. "caption" is a concise ' +
  'sentence naming what the figure shows (its subject and, if a diagram/chart, ' +
  'what it depicts). "alt_text" is a short accessibility description. ' +
  'Also detect the text labels that annotate specific parts of the figure ' +
  '(e.g. structure names pointing at features of a diagram). For each such ' +
  'label return its exact visible text and a tight bounding box "box_2d" as ' +
  '[ymin, xmin, ymax, xmax] using integers 0-1000 normalized to the image. ' +
  'Include ONLY short labels that name a specific part or structure — skip the ' +
  'figure title, captions, legends, axis numbers, and body/paragraph text. ' +
  'Return an empty "labels" list when the figure has no such part labels. Base ' +
  'everything only on what is visible.';

const CAPTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    meaningful: { type: 'BOOLEAN' },
    caption: { type: 'STRING' },
    alt_text: { type: 'STRING' },
    labels: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
        },
        required: ['text', 'box_2d'],
      },
    },
  },
  required: ['meaningful', 'caption', 'alt_text'],
};

const MAX_LABELS = 25;

// Gemini returns boxes as [ymin, xmin, ymax, xmax] normalized to 0-1000;
// convert to [x, y, w, h] fractions (0-1) of the image and clamp. Null if
// unusable, so a bad box is dropped rather than mis-masking a card.
function toFractionBox(box2d) {
  if (!Array.isArray(box2d) || box2d.length !== 4) return null;
  const nums = box2d.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const [ymin, xmin, ymax, xmax] = nums;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const round = (v) => Math.round(v * 1e4) / 1e4;
  const x = clamp(Math.min(xmin, xmax) / 1000);
  const y = clamp(Math.min(ymin, ymax) / 1000);
  const w = clamp(Math.abs(xmax - xmin) / 1000);
  const h = clamp(Math.abs(ymax - ymin) / 1000);
  if (w <= 0 || h <= 0) return null;
  return [round(x), round(y), round(w), round(h)];
}

function parseLabels(raw) {
  if (!Array.isArray(raw)) return [];
  const labels = [];
  for (const item of raw) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const box = toFractionBox(item?.box_2d);
    if (text && box) labels.push({ text: text.slice(0, 200), box });
    if (labels.length >= MAX_LABELS) break;
  }
  return labels;
}

function geminiEndpoint(projectId, location, model) {
  const host =
    location === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

// Returns { meaningful, caption, alt_text }. Fails open (keep the figure with
// no caption) so a Gemini hiccup never silently drops a real figure.
async function captionFigure(endpoint, buffer, mimeType) {
  try {
    const token = await metadataToken();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CAPTION_SYSTEM }] },
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: buffer.toString('base64') } },
              { text: 'Analyze this figure.' },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          // Generous ceiling: thinking-capable Flash models spend output tokens
          // on internal reasoning first, so a tight cap truncates the JSON
          // mid-string (the caption never completes). The actual caption is
          // tiny, so a high cap costs nothing extra but avoids truncation.
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: CAPTION_SCHEMA,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Gemini caption failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    const data = await response.json();
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    // Surface truncation clearly instead of as a downstream "unterminated JSON".
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      throw new Error(`caption response incomplete (finishReason=${candidate.finishReason})`);
    }
    const parsed = JSON.parse(text);
    return {
      meaningful: parsed.meaningful !== false,
      caption: typeof parsed.caption === 'string' ? parsed.caption.trim() : null,
      alt_text: typeof parsed.alt_text === 'string' ? parsed.alt_text.trim() : null,
      labels: parseLabels(parsed.labels),
    };
  } catch (err) {
    console.warn('Captioning failed, keeping figure uncaptioned:', err.message);
    return { meaningful: true, caption: null, alt_text: null, labels: [] };
  }
}

async function main() {
  const bucket = requiredEnv('GCS_BUCKET');
  const inputObject = requiredEnv('INPUT_OBJECT');
  const mimeType = requiredEnv('MIME_TYPE');
  const manifestObject = requiredEnv('MANIFEST_OBJECT');
  const figuresPrefix = requiredEnv('FIGURES_PREFIX'); // e.g. figures/<u>/<m>/
  const projectId = requiredEnv('GCP_PROJECT_ID');
  const geminiLocation = process.env.GEMINI_LOCATION || 'global';
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const endpoint = geminiEndpoint(projectId, geminiLocation, geminiModel);

  const workDir = await mkdtemp(join(tmpdir(), 'figures-'));
  const inputPath = join(workDir, 'input');

  console.log(`Downloading gs://${bucket}/${inputObject}`);
  await downloadObject(bucket, inputObject, inputPath);

  console.log('Extracting embedded images');
  const files = await extractImages(inputPath, mimeType, workDir);
  console.log(`Extracted ${files.length} raw image(s)`);

  const candidates = await selectCandidates(files);
  console.log(`${candidates.length} candidate figure(s) after filtering`);

  const processed = await mapLimit(candidates, 4, async (file) => {
    const norm = await normalize(file.raw);
    const caption = await captionFigure(endpoint, norm.buffer, norm.mimeType);
    return { file, norm, caption };
  });

  const figures = [];
  for (const item of processed) {
    if (!item.caption.meaningful) continue;
    const ordinal = figures.length;
    const object = `${figuresPrefix}${ordinal}.${item.norm.ext}`;
    await uploadObject(bucket, object, item.norm.buffer, item.norm.mimeType);
    figures.push({
      ordinal,
      object,
      page: item.file.page,
      width: item.norm.width,
      height: item.norm.height,
      mime_type: item.norm.mimeType,
      caption: item.caption.caption,
      alt_text: item.caption.alt_text,
      labels: item.caption.labels,
    });
  }

  console.log(`Writing manifest with ${figures.length} figure(s) to gs://${bucket}/${manifestObject}`);
  await uploadObject(
    bucket,
    manifestObject,
    JSON.stringify({ figures }),
    'application/json; charset=utf-8',
  );
  console.log('Done');
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Figure extraction failed:', message);
  try {
    await uploadObject(
      requiredEnv('GCS_BUCKET'),
      requiredEnv('ERROR_OBJECT'),
      message,
      'text/plain; charset=utf-8',
    );
  } catch (markerErr) {
    console.error('Failed to write error marker:', markerErr);
    process.exit(1);
  }
}
