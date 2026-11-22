// B17: copy files already on the local disk (UPLOAD_DIR) into the object store
// (MinIO), for a server that ran with STORAGE_DRIVER=local before.
//
//   STORAGE_DRIVER=s3 S3_... UPLOAD_DIR=/app/uploads npm run uploads-to-s3 -- --dry-run
//   ... npm run uploads-to-s3
//   Docker: docker compose -f docker-compose.prod.yml exec backend node dist/scripts/uploadsToS3.js [--dry-run]
//
// Copies every key the database points at (pupil/staff photos + thumbnails,
// documents, the school logo). Keys stay the same, so nothing in the database
// changes. Files already in the bucket are skipped; it is safe to re-run.
// Local files are left in place (delete the folder yourself once checked).
// Reports any key whose file is missing on disk.
import fsp from "fs/promises";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sequelize from "../config/database.js";
import { MIME_FOR_EXT, createDriverFromConfig, isValidKey, keyToPath, storageConfigFromEnv } from "../services/storage.js";

const QUERY = `
  SELECT photo_key AS key FROM "dbo"."Student" WHERE photo_key IS NOT NULL
  UNION SELECT photo_thumb_key FROM "dbo"."Student" WHERE photo_thumb_key IS NOT NULL
  UNION SELECT photo_key FROM "dbo"."Teacher" WHERE photo_key IS NOT NULL
  UNION SELECT photo_thumb_key FROM "dbo"."Teacher" WHERE photo_thumb_key IS NOT NULL
  UNION SELECT storage_key FROM "dbo"."Document"
  UNION SELECT logo_key FROM "dbo"."School_settings" WHERE logo_key IS NOT NULL`;

const exists = async (d, key) => {
  try {
    await d.client.send(new HeadObjectCommand({ Bucket: d.bucket, Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return false;
    throw e;
  }
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = storageConfigFromEnv();
  if (cfg.kind !== "s3") throw new Error("Set STORAGE_DRIVER=s3 and the S3_* settings first.");
  const d = createDriverFromConfig(cfg);
  if (!dryRun) await d.ensureBucket();
  const [rows] = await sequelize.query(QUERY);
  const counts = { copied: 0, alreadyThere: 0, missingOnDisk: 0, badKey: 0 };
  for (const { key } of rows) {
    if (!isValidKey(key)) {
      counts.badKey += 1;
      console.warn(`skip (not a server key): ${key}`);
      continue;
    }
    let buf;
    try {
      buf = await fsp.readFile(keyToPath(key));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      counts.missingOnDisk += 1;
      console.warn(`missing on disk: ${key}`);
      continue;
    }
    if (await exists(d, key).catch((e) => (dryRun ? false : Promise.reject(e)))) {
      counts.alreadyThere += 1;
      continue;
    }
    if (!dryRun) {
      await d.client.send(
        new PutObjectCommand({ Bucket: d.bucket, Key: key, Body: buf, ContentLength: buf.length, ContentType: MIME_FOR_EXT[key.split(".").pop()] })
      );
    }
    counts.copied += 1;
  }
  console.log(`${dryRun ? "[dry run] would copy" : "copied"} ${counts.copied}, already there ${counts.alreadyThere}, missing on disk ${counts.missingOnDisk}, bad keys ${counts.badKey} (of ${rows.length})`);
  return counts.missingOnDisk || counts.badKey ? 1 : 0;
};

main()
  .then(async (code) => {
    await sequelize.close();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(e?.message || e);
    await sequelize.close().catch(() => {});
    process.exit(1);
  });
