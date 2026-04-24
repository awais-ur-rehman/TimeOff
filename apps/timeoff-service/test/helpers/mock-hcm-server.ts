import * as http from 'http';

interface BalanceRecord {
  employeeId?: number;
  locationId?: string;
  leaveType?: string;
  totalDays: number;
  hcmVersion: string;
}

interface DeductionRecord {
  employeeId: number;
  locationId: string;
  leaveType: string;
  days: number;
  hcmRequestId: string;
}

/**
 * Minimal in-process mock HCM HTTP server for E2E tests.
 * Handles just enough endpoints to exercise the lifecycle tests without
 * needing the full apps/mock-hcm NestJS application.
 */
export class MockHcmServer {
  private server: http.Server;
  readonly balances = new Map<string, BalanceRecord>();
  readonly deductions = new Map<string, DeductionRecord>(); // idempotencyKey → record
  private hcmRequests = new Map<string, string>();          // hcmRequestId → idempotencyKey
  private errorRate = 0;
  private requestCounter = 0;

  start(port: number): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed: unknown = body ? JSON.parse(body) : {};
        this.route(req, res, parsed as Record<string, unknown>);
      });
    });
    return new Promise((resolve, reject) => {
      this.server.listen(port, () => resolve());
      this.server.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  resetState(): void {
    this.balances.clear();
    this.deductions.clear();
    this.hcmRequests.clear();
    this.errorRate = 0;
    this.requestCounter = 0;
  }

  setErrorRate(rate: number): void {
    this.errorRate = rate;
  }

  simulateAnniversary(employeeId: string, bonusDays: number): void {
    for (const [key, val] of this.balances.entries()) {
      if (key.startsWith(`${employeeId}:`)) {
        this.balances.set(key, {
          ...val,
          totalDays: val.totalDays + bonusDays,
          hcmVersion: String((Number(val.hcmVersion) || 1) + 1),
        });
      }
    }
  }

  seedBalance(
    employeeId: number,
    locationId: string,
    leaveType: string,
    totalDays: number,
    hcmVersion = '1',
  ): void {
    const key = `${employeeId}:${locationId}:${leaveType}`;
    this.balances.set(key, { employeeId, locationId, leaveType, totalDays, hcmVersion });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }

  private route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown>,
  ): void {
    const { method, url } = req;

    // POST /hcm/requests — deduct days
    if (method === 'POST' && url === '/hcm/requests') {
      if (Math.random() < this.errorRate) {
        return this.json(res, 500, { error: 'Simulated HCM error' });
      }
      const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
      if (idempotencyKey && this.deductions.has(idempotencyKey)) {
        const existing = this.deductions.get(idempotencyKey)!;
        return this.json(res, 200, { hcmRequestId: existing.hcmRequestId });
      }
      this.requestCounter += 1;
      const hcmRequestId = `hcm-${this.requestCounter}-${Date.now()}`;
      const record: DeductionRecord = {
        employeeId: body.employeeId as number,
        locationId: body.locationId as string,
        leaveType: body.leaveType as string,
        days: body.days as number,
        hcmRequestId,
      };
      if (idempotencyKey) this.deductions.set(idempotencyKey, record);
      this.hcmRequests.set(hcmRequestId, idempotencyKey ?? hcmRequestId);
      return this.json(res, 201, { hcmRequestId });
    }

    // DELETE /hcm/requests/:id — reverse deduction
    if (method === 'DELETE' && url?.startsWith('/hcm/requests/')) {
      const id = url.split('/')[3];
      if (!this.hcmRequests.has(id)) {
        this.json(res, 404, { error: 'Not found' });
        return;
      }
      const idemKey = this.hcmRequests.get(id)!;
      this.deductions.delete(idemKey);
      this.hcmRequests.delete(id);
      res.writeHead(204);
      res.end();
      return;
    }

    // DELETE /hcm/state — reset everything
    if (method === 'DELETE' && url === '/hcm/state') {
      this.resetState();
      res.writeHead(204);
      res.end();
      return;
    }

    // POST /hcm/balances/seed — seed a balance record for test setup
    if (method === 'POST' && url === '/hcm/balances/seed') {
      const key = `${body.employeeId}:${body.locationId}:${body.leaveType}`;
      this.balances.set(key, {
        totalDays: body.totalDays as number,
        hcmVersion: '1',
      });
      return this.json(res, 201, { ok: true });
    }

    // POST /hcm/simulate/error-rate — set error injection rate
    if (method === 'POST' && url === '/hcm/simulate/error-rate') {
      this.errorRate = (body.rate as number) ?? 0;
      return this.json(res, 200, { ok: true });
    }

    // POST /hcm/simulate/anniversary/:employeeId — bonus days
    if (method === 'POST' && url?.startsWith('/hcm/simulate/anniversary/')) {
      const employeeId = url.split('/')[4];
      const bonusDays = body.bonusDays as number;
      for (const [key, val] of this.balances.entries()) {
        if (key.startsWith(`${employeeId}:`)) {
          this.balances.set(key, { ...val, totalDays: val.totalDays + bonusDays });
        }
      }
      return this.json(res, 200, { ok: true });
    }

    // GET /hcm/balances/:employeeId/:locationId/:leaveType
    if (method === 'GET' && url?.startsWith('/hcm/balances/')) {
      const parts = url.split('/');
      const key = `${parts[3]}:${parts[4]}:${parts[5]}`;
      const balance = this.balances.get(key);
      if (!balance) return this.json(res, 404, { error: 'Not found' });
      return this.json(res, 200, balance);
    }

    // GET /hcm/requests/:id — for idempotency inspection
    if (method === 'GET' && url?.startsWith('/hcm/requests/')) {
      const id = url.split('/')[3];
      const idemKey = this.hcmRequests.get(id);
      if (!idemKey) return this.json(res, 404, { error: 'Not found' });
      return this.json(res, 200, { hcmRequestId: id });
    }

    return this.json(res, 404, { error: 'Unknown route' });
  }
}

// Module-level singleton — shared across all describe blocks within a test file
let _server: MockHcmServer | null = null;
let _refCount = 0;

export async function acquireMockHcm(port = 3099): Promise<MockHcmServer> {
  if (!_server) {
    _server = new MockHcmServer();
    await _server.start(port);
  }
  _refCount += 1;
  return _server;
}

export async function releaseMockHcm(): Promise<void> {
  _refCount -= 1;
  if (_refCount <= 0 && _server) {
    await _server.stop();
    _server = null;
    _refCount = 0;
  }
}
