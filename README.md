# Time-Off Microservice

A NestJS microservice that manages the full lifecycle of employee time-off requests while keeping local leave balances in sync with an external Human Capital Management (HCM) system. Employees submit requests through a REST API; the service validates the available balance locally (without waiting on the HCM), records the reservation atomically, then delivers the deduction to the HCM asynchronously via an outbox pattern. Managers approve or reject requests through the same API, and the system handles the downstream HCM confirmation without any further action from them.

Because the HCM changes balances independently — work anniversaries, year-start accruals, manual adjustments — the service maintains a local shadow of every employee's balance and keeps it current through three complementary sync paths: a bulk batch endpoint the HCM can push to at any time, a real-time webhook for immediate updates, and a scheduled reconciliation job that polls the HCM for records that have gone stale. When any of these paths detects a discrepancy (HCM total has fallen below locally committed days), the affected requests are flagged for human review.

---

## Prerequisites

- **Docker** 24+ (with Compose V2)
- **Node.js** 20+ and **npm** 10+ (for running tests locally without Docker)

---

## Setup

```bash
cp .env.example .env
```

The defaults in `.env.example` work for local development with Docker Compose.

---

## Run locally (Docker)

```bash
docker-compose up --build
```

This starts the mock HCM server on port 3001 and the time-off service on port 3000. The service waits for the mock HCM to be healthy before starting.

Verify the service is up:

```bash
curl http://localhost:3000/health
# {"status":"ok","dbConnected":true,"outboxQueueDepth":0}
```

Stop everything:

```bash
docker-compose down -v
```

---

## Unit tests

```bash
npm install
npm run test:cov
```

Coverage targets: `balance.service.ts` 100% branch, `request-state-machine.ts` 100% branch, `outbox.processor.ts` 90%+ statements, `sync.service.ts` 90%+ statements.

---

## E2E tests

The E2E tests are self-contained — they spin up an in-process NestJS application, an in-memory SQLite database, and an in-process mock HCM HTTP server. No running Docker services are needed.

```bash
npm install
npm run test:e2e
```

> The mock HCM server binds to port 3099 during tests. Make sure that port is free.

---

## Run everything in Docker

```bash
docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit
```

This builds all images, starts the mock HCM and the time-off service with health-checked readiness gates, then runs the full E2E suite in a third container. The process exits with a non-zero code if any test fails.

---

## API overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Health check (db status, outbox depth) |
| GET | `/balances/:employeeId` | employee | All balance rows for an employee |
| GET | `/balances/:employeeId/:locationId` | employee | Balances for a specific location |
| POST | `/requests` | employee | Submit a time-off request |
| GET | `/requests` | employee/manager | List requests (scoped by role) |
| PATCH | `/requests/:id/approve` | manager | Approve a pending request |
| PATCH | `/requests/:id/reject` | manager | Reject a pending request |
| PATCH | `/requests/:id/cancel` | employee | Cancel a request |
| POST | `/sync/batch` | admin | Ingest a batch of HCM balance records |
| POST | `/sync/webhook` | HCM secret | Receive a real-time balance update |
| POST | `/sync/trigger` | admin | Manually trigger scheduled reconciliation |
| GET | `/sync/status` | admin | Outbox depth, last sync timestamps |
| POST | `/outbox/:id/retry` | admin | Reset a FAILED outbox event to PENDING |

Auth is header-based: `x-employee-id` (number) and `x-role` (`employee` | `manager` | `admin`). Managers additionally pass `x-location-id` to scope their queries.

---

## Architecture decisions

The design is documented in full in `TRD.md`. Key choices in brief:

**Optimistic locking for balance reservation.** Each balance row carries a `version` counter. The `reserveBalance` call issues a conditional `UPDATE … WHERE version = ?` and retries up to three times on a version conflict before throwing `409 Conflict`. This prevents over-deduction under concurrent submissions without a database-level advisory lock.

**Per-employee serialization lock (in-process).** `better-sqlite3` exposes a single synchronous database connection through TypeORM's singleton QueryRunner. Concurrent async requests share that connection, making nested transactions via SAVEPOINTs unreliable under contention. A promise-chaining lock keyed by `employeeId` serializes submissions for the same employee in Node's event loop, allowing the optimistic locking layer to work correctly.

**Outbox pattern for HCM calls.** The intent to call the HCM is written to the `outbox_events` table inside the same database transaction that mutates the request or balance. A polling processor picks up pending events and delivers them, retrying with backoff up to `HCM_MAX_RETRIES` times. This guarantees at-least-once delivery without dual-write risk.

**Three-path sync.** Batch ingestion handles large periodic pushes from the HCM. The webhook endpoint handles real-time point updates (work anniversaries, manual adjustments). The scheduled reconciliation job handles the residual — records that neither path has touched in over 30 minutes and any employee with an active pending request. Together they close every gap without requiring the HCM to be reliable.

**SQLite WAL mode.** `PRAGMA journal_mode=WAL` is set immediately after the TypeORM connection opens. WAL allows concurrent readers and a single writer and is the standard production configuration for better-sqlite3.

---

## Known assumptions (from TRD.md §13)

| Open question | Decision made |
|---|---|
| Manager-to-employee mapping | Location-based scope: a manager sees all requests from employees sharing their `x-location-id` header. |
| Days calculation method | Calendar days. Weekends and public holidays are not excluded. If business-day counting is needed, a holiday calendar input must be added. |
| Leave type source | Leave types are unvalidated string identifiers. Any string is accepted; validation against a configured list is out of scope. |
| Webhook authentication in production | Shared-secret header (`x-hcm-secret`) for now. A production integration should use mutual TLS or an OAuth token grant via a pluggable auth strategy. |
