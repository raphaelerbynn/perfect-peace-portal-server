// The office sign-up response must never include the password hash.
jest.mock("../services/user.js", () => ({
  __esModule: true,
  findManagementUser: jest.fn(async () => null),
  signUpManagementUser: jest.fn(async (d) => ({ get: () => ({ username: d.username, category: d.category, password: "$2b$10$hash" }) })),
  getManagementUser: jest.fn(), getStudentUser: jest.fn(), getTeacherUser: jest.fn(),
  managementUserExistsForStaff: jest.fn(), studentSignUp: jest.fn(), teacherSignUp: jest.fn(),
}));
import { signupManagement } from "../controllers/authController.js";

it("returns the account without its password", async () => {
  const res = { status: jest.fn(() => res), json: jest.fn() };
  const next = jest.fn();
  await signupManagement({ body: { username: "acc2", password: "teach1234", staffId: "2", category: "Accountant", email: "a@b.c" } }, res, next);
  expect(next).not.toHaveBeenCalled();
  const body = res.json.mock.calls[0][0];
  expect(body).toEqual({ message: "Login created", account: { username: "acc2", category: "Accountant" } });
  expect(JSON.stringify(body)).not.toContain("$2b$");
});

// B10: an Administrator can give a new office login the Head Teacher role;
// Administrator logins still can't be created this way.
it("accepts the Head Teacher role", async () => {
  const res = { status: jest.fn(() => res), json: jest.fn() };
  const next = jest.fn();
  await signupManagement({ body: { username: "head", password: "teach1234", staffId: "9", category: "Head Teacher", email: "h@b.c" } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.json.mock.calls[0][0]).toEqual({ message: "Login created", account: { username: "head", category: "Head Teacher" } });
});

it.each(["Administrator", "Bursar", "head teacher"])("refuses the %s role (403)", async (category) => {
  const res = { status: jest.fn(() => res), json: jest.fn() };
  const next = jest.fn();
  await signupManagement({ body: { username: "x", password: "teach1234", staffId: "9", category, email: "h@b.c" } }, res, next);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  expect(res.json).not.toHaveBeenCalled();
});
