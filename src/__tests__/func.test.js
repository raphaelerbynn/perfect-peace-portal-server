// Feature #13 (SMS), #4 (Students), #8 (KG results): message templating must
// sanitize client-supplied values, phone validation must accept country-code
// numbers, age must be a real date diff, and KG rows must group by category.
import {
  composeMessage,
  isValidPhoneNumber,
  calculateAge,
  transformReturningKGResult,
} from "../utils/func.js";

describe("composeMessage", () => {
  it("interpolates {{key}} placeholders (with optional spaces)", () => {
    const out = composeMessage(
      { name: "Ama", amount: 50 },
      "Hello {{name}}, you paid {{ amount }}."
    );
    expect(out).toBe("Hello Ama, you paid 50.");
  });

  it("strips newlines and braces so a value cannot inject another token", () => {
    const out = composeMessage(
      { name: "Bad\n{{amount}}", amount: 999 },
      "Hi {{name}} pays {{amount}}"
    );
    // The injected {{amount}} inside the name must NOT be expanded, and the
    // newline must be flattened to a space.
    expect(out).toBe("Hi Bad amount pays 999");
    expect(out).not.toContain("\n");
  });

  it("clamps a crafted long value to 120 chars (segment-inflation guard)", () => {
    const long = "x".repeat(500);
    const out = composeMessage({ v: long }, "{{v}}");
    expect(out).toHaveLength(120);
  });

  it("renders null/undefined values as empty string", () => {
    expect(composeMessage({ v: null }, "[{{v}}]")).toBe("[]");
  });

  it("handles missing data object", () => {
    expect(composeMessage(undefined, "no tokens")).toBe("no tokens");
  });
});

describe("isValidPhoneNumber", () => {
  it.each(["0244123456", "+233244123456", "233244123456"])(
    "accepts %p",
    (p) => expect(isValidPhoneNumber(p)).toBe(true)
  );

  it.each(["123", "abcdefghij", "+12345678901234567", ""])(
    "rejects %p",
    (p) => expect(isValidPhoneNumber(p)).toBe(false)
  );

  it("trims surrounding whitespace before testing", () => {
    expect(isValidPhoneNumber("  0244123456  ")).toBe(true);
  });
});

describe("calculateAge", () => {
  it("returns null for falsy / invalid dates", () => {
    expect(calculateAge(null)).toBeNull();
    expect(calculateAge("not-a-date")).toBeNull();
  });

  it("computes a real date diff (does not over-count before the birthday)", () => {
    const today = new Date();
    // A birthday one month in the FUTURE this year => they are exactly N-1.
    const future = new Date(today);
    future.setFullYear(today.getFullYear() - 10);
    future.setMonth(today.getMonth() + 1);
    expect(calculateAge(future.toISOString())).toBe(9);
  });

  it("counts a full year once the birthday has passed", () => {
    const today = new Date();
    const past = new Date(today);
    past.setFullYear(today.getFullYear() - 10);
    past.setMonth(today.getMonth() - 1);
    expect(calculateAge(past.toISOString())).toBe(10);
  });
});

describe("transformReturningKGResult", () => {
  it("groups assessments under the right development category and keeps meta", () => {
    const rows = [
      {
        category: "Language and Literacy",
        assessment: "Listening",
        satisfactory: true,
        improved: false,
        needsImprovement: false,
        unsatisfactory: false,
        notApplicable: false,
        class: "KG1",
        term: "Term 1",
        studentId: 7,
        promoted: true,
      },
      {
        category: "Cognitive",
        assessment: "Counting",
        satisfactory: false,
        improved: true,
        needsImprovement: false,
        unsatisfactory: false,
        notApplicable: false,
        class: "KG1",
        term: "Term 1",
        studentId: 7,
        promoted: true,
      },
    ];
    const out = transformReturningKGResult(rows);
    expect(out.languageDevelopment.Listening).toBe("satisfactory");
    expect(out.cognitiveDevelopment.Counting).toBe("improved");
    expect(out.class).toBe("KG1");
    expect(out.studentId).toBe(7);
    expect(out.promoted).toBe(true);
  });
});
