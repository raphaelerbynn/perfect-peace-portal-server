// B17: the object-store driver (MinIO / S3), its env settings, and image
// processing (sharp). The S3 client is a fake; no network.
import { Readable } from "stream";
import sharp from "sharp";
import {
  createS3Driver,
  initStorage,
  processImage,
  saveUpload,
  setStorageDriver,
  storage,
  storageConfigFromEnv,
  storageDriverName,
} from "../services/storage.js";
import { BROKEN_JPEG, JPEG, PDF, PNG, WEBP } from "./uploadFixtures.js";

const fakeClient = () => {
  const objects = new Map();
  const calls = [];
  let bucketExists = true;
  const notFound = (name) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  return {
    objects,
    calls,
    dropBucket: () => (bucketExists = false),
    async send(cmd) {
      const kind = cmd.constructor.name;
      const i = cmd.input;
      calls.push({ kind, ...i });
      if (kind === "PutObjectCommand") return objects.set(i.Key, Buffer.from(i.Body)) && {};
      if (kind === "GetObjectCommand") {
        if (!objects.has(i.Key)) throw notFound("NoSuchKey");
        const b = objects.get(i.Key);
        return { Body: Readable.from([b]), ContentLength: b.length };
      }
      if (kind === "DeleteObjectCommand") return objects.delete(i.Key) && {};
      if (kind === "HeadBucketCommand") {
        if (!bucketExists) throw notFound("NotFound");
        return {};
      }
      if (kind === "CreateBucketCommand") return (bucketExists = true) && {};
      throw new Error(`unexpected ${kind}`);
    },
  };
};

const readAll = async (stream) => {
  const c = [];
  for await (const d of stream) c.push(d);
  return Buffer.concat(c);
};

afterEach(() => setStorageDriver(null));

describe("storageConfigFromEnv", () => {
  const s3 = { STORAGE_DRIVER: "s3", S3_ENDPOINT: "http://minio:9000", S3_BUCKET: "pp", S3_ACCESS_KEY: "a", S3_SECRET_KEY: "b" };
  it("defaults to the local disk", () => {
    expect(storageConfigFromEnv({})).toEqual({ kind: "local" });
    expect(storageConfigFromEnv({ STORAGE_DRIVER: "LOCAL" })).toEqual({ kind: "local" });
  });
  it("s3 / minio: path-style on, region defaulted", () => {
    expect(storageConfigFromEnv(s3)).toEqual({
      kind: "s3",
      endpoint: "http://minio:9000",
      region: "us-east-1",
      bucket: "pp",
      accessKeyId: "a",
      secretAccessKey: "b",
      forcePathStyle: true,
    });
    expect(storageConfigFromEnv({ ...s3, STORAGE_DRIVER: "minio", S3_FORCE_PATH_STYLE: "false" }).forcePathStyle).toBe(false);
  });
  it("a missing setting or an unknown driver stops the start", () => {
    expect(() => storageConfigFromEnv({ ...s3, S3_SECRET_KEY: "" })).toThrow(/S3_SECRET_KEY/);
    expect(() => storageConfigFromEnv({ STORAGE_DRIVER: "drive" })).toThrow(/local.*s3/);
  });
  it("initStorage picks the local disk without settings", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    await initStorage({ env: {} });
    expect(storageDriverName()).toBe("local");
  });
});

describe("S3 driver", () => {
  it("puts under a server-made key, reads it back, removes it", async () => {
    const client = fakeClient();
    const d = createS3Driver({ client, bucket: "pp" });
    const key = await d.put(Buffer.from("hello"), { folder: "documents", ext: "pdf" });
    expect(key).toMatch(/^documents\/\d{4}\/[a-f0-9]{32}\.pdf$/);
    expect(client.calls[0]).toMatchObject({ kind: "PutObjectCommand", Bucket: "pp", ContentType: "application/pdf", ContentLength: 5 });
    const { stream, size } = await d.open(key);
    expect(size).toBe(5);
    expect((await readAll(stream)).toString()).toBe("hello");
    await d.remove(key);
    expect(client.objects.size).toBe(0);
  });
  it("a missing object is a 404; a non-server key is never sent to the store", async () => {
    const client = fakeClient();
    const d = createS3Driver({ client, bucket: "pp" });
    await expect(d.open("photos/2026/" + "a".repeat(32) + ".webp")).rejects.toMatchObject({ statusCode: 404 });
    await expect(d.open("../etc/passwd")).rejects.toMatchObject({ statusCode: 404 });
    await d.remove("../../x");
    expect(client.calls.map((c) => c.kind)).toEqual(["GetObjectCommand"]);
  });
  it("other store errors are not hidden as 404", async () => {
    const d = createS3Driver({ client: { send: async () => Promise.reject(Object.assign(new Error("down"), { name: "TimeoutError" })) }, bucket: "pp" });
    await expect(d.open("photos/2026/" + "a".repeat(32) + ".webp")).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("ensureBucket creates a missing bucket once", async () => {
    const client = fakeClient();
    client.dropBucket();
    const d = createS3Driver({ client, bucket: "pp" });
    jest.spyOn(console, "log").mockImplementation(() => {});
    await d.ensureBucket();
    await d.ensureBucket();
    expect(client.calls.filter((c) => c.kind === "CreateBucketCommand")).toHaveLength(1);
  });
  it("saveUpload stores a photo and its thumbnail; if the second put fails the first is removed", async () => {
    const client = fakeClient();
    setStorageDriver(createS3Driver({ client, bucket: "pp" }));
    const saved = await saveUpload({ buffer: JPEG, originalname: "p.jpg" }, "photo");
    expect(saved).toMatchObject({ mime: "image/webp", ext: "webp", originalName: "p.jpg" });
    expect(saved.thumbKey).toMatch(/-thumb\.webp$/);
    expect([...client.objects.keys()].sort()).toEqual([saved.key, saved.thumbKey].sort());

    const flaky = fakeClient();
    let n = 0;
    const send = flaky.send.bind(flaky);
    flaky.send = async (cmd) => {
      if (cmd.constructor.name === "PutObjectCommand" && ++n === 2) throw new Error("store full");
      return send(cmd);
    };
    setStorageDriver(createS3Driver({ client: flaky, bucket: "pp" }));
    jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(saveUpload({ buffer: JPEG, originalname: "p.jpg" }, "photo")).rejects.toThrow("store full");
    expect(flaky.objects.size).toBe(0);
  });
});

describe("processImage (sharp)", () => {
  it("the fixture JPEG really carries EXIF (camera + GPS)", async () => {
    expect((await sharp(JPEG).metadata()).exif).toBeDefined();
  });
  it("photo: 512px-max WebP + 128px square thumb, metadata gone", async () => {
    const big = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#808080" } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "5/1 33/1 0/1" } })
      .toBuffer();
    const [main, thumb] = await processImage(big, "image/jpeg", "photo");
    const m = await sharp(main.buffer).metadata();
    expect(m).toMatchObject({ format: "webp", width: 512, height: 256 });
    expect(m.exif).toBeUndefined();
    expect(await sharp(thumb.buffer).metadata()).toMatchObject({ format: "webp", width: 128, height: 128 });
    expect(thumb.suffix).toBe("-thumb");
  });
  it("EXIF orientation is applied to the pixels (then dropped)", async () => {
    const rotated = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#fff" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const [main] = await processImage(rotated, "image/jpeg", "photo");
    const m = await sharp(main.buffer).metadata();
    expect([m.width, m.height, m.orientation]).toEqual([20, 40, undefined]);
  });
  it("logo / document images keep their type (PNG keeps transparency), metadata gone", async () => {
    const [logo] = await processImage(PNG, "image/png", "logo");
    expect(await sharp(logo.buffer).metadata()).toMatchObject({ format: "png", hasAlpha: true });
    const [doc] = await processImage(JPEG, "image/jpeg", "document");
    const m = await sharp(doc.buffer).metadata();
    expect(m.format).toBe("jpeg");
    expect(m.exif).toBeUndefined();
    const [w] = await processImage(WEBP, "image/webp", "document");
    expect(w.mime).toBe("image/webp");
  });
  it("PDFs are stored exactly as uploaded", async () => {
    const [p] = await processImage(PDF, "application/pdf", "document");
    expect(p.buffer.equals(PDF)).toBe(true);
  });
  it("right first bytes but not a real image: 415", async () => {
    await expect(processImage(BROKEN_JPEG, "image/jpeg", "photo")).rejects.toMatchObject({ statusCode: 415 });
    await expect(processImage(BROKEN_JPEG, "image/jpeg", "document")).rejects.toMatchObject({ statusCode: 415 });
  });
  it("storage.remove never throws (old file clean-up)", async () => {
    setStorageDriver({ name: "x", remove: async () => Promise.reject(new Error("gone")) });
    jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(storage.remove("photos/2026/" + "a".repeat(32) + ".webp")).resolves.toBeUndefined();
  });
});

describe("processImage limits (B17 review)", () => {
  it("an image over 50 MP is refused from its header, before decoding (413)", async () => {
    // 8000 x 7000 = 56 MP, a tiny flat PNG
    const huge = await sharp({ create: { width: 8000, height: 7000, channels: 3, background: "#000" } }).png().toBuffer();
    expect(huge.length).toBeLessThan(5 * 1024 * 1024);
    await expect(processImage(huge, "image/png", "photo")).rejects.toMatchObject({ statusCode: 413 });
    await expect(processImage(huge, "image/png", "document")).rejects.toMatchObject({ statusCode: 413 });
  });
  it("jobs run one at a time and a failure does not block the next", async () => {
    const results = await Promise.allSettled([
      processImage(BROKEN_JPEG, "image/jpeg", "photo"),
      processImage(JPEG, "image/jpeg", "photo"),
      processImage(PNG, "image/png", "logo"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
});

describe("S3 driver: lost bucket", () => {
  it("put re-creates a missing bucket once and retries", async () => {
    const client = fakeClient();
    const send = client.send.bind(client);
    let gone = true;
    client.send = async (cmd) => {
      if (cmd.constructor.name === "PutObjectCommand" && gone) {
        gone = false;
        throw Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" });
      }
      return send(cmd);
    };
    client.dropBucket();
    jest.spyOn(console, "log").mockImplementation(() => {});
    const d = createS3Driver({ client, bucket: "pp" });
    const key = await d.put(Buffer.from("x"), { folder: "documents", ext: "pdf" });
    expect(client.objects.has(key)).toBe(true);
    expect(client.calls.filter((c) => c.kind === "CreateBucketCommand")).toHaveLength(1);
  });
});
