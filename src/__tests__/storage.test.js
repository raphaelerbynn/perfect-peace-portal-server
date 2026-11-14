// B17: upload checks and the local disk driver (no DB).
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { Readable } from "stream";
import {
  PRESETS,
  cleanFileName,
  isValidKey,
  keyToPath,
  localDriver,
  sendStoredFile,
  setStorageDriver,
  sniffMime,
  validateUpload,
} from "../services/storage.js";

import { JPEG, PNG, WEBP, PDF } from "./uploadFixtures.js";

const HTML = Buffer.from("<html><script>alert(1)</script></html>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);

describe("sniffMime (magic bytes)", () => {
  it.each([
    [JPEG, "image/jpeg"],
    [PNG, "image/png"],
    [WEBP, "image/webp"],
    [PDF, "application/pdf"],
  ])("recognises real files", (buf, mime) => expect(sniffMime(buf)).toBe(mime));
  it.each([[HTML], [SVG], [ZIP], [Buffer.from("%PDF")], [Buffer.alloc(0)], ["not a buffer"]])(
    "anything else is unknown",
    (buf) => expect(sniffMime(buf)).toBeNull()
  );
});

describe("validateUpload", () => {
  const file = (buffer, extra = {}) => ({ buffer, originalname: "x", mimetype: "image/png", ...extra });

  it("uses the content, not the browser's type or the file name", () => {
    expect(validateUpload(file(JPEG, { mimetype: "application/pdf", originalname: "a.pdf" }), "photo")).toMatchObject({ mime: "image/jpeg", ext: "jpg" });
  });
  it("HTML dressed up as a PNG is refused (415)", () => {
    expect(() => validateUpload(file(HTML, { originalname: "photo.png", mimetype: "image/png" }), "photo")).toThrow(
      expect.objectContaining({ statusCode: 415 })
    );
  });
  it("SVG is never accepted (scripts)", () => {
    expect(() => validateUpload(file(SVG, { mimetype: "image/svg+xml" }), "logo")).toThrow(expect.objectContaining({ statusCode: 415 }));
  });
  it("a PDF is a document, not a photo", () => {
    expect(validateUpload(file(PDF), "document").mime).toBe("application/pdf");
    expect(() => validateUpload(file(PDF), "photo")).toThrow(expect.objectContaining({ statusCode: 415 }));
  });
  it("Office / zip files are refused (contents can't be checked)", () => {
    expect(() => validateUpload(file(ZIP, { mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "document")).toThrow(
      expect.objectContaining({ statusCode: 415 })
    );
  });
  it("size: at the limit is fine, one byte over is 413", () => {
    const max = PRESETS.photo.maxBytes;
    const at = Buffer.alloc(max, 0);
    JPEG.copy(at);
    expect(validateUpload(file(at), "photo").size).toBe(max);
    const over = Buffer.alloc(max + 1, 0);
    JPEG.copy(over);
    expect(() => validateUpload(file(over), "photo")).toThrow(expect.objectContaining({ statusCode: 413 }));
  });
  it("no file / empty file is 400", () => {
    expect(() => validateUpload(undefined, "photo")).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => validateUpload(file(Buffer.alloc(0)), "photo")).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe("cleanFileName", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\win.ini", "win.ini"],
    ["birth cert<script>.pdf", "birth certscript.pdf"],
    ['a"b\r\n.pdf', "ab.pdf"],
    ["", "file"],
    ["....", "file"],
    [".htaccess", "htaccess"],
  ])("%j -> %j", (input, out) => expect(cleanFileName(input)).toBe(out));
  it("is at most 120 characters", () => expect(cleanFileName("a".repeat(500) + ".pdf")).toHaveLength(120));
});

describe("keys and paths (path traversal)", () => {
  const root = path.resolve("/srv/uploads");
  it("accepts only server-made keys", () => {
    expect(isValidKey("photos/2026/" + "a".repeat(32) + ".jpg")).toBe(true);
    for (const bad of [
      "../photos/2026/" + "a".repeat(32) + ".jpg",
      "photos/2026/../../etc/passwd",
      "/etc/passwd",
      "photos/2026/" + "a".repeat(32) + ".html",
      "photos/2026/" + "A".repeat(32) + ".jpg",
      "photos/2026/" + "a".repeat(32) + ".jpg/../../x",
      "photos%2F..%2F..%2Fetc",
      "",
      null,
    ]) {
      expect(isValidKey(bad)).toBe(false);
      expect(() => keyToPath(bad, root)).toThrow(expect.objectContaining({ statusCode: 404 }));
    }
  });
  it("a valid key stays inside the upload folder", () => {
    const p = keyToPath("documents/2026/" + "b".repeat(32) + ".pdf", root);
    expect(p.startsWith(root + path.sep)).toBe(true);
  });
});

describe("localDriver", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-uploads-"));
    process.env.UPLOAD_DIR = dir;
  });
  afterEach(() => {
    delete process.env.UPLOAD_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores under a random key, reads it back, removes it", async () => {
    const key = await localDriver.put(PDF, { folder: "documents", ext: "pdf" });
    expect(isValidKey(key)).toBe(true);
    const { stream, size } = await localDriver.open(key);
    expect(size).toBe(PDF.length);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(Buffer.concat(chunks).equals(PDF)).toBe(true);
    await localDriver.remove(key);
    await expect(localDriver.open(key)).rejects.toMatchObject({ statusCode: 404 });
    await expect(localDriver.remove(key)).resolves.toBeUndefined(); // already gone is fine
  });

  it("two uploads never share a key", async () => {
    const a = await localDriver.put(JPEG, { folder: "photos", ext: "jpg" });
    const b = await localDriver.put(JPEG, { folder: "photos", ext: "jpg" });
    expect(a).not.toBe(b);
  });

  it("refuses to follow a symlink planted in the upload folder", async () => {
    const key = "photos/2026/" + "c".repeat(32) + ".jpg";
    fs.mkdirSync(path.join(dir, "photos/2026"), { recursive: true });
    fs.symlinkSync("/etc/hosts", path.join(dir, key));
    await expect(localDriver.open(key)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("sendStoredFile (file always released)", () => {
  const KEY = "photos/2026/" + "d".repeat(32) + ".jpg";
  let server;
  let opened;
  let driverStream;

  const serve = (handler) =>
    new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  const until = async (cond, ms = 2000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  afterEach(async () => {
    setStorageDriver(null);
    if (server) await new Promise((r) => server.close(r));
    server = null;
  });

  it("closes the file when the client aborts the download", async () => {
    // A big file read in small chunks, so the client can leave mid-way.
    const big = Buffer.alloc(8 * 1024 * 1024, 1);
    setStorageDriver({
      open: async () => {
        driverStream = Readable.from((function* gen() {
          for (let i = 0; i < big.length; i += 16 * 1024) yield big.subarray(i, i + 16 * 1024);
        })(), { objectMode: false });
        return { stream: driverStream, size: big.length };
      },
    });
    let outcome;
    const handlerNext = jest.fn();
    const port = await serve((req, res) => {
      sendStoredFile(res, { key: KEY, name: "logo.jpg", cache: "public, max-age=3600" })
        .then(() => (outcome = "resolved"), (e) => { outcome = "rejected"; handlerNext(e); });
    });
    await new Promise((resolve) => {
      const req = http.get({ port, host: "127.0.0.1", path: "/school/logo" }, (resp) => {
        resp.once("data", () => {
          req.destroy(); // client goes away after the first bytes
          resolve();
        });
      });
      req.on("error", () => {});
    });
    await until(() => outcome);
    expect(outcome).toBe("resolved");
    expect(handlerNext).not.toHaveBeenCalled();
    await until(() => driverStream.destroyed);
    expect(driverStream.destroyed).toBe(true);
  });

  it("closes a real file stream (fd) after an aborted download", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-uploads-"));
    process.env.UPLOAD_DIR = dir;
    try {
      const full = path.join(dir, KEY);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.alloc(16 * 1024 * 1024, 2));
      setStorageDriver({
        open: async (key) => {
          const r = await localDriver.open(key);
          opened = r.stream;
          return r;
        },
      });
      let done = false;
      const port = await serve((req, res) => {
        sendStoredFile(res, { key: KEY }).finally(() => (done = true));
      });
      await new Promise((resolve) => {
        const req = http.get({ port, host: "127.0.0.1", path: "/" }, (resp) => {
          resp.once("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => {});
      });
      await until(() => done);
      await until(() => opened.closed);
      expect(opened.destroyed).toBe(true);
      expect(opened.closed).toBe(true);
    } finally {
      delete process.env.UPLOAD_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the whole file and closes it on a normal download", async () => {
    setStorageDriver({
      open: async () => {
        driverStream = Readable.from([PNG]);
        return { stream: driverStream, size: PNG.length };
      },
    });
    const port = await serve((req, res) => {
      sendStoredFile(res, { key: "photos/2026/" + "e".repeat(32) + ".png" });
    });
    const body = await new Promise((resolve, reject) => {
      http.get({ port, host: "127.0.0.1", path: "/" }, (resp) => {
        expect(resp.headers["content-type"]).toBe("image/png");
        expect(resp.headers["cache-control"]).toBe("private, no-store");
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => resolve(Buffer.concat(chunks)));
      }).on("error", reject);
    });
    expect(body.equals(PNG)).toBe(true);
    await until(() => driverStream.destroyed);
  });

  it("a read error before any byte is thrown with the file headers removed", async () => {
    setStorageDriver({
      open: async () => {
        driverStream = new Readable({ read() { this.destroy(new Error("disk gone")); } });
        return { stream: driverStream, size: 100 };
      },
    });
    let caught;
    const port = await serve((req, res) => {
      sendStoredFile(res, { key: KEY }).catch((e) => {
        caught = e;
        expect(res.headersSent).toBe(false);
        expect(res.getHeader("Content-Length")).toBeUndefined();
        expect(res.getHeader("Content-Disposition")).toBeUndefined();
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "Server error" }));
      });
    });
    const status = await new Promise((resolve, reject) => {
      http.get({ port, host: "127.0.0.1", path: "/" }, (resp) => {
        resp.resume();
        resp.on("end", () => resolve(resp.statusCode));
      }).on("error", reject);
    });
    expect(caught?.message).toBe("disk gone");
    expect(status).toBe(500);
  });

  it("a read error after the headers went out resolves (no next(err)) and cuts the response", async () => {
    setStorageDriver({
      open: async () => {
        let sent = false;
        driverStream = new Readable({
          read() {
            if (!sent) {
              sent = true;
              this.push(Buffer.alloc(1024, 3));
              setTimeout(() => this.destroy(new Error("disk gone mid-file")), 30);
            }
          },
        });
        return { stream: driverStream, size: 4096 };
      },
    });
    let outcome;
    const port = await serve((req, res) => {
      sendStoredFile(res, { key: KEY }).then(() => (outcome = "resolved"), () => (outcome = "rejected"));
    });
    await new Promise((resolve) => {
      const req = http.get({ port, host: "127.0.0.1", path: "/" }, (resp) => {
        resp.on("data", () => {});
        resp.on("error", resolve);
        resp.on("aborted", resolve);
        resp.on("close", resolve);
      });
      req.on("error", resolve);
    });
    await until(() => outcome);
    expect(outcome).toBe("resolved");
    expect(driverStream.destroyed).toBe(true);
  });
});
