// B17 LIVE check against a real MinIO (skipped unless PP_MINIO_LIVE=1).
//   docker compose up -d --wait minio
//   PP_MINIO_LIVE=1 S3_ENDPOINT=http://127.0.0.1:9000 npx jest src/__tests__/live/minio.live.test.js
import { Readable } from "stream";
import { createDriverFromConfig, saveUpload, sendStoredFile, setStorageDriver, storage, storageConfigFromEnv } from "../../services/storage.js";
import { JPEG, PDF } from "../uploadFixtures.js";

const live = process.env.PP_MINIO_LIVE === "1" ? describe : describe.skip;

live("MinIO (live)", () => {
  let d;
  beforeAll(async () => {
    d = createDriverFromConfig(
      storageConfigFromEnv({
        STORAGE_DRIVER: "s3",
        S3_ENDPOINT: process.env.S3_ENDPOINT || "http://127.0.0.1:9000",
        S3_BUCKET: `pp-live-${Date.now()}`,
        S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || "ppminio",
        S3_SECRET_KEY: process.env.S3_SECRET_KEY || "ppminio-dev-password",
      })
    );
    await d.ensureBucket();
    await d.ensureBucket(); // second call: already there
    setStorageDriver(d);
  });
  afterAll(() => setStorageDriver(null));

  it("photo round trip: two objects, streamed back, removed; missing = 404", async () => {
    const saved = await saveUpload({ buffer: JPEG, originalname: "a.jpg" }, "photo");
    const { stream, size } = await storage.open(saved.key);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(Buffer.concat(chunks).length).toBe(size);
    expect(size).toBe(saved.size);
    await storage.remove(saved.key);
    await storage.remove(saved.thumbKey);
    await expect(storage.open(saved.key)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("anonymous access to the bucket is refused (private)", async () => {
    const saved = await saveUpload({ buffer: PDF, originalname: "x.pdf" }, "document");
    const res = await fetch(`${process.env.S3_ENDPOINT || "http://127.0.0.1:9000"}/${d.bucket}/${saved.key}`);
    expect(res.status).toBe(403);
    await storage.remove(saved.key);
  });

  it("sendStoredFile streams from MinIO with the private headers", async () => {
    const saved = await saveUpload({ buffer: PDF, originalname: "x.pdf" }, "document");
    const headers = {};
    const out = [];
    const res = new (require("stream").Writable)({
      write(c, e, cb) {
        out.push(c);
        cb();
      },
    });
    res.setHeader = (k, v) => (headers[k] = v);
    res.removeHeader = (k) => delete headers[k];
    res.headersSent = false;
    const done = sendStoredFile(res, { key: saved.key, name: "x.pdf" });
    res.on("finish", () => res.emit("close"));
    await done;
    expect(Buffer.concat(out).equals(PDF)).toBe(true);
    expect(headers["Content-Type"]).toBe("application/pdf");
    expect(headers["Cache-Control"]).toBe("private, no-store");
    await storage.remove(saved.key);
    expect(Readable).toBeDefined();
  });
});
