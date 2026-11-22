// Phase 0.4.4: MySQL -> Postgres data-move transforms.
import { DataTypes } from "sequelize";
import {
  buildColumnMap,
  coerceValue,
  duplicateSql,
  findSourceTable,
  isBcryptHash,
  loadOrder,
  transformRows,
  UNIQUE_KEYS,
} from "../utils/dataMove.js";

const attr = (field, type, extra = {}) => ({ field, fieldName: field, type, ...extra });

describe("coerceValue", () => {
  const bool = attr("active", DataTypes.BOOLEAN);
  it.each([
    [1, true], [0, false], ["1", true], ["0", false], [Buffer.from([1]), true], [Buffer.from([0]), false], [true, true],
  ])("boolean %p -> %p", (input, expected) => {
    expect(coerceValue(input, bool)).toBe(expected);
  });

  it("throws on a value that is not a boolean", () => {
    expect(() => coerceValue("maybe", bool)).toThrow(/boolean/);
  });

  it("turns MySQL zero dates into NULL", () => {
    expect(coerceValue("0000-00-00", attr("d", DataTypes.DATEONLY))).toBeNull();
    expect(coerceValue("0000-00-00 00:00:00", attr("d", DataTypes.DATE))).toBeNull();
  });

  it("keeps date strings as-is (no timezone shift) and trims DATEONLY", () => {
    expect(coerceValue("2026-01-06", attr("d", DataTypes.DATEONLY))).toBe("2026-01-06");
    expect(coerceValue("2026-01-06 00:00:00", attr("d", DataTypes.DATEONLY))).toBe("2026-01-06");
  });

  it("passes decimals through as strings", () => {
    expect(coerceValue("350.50", attr("amount", DataTypes.DECIMAL))).toBe("350.50");
  });

  it("keeps NULL as NULL", () => {
    expect(coerceValue(null, bool)).toBeNull();
  });
});

describe("buildColumnMap", () => {
  const attributes = {
    id: attr("student_id", DataTypes.INTEGER),
    name: attr("f_name", DataTypes.STRING),
    isDeleted: attr("is_deleted", DataTypes.BOOLEAN, { allowNull: false, defaultValue: false }),
  };

  it("matches columns case-insensitively and reports both sides' leftovers", () => {
    const map = buildColumnMap(attributes, ["STUDENT_ID", "f_name", "legacy_note"]);
    expect(map.copy.map((c) => [c.source, c.target])).toEqual([
      ["STUDENT_ID", "student_id"],
      ["f_name", "f_name"],
    ]);
    expect(map.sourceOnly).toEqual(["legacy_note"]);
    expect(map.targetOnly).toEqual(["is_deleted"]);
  });
});

describe("transformRows", () => {
  const hash = jest.fn(async (pw) => `$2b$10$hashed-${pw}`);

  const attributes = {
    id: attr("student_id", DataTypes.INTEGER, { primaryKey: true, autoIncrement: true, allowNull: false }),
    password: attr("password", DataTypes.STRING),
    isDeleted: attr("is_deleted", DataTypes.BOOLEAN, { allowNull: false, defaultValue: false }),
  };
  const map = buildColumnMap(attributes, ["student_id", "password"]);

  it("hashes plaintext passwords, keeps existing hashes and NULLs, fills new NOT NULL defaults", async () => {
    const stats = { defaulted: {}, passwordsHashed: 0 };
    const out = await transformRows(
      [
        { student_id: 1, password: "plain" },
        { student_id: 2, password: "$2b$10$alreadyhashedalreadyhashedalreadyhashedalready" },
        { student_id: 3, password: null },
      ],
      map,
      { table: "Student", attributes, hash, stats }
    );
    expect(out[0]).toEqual({ student_id: 1, password: "$2b$10$hashed-plain", is_deleted: false });
    expect(out[1].password).toMatch(/^\$2b\$10\$already/);
    expect(out[2].password).toBeNull();
    expect(stats.passwordsHashed).toBe(1);
  });

  it("does not hash passwords in tables that are not login tables", async () => {
    hash.mockClear();
    await transformRows([{ student_id: 1, password: "x" }], map, { table: "Parent", attributes, hash });
    expect(hash).not.toHaveBeenCalled();
  });

  it("replaces NULL in a NOT NULL column with the model default (live Term.active)", async () => {
    const termAttrs = {
      id: attr("term_id", DataTypes.INTEGER, { primaryKey: true, autoIncrement: true, allowNull: false }),
      active: attr("active", DataTypes.BOOLEAN, { allowNull: false, defaultValue: false }),
    };
    const stats = { defaulted: {}, passwordsHashed: 0 };
    const out = await transformRows(
      [{ term_id: 3, active: null }],
      buildColumnMap(termAttrs, ["term_id", "active"]),
      { table: "Term", attributes: termAttrs, hash, stats }
    );
    expect(out[0].active).toBe(false);
    expect(stats.defaulted).toEqual({ active: 1 });
  });
});

describe("isBcryptHash", () => {
  it.each([["$2a$10$x", true], ["$2b$10$x", true], ["$2y$10$x", true], ["$2x", false], ["secret", false], [null, false]])(
    "%p -> %p",
    (v, expected) => expect(isBcryptHash(v)).toBe(expected)
  );
});

describe("loadOrder", () => {
  const model = (name, parents = []) => ({
    name,
    associations: Object.fromEntries(
      parents.map((p) => [p, { associationType: "BelongsTo", target: { name: p } }])
    ),
  });

  it("puts parents before children and tolerates cycles", () => {
    const models = [
      model("student", ["class", "parent"]),
      model("class", ["teacher"]),
      model("teacher", ["class"]), // cycle Class <-> Teacher
      model("parent"),
    ];
    const order = loadOrder(models).map((m) => m.name);
    expect(order).toHaveLength(4);
    expect(order.indexOf("parent")).toBeLessThan(order.indexOf("student"));
    expect(order.indexOf("class")).toBeLessThan(order.indexOf("student"));
  });
});

describe("duplicateSql", () => {
  it("quotes plain columns and leaves expressions alone", () => {
    const subject = UNIQUE_KEYS.find((k) => k.index === "uniq_subject_name");
    const sql = duplicateSql(subject, (c) => `"${c}"`, '"dbo"."Subject"');
    expect(sql).toContain("lower(name)");
    expect(sql).toContain('FROM "dbo"."Subject"');
    expect(sql).toContain("HAVING COUNT(*) > 1");
  });

  it("ignores groups with an empty key column (a unique index allows those)", () => {
    const marks = UNIQUE_KEYS.find((k) => k.index === "uniq_marks");
    const sql = duplicateSql(marks, (c) => `"${c}"`, '"dbo"."Student_marks"');
    expect(sql).toContain('WHERE "student_id" IS NOT NULL AND "subject_id" IS NOT NULL AND "class" IS NOT NULL AND "term_id" IS NOT NULL');
  });

  it("covers every unique index created by migration 001", () => {
    expect(UNIQUE_KEYS.map((k) => k.index).sort()).toEqual(
      ["uniq_attendance", "uniq_kg", "uniq_marks", "uniq_result", "uniq_subject_name", "uniq_total_attendance"]
    );
  });
});

// Review finding: decimals in the source would be rounded by whole-number
// target columns (marks/fees are DECIMAL(18,0)); the move now reports them.
describe("roundingRisks", () => {
  const { DataTypes } = require("sequelize");
  const { roundingRisks } = require("../utils/dataMove.js");
  const attr = (field, type) => ({ field, type });
  const map = {
    copy: [
      { source: "paid", target: "paid", attr: attr("paid", DataTypes.DECIMAL(18, 0)) },
      { source: "exam_score", target: "exam_score", attr: attr("exam_score", DataTypes.DECIMAL(18, 2)) },
      { source: "age", target: "age", attr: attr("age", new DataTypes.INTEGER()) },
      { source: "name", target: "name", attr: attr("name", DataTypes.STRING(50)) },
      { source: "rate", target: "rate", attr: attr("rate", new DataTypes.INTEGER()) },
    ],
  };
  it("flags decimal/float source columns going into whole-number targets only", () => {
    const out = roundingRisks(map, { paid: "decimal(18,2)", exam_score: "decimal(18,2)", age: "int(11)", name: "varchar(50)", rate: "double" });
    expect(out.map((r) => [r.target, r.sourceType])).toEqual([
      ["paid", "decimal(18,2)"],
      ["rate", "double"],
    ]);
  });
  it("whole-number sources are fine", () => {
    expect(roundingRisks(map, { paid: "decimal(18,0)", rate: "int(11)" })).toEqual([]);
  });
});

describe("rowProblems (dry run: values the move would refuse)", () => {
  const { DataTypes } = require("sequelize");
  const { rowProblems } = require("../utils/dataMove.js");
  const a = (field, type, extra = {}) => ({ field, type, ...extra });
  const map = {
    copy: [
      { source: "dob", target: "dob", attr: a("dob", DataTypes.DATEONLY, { allowNull: false }) },
      { source: "f_name", target: "f_name", attr: a("f_name", DataTypes.STRING(5)) },
      { source: "active", target: "active", attr: a("active", DataTypes.BOOLEAN) },
      { source: "paid_on", target: "paid_on", attr: a("paid_on", DataTypes.DATEONLY) },
    ],
  };
  it("flags zero/missing required dates, long strings, odd booleans and impossible dates", () => {
    const out = rowProblems(
      [
        { dob: "0000-00-00", f_name: "Abena", active: "1", paid_on: "2023-02-30" },
        { dob: "2013-01-01", f_name: "Kwabena", active: "maybe", paid_on: "2023-03-01" },
      ],
      map
    );
    expect(out.map((p) => [p.column, p.problem, p.rows])).toEqual([
      ["dob", "empty but required", 1],
      ["paid_on", "not a real date", 1],
      ["f_name", "longer than 5 characters", 1],
      ["active", "cannot convert", 1],
    ]);
  });
  it("clean rows: nothing", () => {
    expect(rowProblems([{ dob: "2013-01-01", f_name: "Ama", active: 0, paid_on: null }], map)).toEqual([]);
  });
});

describe("findSourceTable (live MySQL names its tables \"dbo.X\")", () => {
  it("finds the dbo.-prefixed table the old app used", () => {
    expect(findSourceTable(["dbo.Class", "StudentFee"], "Class")).toBe("dbo.Class");
  });
  it("falls back to the plain name (StudentFee had no schema; rehearsal fixtures)", () => {
    expect(findSourceTable(["dbo.Class", "StudentFee"], "StudentFee")).toBe("StudentFee");
    expect(findSourceTable(["Class"], "Class")).toBe("Class");
  });
  it("prefers dbo.X when both exist, ignores case, never matches dbo.dbo.X", () => {
    expect(findSourceTable(["Teacher", "dbo.Teacher", "dbo.dbo.Teacher"], "Teacher")).toBe("dbo.Teacher");
    expect(findSourceTable(["DBO.class"], "Class")).toBe("DBO.class");
    expect(findSourceTable(["dbo.dbo.Teacher"], "Teacher")).toBeUndefined();
  });
});

describe("scores kept as text in live MySQL", () => {
  const { rowProblems } = require("../utils/dataMove.js");
  const int = { type: DataTypes.INTEGER, allowNull: true };
  const dec = { type: DataTypes.DECIMAL(5, 2), allowNull: true };
  it('"---" and blank mean no score -> NULL', () => {
    expect(coerceValue("---", int)).toBeNull();
    expect(coerceValue(" ", dec)).toBeNull();
    expect(coerceValue("52.50", dec)).toBe("52.50");
    expect(coerceValue("70", int)).toBe("70");
  });
  it("the dry run flags half marks going into a whole-number column, and reports the dashes", () => {
    const map = { copy: [{ source: "s", target: "t", attr: int }] };
    const found = rowProblems([{ s: "52.50" }, { s: "---" }, { s: "70" }], map);
    expect(found.map((f) => f.problem).sort()).toEqual(['"---" (no score) becomes empty', "not a whole number"]);
    const decMap = { copy: [{ source: "s", target: "t", attr: dec }] };
    expect(rowProblems([{ s: "52.50" }, { s: "86.00" }], decMap)).toEqual([]);
  });
});
