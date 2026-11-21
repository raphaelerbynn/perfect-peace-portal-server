// B17: a host where sharp can't load (old glibc on shared hosting): the API
// still loads, PDFs still upload, image uploads answer 503.
jest.mock("sharp", () => {
  throw new Error("libvips-cpp.so: cannot open shared object file");
});
import { processImage } from "../services/storage.js";
import { JPEG, PDF } from "./uploadFixtures.js";

it("images 503, PDFs unaffected", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  await expect(processImage(JPEG, "image/jpeg", "photo")).rejects.toMatchObject({ statusCode: 503 });
  const [p] = await processImage(PDF, "application/pdf", "document");
  expect(p.buffer.equals(PDF)).toBe(true);
});
