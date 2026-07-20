// Cloud Run job: build an Anki .apkg for one flashcard deck. The export-anki
// edge function writes a spec JSON to GCS and triggers this job:
//
//   1. read SPEC_OBJECT (deck title + cards, each with its figure/occlusion)
//   2. for each card, fetch its figure from GCS; for image-occlusion cards,
//      bake the mask into the front image (sharp) and keep the original for the
//      back — text import can't carry Anki's interactive occlusion, so we flatten
//   3. assemble Basic/Cloze notes (+ media) and build the .apkg (apkg.js)
//   4. upload it to OUTPUT_OBJECT; check-export signs a download URL for it
//
// On failure the message is written to ERROR_OBJECT and the process exits 0
// (check-export reads the marker); a non-zero exit is reserved for crashes.
// Auth: GCS via the runtime service account (metadata token).

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { buildApkg } from './apkg.js';

// Mask padding — matches src/components/occluded-image.tsx so the baked mask
// covers the label as reliably as the in-app one.
const PAD_BOX = 0.25;
const PAD_IMG_X = 0.03;
const PAD_IMG_Y = 0.02;
const MASK_COLOR = '#5A4FCF';

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
  if (!response.ok) throw new Error(`Metadata token fetch failed (${response.status})`);
  return (await response.json()).access_token;
}

async function readObject(bucket, objectName) {
  const token = await metadataToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`GCS read failed for ${objectName} (${response.status}): ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
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

const clamp = (v) => Math.max(0, Math.min(1, v));

function escapeHtml(text) {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extFor(mime) {
  return mime === 'image/png' ? 'png' : 'jpg';
}

// Builds the Anki cloze field: "The _____ is …" (answer "X") -> "The {{c1::X}} is …".
function clozeText(front, answer) {
  const cloze = `{{c1::${escapeHtml(answer.trim())}}}`;
  if (front.includes('_____')) {
    return front.split('_____').map(escapeHtml).join(cloze);
  }
  return `${escapeHtml(front)} ${cloze}`.trim();
}

// Draws the (padded) occlusion boxes onto the figure as filled rectangles.
async function bakeMask(imageBuffer, boxes) {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H || !boxes.length) return imageBuffer;
  const rects = boxes
    .map((b) => {
      const padX = b[2] * PAD_BOX + PAD_IMG_X;
      const padY = b[3] * PAD_BOX + PAD_IMG_Y;
      const x = clamp(b[0] - padX);
      const y = clamp(b[1] - padY);
      const w = clamp(b[2] + 2 * padX);
      const h = clamp(b[3] + 2 * padY);
      return `<rect x="${(x * W).toFixed(1)}" y="${(y * H).toFixed(1)}" width="${(Math.min(1 - x, w) * W).toFixed(1)}" height="${(Math.min(1 - y, h) * H).toFixed(1)}" rx="6" fill="${MASK_COLOR}"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects}</svg>`;
  return sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 82 })
    .toBuffer();
}

async function main() {
  const bucket = requiredEnv('GCS_BUCKET');
  const specObject = requiredEnv('SPEC_OBJECT');
  const outputObject = requiredEnv('OUTPUT_OBJECT');

  const spec = JSON.parse((await readObject(bucket, specObject)).toString('utf-8'));
  const cards = Array.isArray(spec.cards) ? spec.cards : [];
  const mediaPrefix = `gpnl-${randomUUID().slice(0, 8)}-`;

  const notes = [];
  const media = [];
  let mediaSeq = 0;

  for (const card of cards) {
    const source = card.citation ? `<br><small>Source: ${escapeHtml(card.citation)}</small>` : '';
    const figure = card.figure;

    if (card.type === 'image_occlusion' && figure && Array.isArray(card.occlusion)) {
      const original = await readObject(bucket, figure.object);
      const frontImg = await bakeMask(original, card.occlusion);
      const frontName = `${mediaPrefix}${mediaSeq++}.jpg`;
      const backName = `${mediaPrefix}${mediaSeq++}.${extFor(figure.mime)}`;
      media.push({ filename: frontName, data: frontImg });
      media.push({ filename: backName, data: original });
      notes.push({
        model: 'basic',
        fields: [
          `<img src="${frontName}"><br>${escapeHtml(card.front)}`,
          `<img src="${backName}"><br><b>${escapeHtml(card.back)}</b>${source}`,
        ],
      });
      continue;
    }

    // Plain figure (if any) shown on the question side, matching the app.
    let imgTag = '';
    if (figure) {
      const data = await readObject(bucket, figure.object);
      const name = `${mediaPrefix}${mediaSeq++}.${extFor(figure.mime)}`;
      media.push({ filename: name, data });
      imgTag = `<img src="${name}"><br>`;
    }

    if (card.type === 'cloze') {
      notes.push({
        model: 'cloze',
        fields: [`${imgTag}${clozeText(card.front, card.back)}`, source ? source.replace(/^<br>/, '') : ''],
      });
    } else {
      notes.push({
        model: 'basic',
        fields: [`${imgTag}${escapeHtml(card.front)}`, `${escapeHtml(card.back)}${source}`],
      });
    }
  }

  console.log(`Building .apkg: ${notes.length} notes, ${media.length} media files`);
  const apkg = await buildApkg({ deckName: spec.deck || 'Grappnel deck', notes, media });

  console.log(`Uploading .apkg (${Math.round(apkg.length / 1024)} KB) to gs://${bucket}/${outputObject}`);
  await uploadObject(bucket, outputObject, apkg, 'application/octet-stream');
  console.log('Done');
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Anki export failed:', message);
  try {
    await uploadObject(requiredEnv('GCS_BUCKET'), requiredEnv('ERROR_OBJECT'), message, 'text/plain; charset=utf-8');
  } catch (markerErr) {
    console.error('Failed to write error marker:', markerErr);
    process.exit(1);
  }
}
