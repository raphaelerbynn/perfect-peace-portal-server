// Runs before every test file (jest.config.js setupFilesAfterEnv).
// B10: office permissions are loaded from the database on every request
// (services/officeAccess.js -> accessStore.js). Tests have no database, so the
// store is the in-memory fake; see fakeAccessStore.js.
jest.mock("../services/accessStore.js", () => require("./fakeAccessStore.js"));
