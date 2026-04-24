# Time-Off Microservice

A NestJS microservice that manages employee time-off requests and keeps leave balances in sync with an external HCM (Human Capital Management) system. Employees submit requests through a REST API, the service validates the balance locally without waiting on the HCM, reserves the days atomically, then delivers the deduction to the HCM asynchronously through an outbox pattern. Managers approve or reject through the same API, and the system handles downstream HCM confirmation on its own.

The HCM changes balances independently — work anniversaries, year-start accruals, manual adjustments — so the service maintains a local shadow of every employee's balance and keeps it current through three sync paths: batch ingestion, real-time webhooks, and scheduled reconciliation. When any path detects a discrepancy, the affected requests get flagged for human review rather than auto-resolved.

The full design rationale is in `TRD.md`.

---

## Prerequisites

- **Node.js** 20+ and **npm** 10+
- **Docker** 24+ with Compose V2 (only if you want to run via Docker)

---

## Quick start (without Docker)

If you just want to run the service and tests locally, you don't need Docker at all. The tests use an in-memory SQLite database and spin up their own mock HCM server — everything is self-contained.

```bash
# Install dependencies
npm install

# Run unit tests (95 tests)
npm run test

# Run unit tests with coverage report
npm run test:cov

# Run E2E tests (58 tests)
npm run test:e2e
```

That's it. No database setup, no external services, no Docker. The E2E tests start an in-process NestJS app, an in-memory SQLite database, and a mock HCM HTTP server on port 3099 automatically.

> Make sure port 3099 is free before running E2E tests. If something else is using it, the mock HCM server won't start and the tests will fail with an EADDRINUSE error.

---

## Running the service locally (without Docker)

If you want to actually run the service (not just the tests), you need the mock HCM server running separately:

```bash
# Copy the example env file
cp .env.example .env

# Build both apps
npm run build

# Start the mock HCM server (in one terminal)
npm run start:mock-hcm

# Start the time-off service (in another terminal)
npm run start
```

The mock HCM runs on port 3001 (`MOCK_HCM_PORT`) and the time-off service on port 3000 (`PORT`). Both are configured separately so there's no conflict. The service creates a SQLite database at `./data/timeoff.db` on first start.

Verify the service is running:

```bash
curl http://localhost:3000/health
```

You should get back something like:

```json
{"status":"ok","dbConnected":true,"outboxQueueDepth":0}
```

For development with auto-reload:

```bash
# Terminal 1
npm run start:mock-hcm:dev

# Terminal 2
npm run start:dev
```

---

## Running with Docker

```bash
# Copy env file (defaults work for Docker)
cp .env.example .env

# Build and start both services
docker compose up --build
```

This starts the mock HCM on port 3001 and the time-off service on port 3000. The service waits for the mock HCM health check to pass before starting.

To stop everything and clean up the volume:

```bash
docker compose down -v
```

---

## Running tests in Docker

There's a separate compose file that builds everything, starts the services, runs the full E2E suite, and exits with a non-zero code if anything fails:

```bash
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit
```

---

## Project structure

```
apps/
  timeoff-service/    ← The main microservice
    src/
      balance/        ← Leave balance shadow store and reservation logic
      request/        ← Request lifecycle, state machine, controller
      outbox/         ← Outbox table and polling processor
      sync/           ← Batch, webhook, and scheduled reconciliation
      hcm-client/     ← HTTP wrapper for HCM API calls
      employee/       ← Employee entity (thin CRUD)
      common/         ← Enums, guards, filters, interceptors
    test/             ← E2E test suites and helpers
  mock-hcm/           ← Standalone mock HCM server for testing
```

---

## API overview

All endpoints expect `x-employee-id` (number) and `x-role` (`employee`, `manager`, or `admin`) headers. Managers also pass `x-location-id` to scope their queries. There's no real auth — an upstream gateway is assumed to set these headers.

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | DB status and outbox queue depth |

### Balances

| Method | Path | Who can call | Description |
|--------|------|-------------|-------------|
| GET | `/balances/:employeeId` | employee, manager | All balance rows for an employee |
| GET | `/balances/:employeeId/:locationId` | employee, manager | Balances for one location |

### Requests

| Method | Path | Who can call | Description |
|--------|------|-------------|-------------|
| POST | `/requests` | employee | Submit a time-off request |
| GET | `/requests` | employee, manager | List requests (filtered by role) |
| GET | `/requests/team` | manager | Team requests within location scope |
| GET | `/requests/:id` | employee, manager | Get a single request |
| PATCH | `/requests/:id/approve` | manager | Approve a pending request |
| PATCH | `/requests/:id/reject` | manager | Reject a pending request (body: `{ reason }`) |
| DELETE | `/requests/:id` | employee, manager | Cancel a request |

### Sync

| Method | Path | Who can call | Description |
|--------|------|-------------|-------------|
| POST | `/sync/batch` | admin | Ingest batch of HCM balance records |
| POST | `/sync/webhook` | HCM (secret header) | Receive a real-time balance update |
| POST | `/sync/trigger` | admin | Manually trigger reconciliation |
| GET | `/sync/status` | admin | Last sync timestamps, outbox depth |

### Admin

| Method | Path | Who can call | Description |
|--------|------|-------------|-------------|
| POST | `/outbox/:id/retry` | admin | Reset a FAILED outbox event to PENDING |
| GET | `/outbox` | admin | List outbox events (filter by `?status=`) |

---

## Example: submitting a request

```bash
# Submit a time-off request
curl -X POST http://localhost:3000/requests \
  -H "Content-Type: application/json" \
  -H "x-employee-id: 1" \
  -H "x-role: employee" \
  -d '{
    "employeeId": 1,
    "locationId": "LOC1",
    "leaveType": "ANNUAL",
    "startDate": "2026-05-01",
    "endDate": "2026-05-03"
  }'

# Approve it as a manager
curl -X PATCH http://localhost:3000/requests/1/approve \
  -H "x-employee-id: 2" \
  -H "x-role: manager" \
  -H "x-location-id: LOC1"

# Check the request status
curl http://localhost:3000/requests/1 \
  -H "x-employee-id: 1" \
  -H "x-role: employee"
```

After approval, the request moves to `APPROVED_PENDING_HCM`. The outbox processor picks it up within a few seconds and calls the HCM. Once the HCM confirms, the status moves to `APPROVED` and the reserved days become used days.

---

## Environment variables

Copy `.env.example` and adjust as needed:

| Variable | What it does | Default |
|---|---|---|
| `DATABASE_PATH` | SQLite file location | `./data/timeoff.db` |
| `HCM_BASE_URL` | Where to reach the HCM | `http://localhost:3001` |
| `HCM_SECRET` | Shared secret for webhook auth | `dev-secret` |
| `OUTBOX_POLL_INTERVAL_MS` | How often the outbox processor ticks | `5000` |
| `RECONCILIATION_CRON` | Cron schedule for reconciliation | `*/15 * * * *` |
| `HCM_REQUEST_TIMEOUT_MS` | Timeout for HCM HTTP calls | `8000` |
| `HCM_MAX_RETRIES` | Max outbox retry attempts before FAILED | `4` |
| `HCM_ERROR_RATE` | Mock HCM random failure rate (0-1) | `0` |
| `PORT` | HTTP server port | `3000` |

Tests use `apps/timeoff-service/.env.test` which sets `DATABASE_PATH=:memory:` and points to the test mock HCM on port 3099.

---

## Key design decisions

These are explained in detail in `TRD.md`, but the short version:

- **Outbox pattern** over synchronous HCM calls — manager approvals return immediately, HCM communication happens in the background with retry and backoff.
- **Optimistic locking** on balance rows — a conditional `UPDATE ... WHERE version = ?` prevents double-deduction under concurrent submissions without heavyweight locks.
- **Per-employee serialization lock** — an in-process promise-chain keyed by employee ID prevents concurrent async handlers from interleaving on better-sqlite3's single connection.
- **Three-path sync** — batch, webhook, and scheduled reconciliation together cover every way the local shadow can fall out of sync with the HCM.
- **SQLite with WAL mode** — simple, no infrastructure, and durable enough for a single-instance service. If this ever needs to scale horizontally, swap to Postgres and add row-level locking.

---

## Test coverage

```
95 unit tests   — state machine, balance logic, outbox retry, sync processing
58 E2E tests    — full request lifecycle, concurrency, sync, outbox, edge cases
```

Run `npm run test:cov` for a detailed coverage report.
