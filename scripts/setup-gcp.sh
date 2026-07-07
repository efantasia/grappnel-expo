#!/usr/bin/env bash
# Provisions the Google Cloud resources Grappnel's edge functions need:
#   - a GCS bucket for material content + import manifests
#   - a Vertex AI Search (Discovery Engine) datastore with layout parsing and
#     chunking enabled (required for CHUNKS search mode), plus a search engine
#   - an explicit schema so user_id / folder_id / material_id are filterable
#   - a service account with least-privilege roles and a JSON key
#
# Usage:
#   ./scripts/setup-gcp.sh <gcp-project-id> [prefix]
#
# The optional prefix (default: grappnel) names the bucket, datastore, and
# service account. Requires: gcloud (authenticated), curl.
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
  aiplatform.googleapis.com iam.googleapis.com --project "${PROJECT_ID}"

echo "==> Creating GCS bucket gs://${BUCKET}"
if gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "    bucket already exists, skipping"
else
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "${PROJECT_ID}" \
    --location "${BUCKET_LOCATION}" \
    --uniform-bucket-level-access
fi

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
    VERTEX_SEARCH_DATASTORE_ID=${DATASTORE_ID}

For local development, put the same values in supabase/functions/.env
(gitignored) before 'supabase functions serve'.
EOF
