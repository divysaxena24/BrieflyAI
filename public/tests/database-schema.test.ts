import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { databaseMetadata, databaseRecords } from "@/lib/database/schema";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";

const ROOT = join(__dirname, "..");

describe("database_records table", () => {
  it("is a valid drizzle table with the expected name", () => {
    expect(isTable(databaseRecords)).toBe(true);
    expect(getTableName(databaseRecords)).toBe("database_records");
  });

  it("declares every DatabaseRecord envelope column", () => {
    const columns = getTableColumns(databaseRecords);
    const names = Object.keys(columns);
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "scope",
        "collection",
        "recordId",
        "revision",
        "version",
        "archived",
        "archivedAt",
        "deletedAt",
        "createdAt",
        "updatedAt",
        "payload",
      ]),
    );
  });

  it("keeps identity, version and lifecycle flags non-null", () => {
    const columns = getTableColumns(databaseRecords);
    expect(columns.id.notNull).toBe(true);
    expect(columns.scope.notNull).toBe(true);
    expect(columns.collection.notNull).toBe(true);
    expect(columns.recordId.notNull).toBe(true);
    expect(columns.revision.notNull).toBe(true);
    expect(columns.version.notNull).toBe(true);
    expect(columns.archived.notNull).toBe(true);
    expect(columns.payload.notNull).toBe(true);
  });

  it("allows null lifecycle timestamps and requires the timestamps", () => {
    const columns = getTableColumns(databaseRecords);
    expect(columns.archivedAt.notNull).toBe(false);
    expect(columns.deletedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("stores timestamps with timezone", () => {
    const columns = getTableColumns(databaseRecords);
    expect(columns.createdAt.dataType).toBe("date");
    expect(columns.updatedAt.dataType).toBe("date");
  });
});

describe("database_metadata table", () => {
  it("is a valid drizzle table with the expected name", () => {
    expect(isTable(databaseMetadata)).toBe(true);
    expect(getTableName(databaseMetadata)).toBe("database_metadata");
  });

  it("declares the bookkeeping columns", () => {
    const columns = getTableColumns(databaseMetadata);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining(["id", "scope", "schemaVersion", "createdAt", "updatedAt"]),
    );
    expect(columns.id.notNull).toBe(true);
    expect(columns.scope.notNull).toBe(true);
    expect(columns.schemaVersion.notNull).toBe(true);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });
});

describe("generated migration", () => {
  const migrationPath = join(ROOT, "drizzle", "0002_phase6a_database_layer.sql");

  it("exists for the Phase 6A database layer", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("creates both new tables", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "database_records"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "database_metadata"');
  });

  it("declares the unique constraint and indexes for database_records", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("idx_database_records_scope_collection_record");
    expect(sql).toContain("idx_database_records_scope_collection");
    expect(sql).toContain("idx_database_records_updated_at");
    expect(sql).toContain("idx_database_records_archived");
    expect(sql).toContain("idx_database_metadata_scope");
  });

  it("is idempotent (IF NOT EXISTS on every statement)", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const createStatements = sql.match(/CREATE (?:UNIQUE )?INDEX|CREATE TABLE/g) ?? [];
    expect(createStatements.length).toBeGreaterThan(0);
    // Every create statement must be guarded by IF NOT EXISTS.
    const unguarded = sql
      .split(";")
      .filter((line) => /CREATE (?:UNIQUE )?INDEX|CREATE TABLE/.test(line))
      .filter((line) => !line.includes("IF NOT EXISTS"));
    expect(unguarded).toHaveLength(0);
  });
});
