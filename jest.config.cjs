// Jest config for the backend. The project is ESM ("type":"module") and is
// transpiled by Babel (.babelrc -> @babel/preset-env), so babel-jest compiles
// the import/export syntax to CommonJS for the test run. Tests live in
// src/__tests__ and never touch a real Postgres connection (models are mocked).
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.js"],
  clearMocks: true,
  collectCoverageFrom: [
    "src/services/**/*.js",
    "src/utils/**/*.js",
  ],
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
};
