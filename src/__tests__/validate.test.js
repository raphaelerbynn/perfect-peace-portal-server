// Feature #1/#2 (auth hardening): the login/index-number parser and the
// field validators must reject malformed input with a 400 AppError instead of
// throwing a raw TypeError (which used to surface as a 500).
import {
  parseIndexNumber,
  assertRequiredString,
  assertPassword,
  assertEmail,
  PORTAL_ROLES,
  PASSWORD_MIN_LENGTH,
} from "../utils/validate.js";

describe("parseIndexNumber", () => {
  it("parses a valid STU index number", () => {
    expect(parseIndexNumber("STU/123")).toEqual({ role: "STU", id: "123" });
  });

  it("parses a valid STAFF index number and trims the id", () => {
    expect(parseIndexNumber("STAFF/ 42 ")).toEqual({ role: "STAFF", id: "42" });
  });

  it.each([null, undefined, "", 123, {}])(
    "rejects non-string / empty input (%p) with 400",
    (bad) => {
      expect(() => parseIndexNumber(bad)).toThrow(
        expect.objectContaining({ statusCode: 400 })
      );
    }
  );

  it("rejects a missing slash with 400", () => {
    expect(() => parseIndexNumber("STU123")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects an unknown role with 400", () => {
    expect(() => parseIndexNumber("ADMIN/1")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects an empty id with 400", () => {
    expect(() => parseIndexNumber("STU/   ")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("only accepts the two known portal roles", () => {
    expect(PORTAL_ROLES).toEqual(["STU", "STAFF"]);
  });
});

describe("assertRequiredString", () => {
  it("passes for a non-empty string", () => {
    expect(() => assertRequiredString("hello", "Name")).not.toThrow();
  });

  it.each([null, undefined, "", "   ", 5])(
    "throws 400 for %p",
    (bad) => {
      expect(() => assertRequiredString(bad, "Name")).toThrow(
        expect.objectContaining({ statusCode: 400 })
      );
    }
  );
});

describe("assertPassword", () => {
  it(`accepts a password of at least ${PASSWORD_MIN_LENGTH} chars`, () => {
    expect(() => assertPassword("a".repeat(PASSWORD_MIN_LENGTH))).not.toThrow();
  });

  it("rejects a short password with 400", () => {
    expect(() => assertPassword("short")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects a non-string password with 400", () => {
    expect(() => assertPassword(12345678)).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });
});

describe("assertEmail", () => {
  it.each([undefined, null, ""])("treats %p as optional (no throw)", (v) => {
    expect(() => assertEmail(v)).not.toThrow();
  });

  it("accepts a well-formed email", () => {
    expect(() => assertEmail("a@b.com")).not.toThrow();
  });

  it.each(["nope", "a@b", "a b@c.com", "@b.com"])(
    "rejects malformed email %p with 400",
    (bad) => {
      expect(() => assertEmail(bad)).toThrow(
        expect.objectContaining({ statusCode: 400 })
      );
    }
  );
});
