/* Import image-only "preview" listings into the marketplace.

   These are catalogue placeholders: a photo, a name, a price and real-world
   dimensions, but NO 3D model. They exist so the marketplace looks stocked for
   a client demo while the real GLBs are still being produced.

   Because they have no modelUrl they are invisible to everything that would try
   to render them: the studio's picker filters on modelUrl, and the AI designer
   only plans products that are READY and have a model. So a preview item can be
   browsed and priced, never dropped into a room.

   When the real model for one arrives, attach it and flip status to READY --
   the listing keeps its id, name and price.

   Usage: node scripts/import-preview-products.mjs [--apply] [--undo] */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");
const UNDO = process.argv.includes("--undo");

const env = fs.readFileSync(".env", "utf8");
const url = (env.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? "file:./dev.db")
  .trim()
  .replace(/^["']|["']$/g, "");
const db = createClient({ url });

const STATUS = "PREVIEW";
const THUMBS = "storage/thumbnails";

if (UNDO) {
  const rows = await db.execute({
    sql: "SELECT id, thumbnailUrl FROM Product WHERE status = ?",
    args: [STATUS],
  });
  console.log(`${rows.rows.length} preview listings to remove`);
  if (!APPLY) {
    console.log("Dry run — pass --apply to delete.");
    process.exit(0);
  }
  for (const r of rows.rows) {
    const f = path.join(THUMBS, String(r.thumbnailUrl).split("/").pop());
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await db.execute({ sql: "DELETE FROM Product WHERE status = ?", args: [STATUS] });
  console.log("Removed.");
  process.exit(0);
}

const catalog = JSON.parse(fs.readFileSync("scripts/data/preview-catalog.json", "utf8"));

// Names already taken — re-running must not create duplicates.
const existing = new Set(
  (await db.execute("SELECT name FROM Product")).rows.map((r) => String(r.name).toLowerCase()),
);

let added = 0;
let skipped = 0;
for (const item of catalog) {
  if (existing.has(item.name.toLowerCase())) {
    skipped++;
    continue;
  }
  if (!fs.existsSync(item.file)) {
    console.log(`  missing image, skipped: ${item.file}`);
    continue;
  }
  const id = crypto.randomUUID();
  const ext = path.extname(item.file) || ".png";
  const thumb = `${crypto.randomUUID()}${ext}`;
  if (APPLY) {
    fs.mkdirSync(THUMBS, { recursive: true });
    fs.copyFileSync(item.file, path.join(THUMBS, thumb));
    await db.execute({
      sql: `INSERT INTO Product
        (id, name, category, description, priceInr, styleTags, widthCm, depthCm, heightCm,
         status, thumbnailUrl, modelUrl, frontYaw, mount)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,0,?)`,
      args: [
        id,
        item.name,
        item.category,
        item.description ?? null,
        item.price,
        JSON.stringify(item.tags ?? []),
        item.w,
        item.d,
        item.h,
        STATUS,
        `/api/files/thumbnails/${thumb}`,
        item.mount ?? "floor",
      ],
    });
  }
  added++;
}

console.log(`${added} preview listings ${APPLY ? "added" : "to add"}, ${skipped} already present.`);
if (!APPLY) console.log("Dry run — pass --apply to write.");
