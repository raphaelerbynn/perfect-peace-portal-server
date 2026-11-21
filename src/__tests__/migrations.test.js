// Phase 0.4.3: plain-SQL migration runner helpers.
import fs from "fs";
import os from "os";
import path from "path";
import { checksum, planMigrations, readMigrationFiles } from "../utils/migrations.js";

const tmpDir = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-migrations-"));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
};

describe("readMigrationFiles", () => {
  it("a missing folder is an error, not 'nothing to do' (e.g. db/ left out of the image)", () => {
    expect(() => readMigrationFiles("/no/such/dir")).toThrow(/Migrations folder not found/);
  });

  it("sorts by number, not by string (2 before 10) and ignores non-sql files", () => {
    const dir = tmpDir({
      "010_c.sql": "SELECT 3;",
      "002_b.sql": "SELECT 2;",
      "001_a.sql": "SELECT 1;",
      "README.md": "# notes",
    });
    expect(readMigrationFiles(dir).map((f) => f.name)).toEqual(["001_a.sql", "002_b.sql", "010_c.sql"]);
  });

  it("rejects badly named files", () => {
    const dir = tmpDir({ "add-column.sql": "SELECT 1;" });
    expect(() => readMigrationFiles(dir)).toThrow(/Badly named/);
  });

  it("rejects two files with the same number", () => {
    const dir = tmpDir({ "003_a.sql": "SELECT 1;", "003_b.sql": "SELECT 2;" });
    expect(() => readMigrationFiles(dir)).toThrow(/Duplicate migration number 003/);
  });
});

describe("checksum", () => {
  it("ignores Windows vs Unix line endings", () => {
    expect(checksum("A;\r\nB;")).toBe(checksum("A;\nB;"));
  });
  it("changes when the SQL changes", () => {
    expect(checksum("A;")).not.toBe(checksum("B;"));
  });
});

describe("planMigrations", () => {
  const files = [
    { name: "001_a.sql", checksum: checksum("SELECT 1;") },
    { name: "002_b.sql", checksum: checksum("SELECT 2;") },
  ];

  it("returns only files that have not been applied", () => {
    const pending = planMigrations(files, [{ name: "001_a.sql", checksum: files[0].checksum }]);
    expect(pending.map((f) => f.name)).toEqual(["002_b.sql"]);
  });

  it("refuses when an applied file was edited", () => {
    expect(() => planMigrations(files, [{ name: "001_a.sql", checksum: checksum("edited") }])).toThrow(
      /edited after it was applied/
    );
  });

  it("refuses when an applied file was deleted", () => {
    expect(() => planMigrations(files, [{ name: "000_gone.sql", checksum: "x" }])).toThrow(/file is missing/);
  });
});

describe("db/migrations folder", () => {
  it("every committed migration is valid and loads", () => {
    const files = readMigrationFiles(path.resolve(__dirname, "../../db/migrations"));
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].name).toBe("001_baseline_unique_indexes.sql");
  });
});

describe("planMigrations: out-of-order files (review fix)", () => {
  const { planMigrations } = require("../utils/migrations.js");
  const f = (name) => ({ name, sql: "", checksum: name });
  it("refuses a new file numbered below the latest applied one", () => {
    const applied = [{ name: "001_a.sql", checksum: "001_a.sql" }, { name: "003_c.sql", checksum: "003_c.sql" }];
    expect(() => planMigrations([f("001_a.sql"), f("002_b.sql"), f("003_c.sql")], applied)).toThrow(
      "Migration 002_b.sql is numbered below one already applied (003_c.sql)"
    );
  });
  it("new files after the latest are fine", () => {
    const applied = [{ name: "001_a.sql", checksum: "001_a.sql" }];
    expect(planMigrations([f("001_a.sql"), f("002_b.sql")], applied).map((m) => m.name)).toEqual(["002_b.sql"]);
  });
});
