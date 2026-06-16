// Feature #1 (global shell hardening): errors must resolve to a sane HTTP
// status and 5xx internals must NOT leak to the client.
import { AppError, errorHandler } from "../utils/errorHandling.js";

const makeRes = (initialStatus = 200) => {
  const res = {
    statusCode: initialStatus,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

describe("AppError", () => {
  it("carries the status code and exposes 4xx messages", () => {
    const err = new AppError("bad input", 400);
    expect(err.statusCode).toBe(400);
    expect(err.expose).toBe(true);
    expect(err.name).toBe("AppError");
  });

  it("does not mark 5xx as safe to expose", () => {
    const err = new AppError("boom", 500);
    expect(err.expose).toBe(false);
  });

  it("defaults to 500", () => {
    expect(new AppError("x").statusCode).toBe(500);
  });
});

describe("errorHandler", () => {
  // Silence the intentional console.error in the handler during tests.
  beforeAll(() => jest.spyOn(console, "error").mockImplementation(() => {}));
  afterAll(() => console.error.mockRestore());

  it("returns the explicit AppError status and message for 4xx", () => {
    const res = makeRes();
    errorHandler(new AppError("Name is required.", 400), {}, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Name is required." });
  });

  it("masks 5xx error messages with a generic message", () => {
    const res = makeRes();
    errorHandler(new Error("SELECT * FROM secret -- leaked SQL"), {}, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe("Something went wrong. Please try again later.");
    expect(res.body.message).not.toMatch(/SQL/);
  });

  it("honours a status the auth layer set on res before throwing (401/403)", () => {
    const res = makeRes(403);
    errorHandler(new Error("forbidden"), {}, res);
    expect(res.statusCode).toBe(403);
  });

  it("never resolves an error to a 2xx status", () => {
    const res = makeRes(200);
    errorHandler(new Error("unexpected"), {}, res);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });
});
