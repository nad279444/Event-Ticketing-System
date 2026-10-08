#!/usr/bin/env bash
set -euo pipefail

# One-time GCP infrastructure setup for the Event Ticketing System.
# Derived from plan.md. Safe to re-run (idempotent).
#
# Usage:
#   PROJECT_ID=my-project GITHUB_ORG=my-org GITHUB_REPO=my-repo \
#   DATABASE_URL=postgres://... ./scripts/gcp-setup.sh

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
GITHUB_ORG="${GITHUB_ORG:?Set GITHUB_ORG}"
GITHUB_REPO="${GITHUB_REPO:?Set GITHUB_REPO}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  pubsub.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  secretmanager.googleapis.com

echo "==> Artifact Registry repository"
gcloud artifacts repositories describe microservices --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create microservices \
       --repository-format=docker \
       --location="$REGION" \
       --description="Microservices container images"

echo "==> Service accounts"
create_sa() {
  gcloud iam service-accounts describe "$1@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$1" --display-name="$2"
}
create_sa github-deployer "GitHub Actions Deployer"
create_sa api-runtime "API Service Runtime"
create_sa fulfillment-runtime "Fulfillment Service Runtime"
create_sa analytics-runtime "Analytics Service Runtime"

echo "==> IAM bindings"
bind() {
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="$1" --role="$2" >/dev/null
}

# GitHub Actions deployer
bind "serviceAccount:github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" "roles/run.admin"
bind "serviceAccount:github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" "roles/iam.serviceAccountUser"
bind "serviceAccount:github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" "roles/artifactregistry.writer"
bind "serviceAccount:github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" "roles/secretmanager.secretAccessor"
bind "serviceAccount:github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" "roles/pubsub.editor"

# Runtime service accounts
bind "serviceAccount:api-runtime@${PROJECT_ID}.iam.gserviceaccount.com" "roles/pubsub.publisher"
bind "serviceAccount:api-runtime@${PROJECT_ID}.iam.gserviceaccount.com" "roles/secretmanager.secretAccessor"
bind "serviceAccount:fulfillment-runtime@${PROJECT_ID}.iam.gserviceaccount.com" "roles/secretmanager.secretAccessor"
bind "serviceAccount:analytics-runtime@${PROJECT_ID}.iam.gserviceaccount.com" "roles/secretmanager.secretAccessor"

for SA in fulfillment-runtime analytics-runtime; do
  bind "serviceAccount:${SA}@${PROJECT_ID}.iam.gserviceaccount.com" "roles/pubsub.publisher"
  bind "serviceAccount:${SA}@${PROJECT_ID}.iam.gserviceaccount.com" "roles/pubsub.subscriber"
done

echo "==> Workload Identity Federation (GitHub)"
gcloud iam workload-identity-pools describe github-pool --location=global >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create github-pool \
       --location="global" \
       --display-name="GitHub Actions Pool"

gcloud iam workload-identity-pools providers describe github-provider \
    --location=global --workload-identity-pool=github-pool >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools providers create-oidc github-provider \
       --location="global" \
       --workload-identity-pool="github-pool" \
       --display-name="GitHub Provider" \
       --issuer-uri="https://token.actions.githubusercontent.com" \
       --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
       --attribute-condition="assertion.repository_owner == '${GITHUB_ORG}'"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

gcloud iam service-accounts add-iam-policy-binding \
  "github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_ORG}/${GITHUB_REPO}" \
  >/dev/null

echo "==> Pub/Sub topics"
for TOPIC in order-events fulfillment-events analytics-events; do
  gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 \
    || gcloud pubsub topics create "$TOPIC"
done

# Push subscriptions are created after the services are deployed:
#   ./scripts/gcp-subscriptions.sh

echo "==> DATABASE_URL secret"
if [[ -n "${DATABASE_URL:-}" ]]; then
  printf '%s' "$DATABASE_URL" | gcloud secrets create DATABASE_URL --data-file=- >/dev/null 2>&1 \
    || printf '%s' "$DATABASE_URL" | gcloud secrets versions add DATABASE_URL --data-file=- >/dev/null
  echo "Secret DATABASE_URL updated"
else
  echo "DATABASE_URL env var not set - skipping (create the secret before deploying)"
  echo "  printf '%s' 'postgres://...' | gcloud secrets create DATABASE_URL --data-file=-"
fi

echo
echo "✓ GCP setup complete"
echo
echo "Add these to .github/workflows/deploy.yml env:"
echo "  PROJECT_ID: ${PROJECT_ID}"
echo "  REGION: ${REGION}"
echo "  PROJECT_NUMBER: ${PROJECT_NUMBER}"
echo
echo "Workload identity provider:"
echo "  projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
