#!/usr/bin/env bash
set -euo pipefail

# Creates/updates the Pub/Sub push subscriptions that feed the
# fulfillment and analytics Cloud Run services, and grants Pub/Sub
# permission to invoke them. Run after the services are deployed
# (the GitHub Actions workflow runs this automatically).

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
FULFILLMENT_URL="$(gcloud run services describe fulfillment-service --region="$REGION" --format='value(status.url)')"
ANALYTICS_URL="$(gcloud run services describe analytics-service --region="$REGION" --format='value(status.url)')"

echo "Fulfillment: ${FULFILLMENT_URL}"
echo "Analytics:   ${ANALYTICS_URL}"

ensure_push_subscription() {
  local sub=$1 topic=$2 endpoint=$3 auth_sa=$4
  if gcloud pubsub subscriptions describe "$sub" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud pubsub subscriptions update "$sub" \
      --push-endpoint="$endpoint" \
      --push-auth-service-account="$auth_sa" \
      --ack-deadline=30 \
      --project="$PROJECT_ID" >/dev/null
    echo "Subscription $sub updated -> $endpoint"
  else
    gcloud pubsub subscriptions create "$sub" \
      --topic="$topic" \
      --push-endpoint="$endpoint" \
      --push-auth-service-account="$auth_sa" \
      --ack-deadline=30 \
      --project="$PROJECT_ID" >/dev/null
    echo "Subscription $sub created -> $endpoint"
  fi
}

ensure_push_subscription fulfillment-sub order-events "${FULFILLMENT_URL}/" \
  "fulfillment-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
ensure_push_subscription analytics-sub analytics-events "${ANALYTICS_URL}/" \
  "analytics-runtime@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Granting Pub/Sub permission to invoke Cloud Run services..."
grant_invoker() {
  local service=$1 member=$2
  gcloud run services add-iam-policy-binding "$service" \
    --region="$REGION" \
    --member="$member" \
    --role="roles/run.invoker" \
    --project="$PROJECT_ID" >/dev/null
}

# Pub/Sub push service agent (used when no OIDC token is requested)
grant_invoker fulfillment-service "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"
grant_invoker analytics-service "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

# Runtime SAs identified in the push subscription's OIDC token
grant_invoker fulfillment-service "serviceAccount:fulfillment-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
grant_invoker analytics-service "serviceAccount:analytics-runtime@${PROJECT_ID}.iam.gserviceaccount.com"

echo "✓ Pub/Sub push subscriptions configured"
