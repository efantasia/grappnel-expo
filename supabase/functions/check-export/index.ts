// Polls an in-flight Anki export (started by export-anki): returns a signed
// download URL for the .apkg once the job has written it, an error message if
// the job failed, or 'processing' otherwise. The export id is a UUID scoped
// under the caller's own prefix, so one user can't read another's export.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { getRequestUser } from '../_shared/supabase.ts';
import { createSignedDownloadUrl, objectExists, readObjectText } from '../_shared/gcs.ts';
import { apkgObjectName, assertExportId, exportErrorObjectName } from '../_shared/anki.ts';

function safeFileName(name: string | undefined): string {
  const base = (name ?? '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return base ? (base.endsWith('.apkg') ? base : `${base}.apkg`) : 'grappnel-deck.apkg';
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: { export_id?: string; file_name?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }
  if (!body.export_id) return errorResponse('export_id is required');
  try {
    assertExportId(body.export_id);
  } catch {
    return errorResponse('Invalid export_id');
  }

  const apkgObject = apkgObjectName(user.id, body.export_id);
  const errorObject = exportErrorObjectName(user.id, body.export_id);

  try {
    if (await objectExists(apkgObject)) {
      const url = await createSignedDownloadUrl(apkgObject, safeFileName(body.file_name));
      return jsonResponse({ status: 'ready', url });
    }
    if (await objectExists(errorObject)) {
      const message = (await readObjectText(errorObject)).trim().slice(0, 500);
      return jsonResponse({ status: 'error', message: message || 'Export failed.' });
    }
    return jsonResponse({ status: 'processing' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`check-export failed for ${body.export_id}:`, message);
    return errorResponse('Could not check the export.', 500);
  }
});
