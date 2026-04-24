import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAllTables1714000000000 implements MigrationInterface {
  name = 'CreateAllTables1714000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "employees" (
        "id"              INTEGER PRIMARY KEY AUTOINCREMENT,
        "hcm_employee_id" TEXT    NOT NULL UNIQUE,
        "name"            TEXT    NOT NULL,
        "location_id"     TEXT    NOT NULL,
        "created_at"      DATETIME DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "leave_balances" (
        "id"             INTEGER PRIMARY KEY AUTOINCREMENT,
        "employee_id"    INTEGER NOT NULL,
        "location_id"    TEXT    NOT NULL,
        "leave_type"     TEXT    NOT NULL,
        "total_days"     DECIMAL(5,1) NOT NULL DEFAULT 0,
        "used_days"      DECIMAL(5,1) NOT NULL DEFAULT 0,
        "reserved_days"  DECIMAL(5,1) NOT NULL DEFAULT 0,
        "last_synced_at" DATETIME,
        "hcm_version"    TEXT,
        "version"        INTEGER NOT NULL DEFAULT 0,
        UNIQUE ("employee_id", "location_id", "leave_type"),
        FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "time_off_requests" (
        "id"               INTEGER PRIMARY KEY AUTOINCREMENT,
        "employee_id"      INTEGER NOT NULL,
        "location_id"      TEXT    NOT NULL,
        "leave_type"       TEXT    NOT NULL,
        "start_date"       TEXT    NOT NULL,
        "end_date"         TEXT    NOT NULL,
        "days_requested"   DECIMAL(5,1) NOT NULL,
        "status"           TEXT    NOT NULL DEFAULT 'PENDING',
        "manager_id"       INTEGER,
        "rejection_reason" TEXT,
        "hcm_request_id"   TEXT,
        "version"          INTEGER NOT NULL DEFAULT 0,
        "created_at"       DATETIME DEFAULT (datetime('now')),
        "updated_at"       DATETIME DEFAULT (datetime('now')),
        FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outbox_events" (
        "id"            INTEGER PRIMARY KEY AUTOINCREMENT,
        "event_type"    TEXT    NOT NULL,
        "payload"       TEXT    NOT NULL,
        "status"        TEXT    NOT NULL DEFAULT 'PENDING',
        "attempts"      INTEGER NOT NULL DEFAULT 0,
        "next_retry_at" DATETIME,
        "request_id"    INTEGER NOT NULL,
        "created_at"    DATETIME DEFAULT (datetime('now')),
        FOREIGN KEY ("request_id") REFERENCES "time_off_requests"("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sync_log" (
        "id"                INTEGER PRIMARY KEY AUTOINCREMENT,
        "sync_type"         TEXT    NOT NULL,
        "triggered_by"      TEXT    NOT NULL,
        "status"            TEXT    NOT NULL DEFAULT 'STARTED',
        "records_processed" INTEGER NOT NULL DEFAULT 0,
        "discrepancies"     INTEGER NOT NULL DEFAULT 0,
        "error_detail"      TEXT,
        "started_at"        DATETIME NOT NULL,
        "completed_at"      DATETIME
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "sync_log"');
    await queryRunner.query('DROP TABLE IF EXISTS "outbox_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "time_off_requests"');
    await queryRunner.query('DROP TABLE IF EXISTS "leave_balances"');
    await queryRunner.query('DROP TABLE IF EXISTS "employees"');
  }
}
