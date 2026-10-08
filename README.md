# Event Ticketing Microservices Platform

An event-driven microservices ticket ordering system: customers place orders for
event tickets (movie/game/concert/sports) through a REST API or web dashboard,
and orders flow through **Google Cloud Pub/Sub** to a fulfillment worker and an
analytics service backed by **Postgres**.

## Architecture

```
                    ┌──────────────────┐
                    │  Dashboard       │  frontend/index.html
                    │  (polls /stats)  │
                    └───────┬──────────┘
                            │ HTTP
                            ▼
                  ┌───────────────────┐        ┌─────────────────┐
                  │  Order API :3000  │───────▶│  order-events   │
                  │  services/api     │ publish│  Pub/Sub topic  │
                  └─────────┬─────────┘        └────────┬────────┘
                            │ INSERT (pending)          │ push
                            ▼                           ▼
                  ┌───────────────────┐        ┌───────────────────┐
                  │    Postgres       │◀───────│ Fulfillment       │
                  │  (Neon in cloud)  │        │ services/         │
                  └─────────┬─────────┘        │ fulfillment :8081 │
                            │ SELECT           └────────┬──────────┘
                            ▼                           │ publish
                  ┌───────────────────┐        ┌────────▼─────────┐
                  │ Analytics API     │◀───────│ analytics-events │
                  │ services/         │ push   │  Pub/Sub topic   │
                  │ analytics :4000   │        └──────────────────┘
                  └───────────────────┘
```

Message flow: `POST /order` → API inserts a `pending` row and publishes to
`order-events` → Pub/Sub push-delivers to the fulfillment service, which
simulates processing (2–4s) and publishes to `analytics-events` → Pub/Sub
push-delivers to analytics, which marks the order `fulfilled` → the dashboard
polls `GET /stats`, which aggregates straight from Postgres.

## Tech Stack

- **Runtime**: Node.js 20+, Fastify 5 (ES modules)
- **Messaging**: Google Cloud Pub/Sub (push subscriptions), Pub/Sub emulator locally
- **Database**: Postgres 16 (Neon in cloud, Docker container locally)
- **Deployment**: Google Cloud Run + Artifact Registry, GitHub Actions (Workload Identity Federation)
- **Frontend**: vanilla HTML/CSS/JS, no build step

## Project structure

```
├── docker-compose.yml        # Local stack: emulator + Postgres + services
├── frontend/index.html       # Dashboard (single file)
├── services/
│   ├── api/                  # Order REST API (port 3000)
│   ├── fulfillment/          # Pub/Sub push consumer (port 8081 locally)
│   └── analytics/            # Stats API + push consumer (port 4000)
├── shared/
│   ├── common/               # Event types, prices, push-body decoder
│   ├── pubsub/               # Pub/Sub client + publish helper
│   └── db/                   # Postgres pool + schema init
├── scripts/
│   ├── gcp-setup.sh          # One-time GCP infrastructure setup
│   └── gcp-subscriptions.sh  # Push subscriptions (runs in CI after deploy)
└── .github/workflows/deploy.yml
```

## Local development

Prerequisites: Docker Desktop (with Compose), nothing else.

```bash
docker compose up --build
```

This starts:

| Service    | URL                              |
| ---------- | -------------------------------- |
| API        | http://localhost:3000            |
| Analytics  | http://localhost:4000            |
| Fulfillment| http://localhost:8081 (health)   |
| Postgres   | localhost:5432 (postgres/password, db `tickets`) |
| Pub/Sub emulator | localhost:8085               |

The services wait for the emulator/Postgres to be healthy, then
idempotently create the topics (`order-events`, `fulfillment-events`,
`analytics-events`) and — because `PUSH_ENDPOINT` is set locally — the push
subscriptions (`fulfillment-sub`, `analytics-sub`). In the cloud the
subscriptions are managed by `scripts/gcp-subscriptions.sh` instead (the
services skip subscription setup when `PUSH_ENDPOINT` is unset).

Open `frontend/index.html` in a browser (or `npx serve frontend`) — on
localhost it talks to `localhost:3000` / `localhost:4000` automatically.

### Test with curl

```bash
# Create an order
curl -X POST http://localhost:3000/order \
  -H "Content-Type: application/json" \
  -d '{"event":"concert","customer":"Test","quantity":2}'

# List orders
curl http://localhost:3000/orders

# Watch it move through the pipeline
curl http://localhost:4000/stats
```

Orders start as `pending` and become `fulfilled` a few seconds later.

### Running services outside Docker

```bash
npm install          # installs all workspaces (root package.json)
# You still need Postgres + the Pub/Sub emulator reachable;
# point env vars at them (see below), then:
npm run dev:api
npm run dev:fulfillment
npm run dev:analytics
```

### Environment variables

| Variable | Used by | Description |
| -------- | ------- | ----------- |
| `PORT` | all | HTTP port (Cloud Run sets this; defaults: api 3000, fulfillment 3000, analytics 4000) |
| `PROJECT_ID` | api, fulfillment | GCP project for Pub/Sub (`local-dev` locally) |
| `PUBSUB_EMULATOR_HOST` | api, fulfillment, analytics | e.g. `pubsub:8085` locally; unset in cloud (uses ADC) |
| `PUSH_ENDPOINT` | fulfillment, analytics | Local push subscription endpoint (e.g. `http://fulfillment:8081`); unset in cloud |
| `DATABASE_URL` | api, analytics | Postgres connection string; must contain `sslmode=require` for Neon |

## Google Cloud deployment

### 1. One-time infrastructure setup

Requires `gcloud` authenticated with a project owner/service-account admin.

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export GITHUB_ORG="your-github-username-or-org"
export GITHUB_REPO="your-repo-name"
# Neon connection string, stored in Secret Manager for Cloud Run:
export DATABASE_URL="postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require"

./scripts/gcp-setup.sh
```

This enables the required APIs, creates the Artifact Registry repository,
service accounts (`github-deployer`, `api-runtime`, `fulfillment-runtime`,
`analytics-runtime`), the Workload Identity Federation pool/provider for GitHub
Actions, the Pub/Sub topics, and the `DATABASE_URL` secret.

The script prints the `PROJECT_NUMBER` and provider resource name — copy them
into `.github/workflows/deploy.yml` (`env.PROJECT_ID`, `env.PROJECT_NUMBER`).

### 2. Deploy via GitHub Actions

Push to `main` (or run the workflow manually). Each push:

1. Authenticates to GCP via Workload Identity Federation (no JSON keys)
2. Builds the three service images and pushes them to Artifact Registry
3. Deploys `api-service`, `fulfillment-service`, `analytics-service` to Cloud Run
4. Runs `scripts/gcp-subscriptions.sh`, which creates/updates the Pub/Sub push
   subscriptions pointing at the deployed URLs and grants Pub/Sub (and the
   runtime service accounts) `roles/run.invoker`

### 3. Point the frontend at production

After the first deploy, update the production URLs in
`frontend/index.html` (search for `TODO: update the production URLs`), or pass
`?api=...&analytics=...` query params. Deploy the frontend with
`vercel --prod` or any static host.

### Notes

- `api-service` and `analytics-service` are `--allow-unauthenticated` (the
  dashboard calls them). `fulfillment-service` is private — only the Pub/Sub
  push subscription (with an OIDC token) can invoke it.
- Fulfillment processing (≤4s) happens inside the push request, so keep the
  subscription ack deadline at 30s (set by `gcp-subscriptions.sh`).
- Scaling: Cloud Run scales each service independently and to zero; all state
  lives in Postgres, so this is safe.

## API reference

### Order service (`:3000`)

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/order` | Place an order `{event, customer, quantity}` (quantity 1–10) |
| GET | `/orders` | Last 50 orders + total count |
| GET | `/orders/:id` | Single order |
| GET | `/orders/customer/:name` | Orders for a customer (case-insensitive) |
| GET | `/events` | Valid event types, descriptions, prices |
| GET | `/health` | Health check |

### Analytics service (`:4000`)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/stats` | Summary, per-event breakdown, recent orders |
| GET | `/events/:eventType` | Stats for one event type |
| GET | `/health` | Health check |

### Fulfillment service

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/` | Pub/Sub push endpoint (do not call directly) |
| GET | `/health` | Health check |
| GET | `/ping` | Keep-alive ping |

## Ticket prices

| Event | Price |
| ----- | ----- |
| movie | $15 |
| game  | $50 |
| concert | $75 |
| sports | $60 |
