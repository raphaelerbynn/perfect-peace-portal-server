// Top-up sync helpers (src/utils/dataSync.js). The end-to-end behaviour is
// rehearsed on real databases by scripts/rehearse-sync.sh.
import {
  NEW_ROW_TABLES,
  newRowsSql,
  NO_MIRROR_DELETE_TABLES,
  REPLACEABLE_DUPLICATE_TABLES,
  activityProblems,
  clashSql,
  dedupeSqls,
  identityClashSql,
  insertSql,
  keyMatchSql,
  NEW_SYSTEM_ACTIVITY,
  resolvePassword,
  skipRemovedSql,
  uniqueKeysFor,
  updateSql,
} from "../utils/dataSync.js";

describe("unique-key matching", () => {
  it("compares every column, lower-casing lower(name) keys", () => {
    expect(keyMatchSql(["student_id", "term_id"], "c", "t")).toBe('c."student_id" = t."student_id" AND c."term_id" = t."term_id"');
    expect(keyMatchSql(["lower(name)"], "a", "b")).toBe('lower(a."name") = lower(b."name")');
  });

  it("uses the same keys as migration 001", () => {
    expect(uniqueKeysFor("Attendance").map((k) => k.index)).toEqual(["uniq_attendance"]);
    expect(uniqueKeysFor("Fee")).toEqual([]);
  });

  it("keeps the most recent save (highest id) and logs what it removes", () => {
    const [among, replaceExisting, liveLoses] = dedupeSqls('"dbo"."Attendance"', "attendance_id", ["student_id", "date_marked", "term_id"]);
    expect(among.sql).toContain('d."attendance_id" > c."attendance_id"');
    expect(replaceExisting.sql).toContain('DELETE FROM "dbo"."Attendance" t USING "_sync_cand" c');
    expect(replaceExisting.sql).toContain('c."attendance_id" > t."attendance_id"');
    expect(liveLoses.sql).toContain('t."attendance_id" > c."attendance_id"');
    for (const d of [among, replaceExisting, liveLoses]) expect(d.sql).toContain('INSERT INTO "dbo"."_removed_duplicates"');
  });
});

describe("which duplicates the sync may resolve itself", () => {
  it("replaces only rows nothing points at; a clashing subject is listed instead", () => {
    expect(REPLACEABLE_DUPLICATE_TABLES.has("Attendance")).toBe(true);
    expect(REPLACEABLE_DUPLICATE_TABLES.has("Subject")).toBe(false);
    expect(clashSql('"dbo"."Subject"', "subject_id", ["lower(name)"])).toContain('lower(c."name") = lower(t."name")');
  });

  it("never mirror-deletes terms or payments", () => {
    expect([...NO_MIRROR_DELETE_TABLES].sort()).toEqual(["Fee", "Term"]);
  });
});

describe("row SQL", () => {
  it("updates only rows that differ, never the id", () => {
    const sql = updateSql('"dbo"."Parent"', "parent_id", ["contact", "f_name"]);
    expect(sql).toContain('SET "contact" = l."contact", "f_name" = l."f_name"');
    expect(sql).toContain('t."contact" IS DISTINCT FROM l."contact" OR t."f_name" IS DISTINCT FROM l."f_name"');
    expect(sql).not.toContain('"parent_id" = l."parent_id",');
    expect(updateSql('"dbo"."FeeCheck"', "id", [])).toBeNull();
  });

  it("never brings back ids the duplicate clean-up removed", () => {
    expect(skipRemovedSql('"dbo"."Attendance"', "attendance_id")).toContain(`row_data->>'attendance_id'`);
  });

  it("inserts payments in date order so receipts follow migration 023", () => {
    expect(insertSql('"dbo"."Fee"', "fee_id", ["fee_id", "date_paid"], "Fee")).toContain('ORDER BY "date_paid" NULLS FIRST, "fee_id"');
    expect(insertSql('"dbo"."Term"', "term_id", ["term_id"], "Term")).toContain('ORDER BY "term_id"');
  });

  it("flags an id reused for a different record only when every identity column differs", () => {
    const sql = identityClashSql('"dbo"."Student"', "student_id", ["f_name", "l_name"]);
    expect(sql.match(/IS DISTINCT FROM/g)).toHaveLength(2);
    expect(sql).toContain(" AND ");
  });
});

describe("new-system activity guard", () => {
  it("lists only what has rows", () => {
    const counts = NEW_SYSTEM_ACTIVITY.map(() => 0);
    expect(activityProblems(counts)).toEqual([]);
    counts[0] = 3;
    expect(activityProblems(counts)).toEqual([{ what: "payments recorded or reversed in the new system", rows: 3 }]);
  });
});

describe("passwords", () => {
  const compare = jest.fn(async (plain, hash) => hash === `$2b$10$hash-of-${plain}`);

  it("keeps the existing hash when the live password is unchanged", async () => {
    expect(await resolvePassword("stud123", "$2b$10$hash-of-stud123", compare)).toBe("$2b$10$hash-of-stud123");
  });

  it("passes a changed or new password on to be hashed", async () => {
    expect(await resolvePassword("newpass", "$2b$10$hash-of-stud123", compare)).toBe("newpass");
    expect(await resolvePassword("kid60", undefined, compare)).toBe("kid60");
  });

  it("leaves empty values and live hashes alone", async () => {
    expect(await resolvePassword(null, "$2b$10$x", compare)).toBeNull();
    expect(await resolvePassword("$2b$10$already", "$2b$10$x", compare)).toBe("$2b$10$already");
  });
});

describe("rows not copied from live", () => {
  it("covers payments, registers, marks, results, salaries and fee items, above the recorded live max", () => {
    expect([...NEW_ROW_TABLES].sort()).toEqual(["Attendance", "ClassFee", "Fee", "KG_assessment", "Salary_payment", "StudentFee", "Student_marks", "Student_result", "Total_attendance"]);
    expect(newRowsSql('"dbo"."Fee"', "fee_id")).toContain('t."fee_id" > :threshold');
  });
});
