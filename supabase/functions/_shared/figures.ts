// Figure extraction for document materials. Audio/video/plain-text and YouTube
// materials have no embedded images, so they are marked 'skipped'. For PDFs and
// Office files, sync-material starts the grappnel-extract-figures Cloud Run job
// (gcp/extract-figures-job), which pulls the embedded images out of the source,
// normalizes + captions them, writes them to GCS and records a manifest.
// check-material then imports that manifest into material_figures.
//
// figures_status: pending -> processing -> extracting -> extracted | skipped | error
//   (processing = job running; extracting = importing the manifest)

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getGoogleAccessToken } from './google-auth.ts';
import { gcpConfig } from './config.ts';
import { deleteObject, listObjects, objectExists, readObjectText } from './gcs.ts';

// Document types whose source file can carry embedded figures.
const FIGURE_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export function isFigureBearingMimeType(mimeType: string): boolean {
  return FIGURE_MIME_TYPES.has(mimeType);
}

// A job that has written neither a manifest nor an error marker after this long
// is presumed dead (crash without cleanup).
const FIGURES_TIMEOUT_MS = 30 * 60 * 1000;

// Cap defensively — the job already limits figures, but never trust a manifest.
const MAX_FIGURE_ROWS = 60;

export function figuresPrefix(userId: string, materialId: string): string {
  return `figures/${userId}/${materialId}/`;
}

export function figuresManifestObjectName(userId: string, materialId: string): string {
  return `${figuresPrefix(userId, materialId)}manifest.json`;
}

export function figuresErrorObjectName(userId: string, materialId: string): string {
  return `${figuresPrefix(userId, materialId)}error.txt`;
}

// The materials-row fields the figure pipeline needs (rows are read untyped).
export interface FigureSourceMaterial {
  id: string;
  user_id: string;
  mime_type: string;
  gcs_object: string | null;
  figures_status: string;
  updated_at: string;
}

// Starts one execution of the extraction job for a material whose source file
// is already in GCS. Fire-and-forget: completion is observed via the manifest
// or error object, not the execution.
async function runFigureJob(
  inputObject: string,
  mimeType: string,
  manifestObject: string,
  prefix: string,
  errorObject: string,
): Promise<void> {
  const token = await getGoogleAccessToken();
  const jobPath = `projects/${gcpConfig.projectId}/locations/${gcpConfig.figuresRegion}/jobs/${gcpConfig.figuresJob}`;
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
              { name: 'MIME_TYPE', value: mimeType },
              { name: 'MANIFEST_OBJECT', value: manifestObject },
              { name: 'FIGURES_PREFIX', value: prefix },
              { name: 'ERROR_OBJECT', value: errorObject },
            ],
          },
        ],
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Figure job start failed (${response.status}): ${await response.text()}`);
  }
  await response.body?.cancel();
}

// Clears any figures/markers from a previous run (so check-material can't
// mistake them for this run's) and starts the extraction job.
export async function startFigureExtraction(
  userId: string,
  materialId: string,
  inputObject: string,
  mimeType: string,
): Promise<void> {
  const prefix = figuresPrefix(userId, materialId);
  const stale = await listObjects(prefix);
  await Promise.all(stale.map((name) => deleteObject(name)));
  await runFigureJob(
    inputObject,
    mimeType,
    figuresManifestObjectName(userId, materialId),
    prefix,
    figuresErrorObjectName(userId, materialId),
  );
}

async function setFiguresStatus(
  admin: SupabaseClient,
  material: FigureSourceMaterial,
  status: string,
  error: string | null = null,
): Promise<void> {
  await admin
    .from('materials')
    .update({ figures_status: status, figures_error: error })
    .eq('id', material.id);
  material.figures_status = status;
}

interface ManifestLabel {
  text?: string;
  box?: number[];
}

interface ManifestFigure {
  ordinal?: number;
  object?: string;
  page?: number | null;
  width?: number | null;
  height?: number | null;
  mime_type?: string;
  caption?: string | null;
  alt_text?: string | null;
  labels?: ManifestLabel[];
}

// Validated figure labels ({ text, box: [x,y,w,h] fractions }) for occlusion.
function sanitizeLabels(raw: ManifestLabel[] | undefined): { text: string; box: number[] }[] {
  if (!Array.isArray(raw)) return [];
  const out: { text: string; box: number[] }[] = [];
  for (const item of raw) {
    const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 200) : '';
    const box =
      Array.isArray(item?.box) &&
      item.box.length === 4 &&
      item.box.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? item.box.map((n) => Math.max(0, Math.min(1, n)))
        : null;
    if (text && box) out.push({ text, box });
    if (out.length >= 25) break;
  }
  return out;
}

// Reads the job's manifest and replaces the material's figure rows with it.
async function importManifest(
  admin: SupabaseClient,
  material: FigureSourceMaterial,
  manifestObject: string,
): Promise<void> {
  const raw = await readObjectText(manifestObject);
  let figures: ManifestFigure[];
  try {
    figures = (JSON.parse(raw).figures ?? []) as ManifestFigure[];
  } catch {
    throw new Error('Figure manifest was not valid JSON');
  }

  const prefix = figuresPrefix(material.user_id, material.id);
  const rows = figures
    .filter((f) => typeof f.object === 'string' && f.object.startsWith(prefix))
    .slice(0, MAX_FIGURE_ROWS)
    .map((f, i) => ({
      user_id: material.user_id,
      material_id: material.id,
      gcs_object: f.object as string,
      ordinal: Number.isInteger(f.ordinal) ? (f.ordinal as number) : i,
      page: Number.isInteger(f.page) ? (f.page as number) : null,
      width: Number.isInteger(f.width) ? (f.width as number) : null,
      height: Number.isInteger(f.height) ? (f.height as number) : null,
      mime_type: typeof f.mime_type === 'string' ? f.mime_type : 'image/jpeg',
      caption: typeof f.caption === 'string' ? f.caption.slice(0, 2000) : null,
      alt_text: typeof f.alt_text === 'string' ? f.alt_text.slice(0, 2000) : null,
      labels: sanitizeLabels(f.labels),
    }));

  // Replace, don't append, so re-runs stay idempotent.
  const { error: deleteError } = await admin
    .from('material_figures')
    .delete()
    .eq('material_id', material.id);
  if (deleteError) throw new Error(deleteError.message);
  if (rows.length > 0) {
    const { error: insertError } = await admin.from('material_figures').insert(rows);
    if (insertError) throw new Error(insertError.message);
  }
  await setFiguresStatus(admin, material, 'extracted');
}

// Settles a material whose figure job is running: imports the manifest once it
// lands, records an error marker, or times out. No-op unless figures_status is
// 'processing'. Mutates material.figures_status so callers can reflect it.
// Never throws — a figure hiccup must not fail the whole check-material call.
export async function settleFigures(
  admin: SupabaseClient,
  material: FigureSourceMaterial,
): Promise<void> {
  if (material.figures_status !== 'processing') return;
  try {
    const manifestObject = figuresManifestObjectName(material.user_id, material.id);
    if (await objectExists(manifestObject)) {
      await setFiguresStatus(admin, material, 'extracting');
      await importManifest(admin, material, manifestObject);
      return;
    }
    const errorObject = figuresErrorObjectName(material.user_id, material.id);
    if (await objectExists(errorObject)) {
      const message = (await readObjectText(errorObject)).trim().slice(0, 500);
      await setFiguresStatus(admin, material, 'error', message || 'Figure extraction failed.');
      return;
    }
    if (Date.now() - new Date(material.updated_at).getTime() > FIGURES_TIMEOUT_MS) {
      await setFiguresStatus(admin, material, 'error', 'Figure extraction timed out.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`settleFigures failed for ${material.id}:`, message);
    await setFiguresStatus(admin, material, 'error', message.slice(0, 500)).catch(() => {});
  }
}
