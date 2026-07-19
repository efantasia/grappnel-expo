#!/usr/bin/env bash
# Provisions the Google Cloud resources Grappnel's edge functions need:
#   - a GCS bucket for material content + import manifests
#   - a Vertex AI Search (Discovery Engine) datastore with layout parsing and
#     chunking enabled (required for CHUNKS search mode), plus a search engine
#   - an explicit schema so user_id / folder_id / material_id are filterable
#   - a service account with least-privilege roles and a JSON key
#   - the transcription Cloud Run job (gcp/transcribe-job: ffmpeg + Velma)
#     with the Modulate API key in Secret Manager
#   - the figure-extraction Cloud Run job (gcp/extract-figures-job: poppler +
#     sharp + Vertex Gemini captions), which uses only the runtime service
#     account (no external secret)
#
# Usage:
#   VELMA_API_KEY=<modulate-console-admin-key> ./scripts/setup-gcp.sh <gcp-project-id> [prefix]
#
# VELMA_API_KEY is only needed the first time (it seeds the Secret Manager
# secret); later runs reuse the stored secret. The optional prefix (default:
# grappnel) names the bucket, datastore, job, and service account.
# Requires: gcloud (authenticated), curl.
set -euo pipefail

PROJECT_ID="${1:?Usage: setup-gcp.sh <gcp-project-id> [prefix]}"
PREFIX="${2:-grappnel}"

BUCKET="${PREFIX}-materials-${PROJECT_ID}"
DATASTORE_ID="${PREFIX}-materials"
ENGINE_ID="${PREFIX}-materials-app"
SA_NAME="${PREFIX}-functions"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
LOCATION="global"
BUCKET_LOCATION="us"
JOB_NAME="${PREFIX}-transcribe"
JOB_REGION="us-central1"
FIGURES_JOB_NAME="${PREFIX}-extract-figures"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash}"
GEMINI_LOCATION="${GEMINI_LOCATION:-global}"
VELMA_SECRET="${PREFIX}-velma-api-key"
KEY_FILE="secrets/${PREFIX}-sa.json"
API="https://discoveryengine.googleapis.com/v1"
PARENT="projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection"

auth_curl() {
  curl -sS -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" \
    -H "X-Goog-User-Project: ${PROJECT_ID}" "$@"
}

echo "==> Enabling required APIs"
gcloud services enable discoveryengine.googleapis.com storage.googleapis.com \
  aiplatform.googleapis.com iam.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com --project "${PROJECT_ID}"

echo "==> Creating GCS bucket gs://${BUCKET}"
if gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "    bucket already exists, skipping"
else
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "${PROJECT_ID}" \
    --location "${BUCKET_LOCATION}" \
    --uniform-bucket-level-access
fi

# Browser clients PUT uploads directly to GCS resumable-session URIs
# (create-upload edge function mints them), which needs CORS on the bucket.
# The bucket stays private — CORS only lets browsers make the request.
echo "==> Setting bucket CORS for direct browser uploads"
CORS_FILE="$(mktemp)"
cat > "${CORS_FILE}" <<'JSON'
[
  {
    "origin": ["*"],
    "method": ["PUT"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
JSON
gcloud storage buckets update "gs://${BUCKET}" \
  --project "${PROJECT_ID}" \
  --cors-file="${CORS_FILE}"
rm -f "${CORS_FILE}"

echo "==> Creating Vertex AI Search datastore ${DATASTORE_ID}"
if auth_curl -o /dev/null -w '%{http_code}' "${API}/${PARENT}/dataStores/${DATASTORE_ID}" | grep -q 200; then
  echo "    datastore already exists, skipping"
else
  auth_curl -X POST "${API}/${PARENT}/dataStores?dataStoreId=${DATASTORE_ID}" -d @- <<JSON
{
  "displayName": "Grappnel materials",
  "industryVertical": "GENERIC",
  "solutionTypes": ["SOLUTION_TYPE_SEARCH"],
  "contentConfig": "CONTENT_REQUIRED",
  "documentProcessingConfig": {
    "defaultParsingConfig": { "layoutParsingConfig": {} },
    "chunkingConfig": {
      "layoutBasedChunkingConfig": { "chunkSize": 500, "includeAncestorHeadings": true }
    }
  }
}
JSON
  echo ""
fi

echo "==> Setting explicit schema (filterable user_id / folder_id / material_id)"
auth_curl -X PATCH "${API}/${PARENT}/dataStores/${DATASTORE_ID}/schemas/default_schema" -d @- <<'JSON'
{
  "structSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "user_id": { "type": "string", "indexable": true, "retrievable": true },
      "folder_id": { "type": "string", "indexable": true, "retrievable": true },
      "material_id": { "type": "string", "indexable": true, "retrievable": true },
      "title": { "type": "string", "keyPropertyMapping": "title" },
      "file_name": { "type": "string", "retrievable": true }
    }
  }
}
JSON
echo ""

echo "==> Creating search engine ${ENGINE_ID}"
if auth_curl -o /dev/null -w '%{http_code}' "${API}/${PARENT}/engines/${ENGINE_ID}" | grep -q 200; then
  echo "    engine already exists, skipping"
else
  auth_curl -X POST "${API}/${PARENT}/engines?engineId=${ENGINE_ID}" -d @- <<JSON
{
  "displayName": "Grappnel search",
  "solutionType": "SOLUTION_TYPE_SEARCH",
  "dataStoreIds": ["${DATASTORE_ID}"],
  "searchEngineConfig": { "searchTier": "SEARCH_TIER_STANDARD" }
}
JSON
  echo ""
fi

echo "==> Creating service account ${SA_EMAIL}"
if gcloud iam service-accounts describe "${SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "    service account already exists, skipping"
else
  gcloud iam service-accounts create "${SA_NAME}" \
    --project "${PROJECT_ID}" \
    --display-name "Grappnel edge functions"
fi

echo "==> Granting roles"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/storage.objectAdmin --quiet >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/discoveryengine.editor --quiet >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/aiplatform.user --quiet >/dev/null

echo "==> Storing Modulate (Velma) API key in Secret Manager"
if gcloud secrets describe "${VELMA_SECRET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "    secret already exists, skipping (add a new version to rotate)"
elif [ -n "${VELMA_API_KEY:-}" ]; then
  printf '%s' "${VELMA_API_KEY}" | gcloud secrets create "${VELMA_SECRET}" \
    --project "${PROJECT_ID}" --data-file=-
else
  echo "    VELMA_API_KEY not set and secret missing — SKIPPING the transcription job."
  echo "    Audio/video uploads won't work until you re-run with"
  echo "    VELMA_API_KEY=<modulate-console-admin-key>."
fi

if gcloud secrets describe "${VELMA_SECRET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets add-iam-policy-binding "${VELMA_SECRET}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${SA_EMAIL}" --role roles/secretmanager.secretAccessor --quiet >/dev/null

  # Source deploys build via Cloud Build, which runs as the default compute
  # service account; on newer projects it has no permissions by default and
  # the build fails before it starts.
  echo "==> Granting Cloud Build permissions to the default compute service account"
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role roles/cloudbuild.builds.builder --quiet >/dev/null

  echo "==> Deploying transcription Cloud Run job ${JOB_NAME} (builds gcp/transcribe-job)"
  gcloud run jobs deploy "${JOB_NAME}" \
    --project "${PROJECT_ID}" \
    --region "${JOB_REGION}" \
    --source gcp/transcribe-job \
    --service-account "${SA_EMAIL}" \
    --memory 2Gi --cpu 2 --task-timeout 3600 --max-retries 1 \
    --set-env-vars "GCS_BUCKET=${BUCKET}" \
    --set-secrets "VELMA_API_KEY=${VELMA_SECRET}:latest"

  echo "==> Allowing ${SA_NAME} to execute the job"
  # developer (not invoker): executing with per-run env overrides requires
  # run.jobs.runWithOverrides, which invoker lacks. Bound to this job only.
  gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
    --project "${PROJECT_ID}" --region "${JOB_REGION}" \
    --member "serviceAccount:${SA_EMAIL}" --role roles/run.developer --quiet >/dev/null
fi

# The figure-extraction job needs no external secret (it uses the runtime SA for
# both GCS and Vertex Gemini), so it deploys independently of the Velma key.
echo "==> Granting Cloud Build permissions to the default compute service account"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role roles/cloudbuild.builds.builder --quiet >/dev/null

echo "==> Deploying figure-extraction Cloud Run job ${FIGURES_JOB_NAME} (builds gcp/extract-figures-job)"
gcloud run jobs deploy "${FIGURES_JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${JOB_REGION}" \
  --source gcp/extract-figures-job \
  --service-account "${SA_EMAIL}" \
  --memory 2Gi --cpu 2 --task-timeout 3600 --max-retries 1 \
  --set-env-vars "GCS_BUCKET=${BUCKET},GCP_PROJECT_ID=${PROJECT_ID},GEMINI_MODEL=${GEMINI_MODEL},GEMINI_LOCATION=${GEMINI_LOCATION}"

echo "==> Allowing ${SA_NAME} to execute the figure job"
gcloud run jobs add-iam-policy-binding "${FIGURES_JOB_NAME}" \
  --project "${PROJECT_ID}" --region "${JOB_REGION}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/run.developer --quiet >/dev/null

echo "==> Creating service account key ${KEY_FILE}"
mkdir -p secrets
if [ -f "${KEY_FILE}" ]; then
  echo "    ${KEY_FILE} already exists, skipping (delete it to mint a new key)"
else
  gcloud iam service-accounts keys create "${KEY_FILE}" \
    --iam-account "${SA_EMAIL}" --project "${PROJECT_ID}"
fi

cat <<EOF

Done. Now set the edge function secrets on your Supabase project:

  npx supabase secrets set \\
    GOOGLE_SERVICE_ACCOUNT_JSON="\$(cat ${KEY_FILE})" \\
    GCP_PROJECT_ID=${PROJECT_ID} \\
    GCS_BUCKET=${BUCKET} \\
    VERTEX_SEARCH_LOCATION=${LOCATION} \\
    VERTEX_SEARCH_DATASTORE_ID=${DATASTORE_ID} \\
    GCP_TRANSCRIBE_JOB=${JOB_NAME} \\
    GCP_TRANSCRIBE_REGION=${JOB_REGION} \\
    GCP_FIGURES_JOB=${FIGURES_JOB_NAME} \\
    GCP_FIGURES_REGION=${JOB_REGION}

For local development, put the same values in supabase/functions/.env
(gitignored) before 'supabase functions serve'.
EOF
