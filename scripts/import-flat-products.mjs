/* Import flat goods — rugs and wall art — from a folder of images.

   These need no 3D model. A rug is a rectangle on the floor and a canvas is a
   rectangle on a wall, so the product photo IS the product: the scene renders
   it as a textured plane at its real size. That makes them the cheapest stock
   to add and, going by what a finished room looks like, the most valuable.

   Folder layout — one image per product, named for it:
     Flat/rugs/Ivory Wool Rug.png
     Flat/art/Abstract Canvas.png

   Size defaults to something sensible per kind and can be overridden with a
   trailing "@WxH" in cm, e.g. "Ivory Wool Rug@240x170.png".

   Usage: node scripts/import-flat-products.mjs [--apply] [--dir=Flat]  */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");
const dirArg = process.argv.find((a) => a.startsWith("--dir="));
const ROOT = dirArg ? dirArg.slice(6) : "Flat";

const env = fs.readFileSync(".env", "utf8");
const url = (env.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? "file:./dev.db").trim().replace(/^["']|["']$/g, "");
const db = createClient({ url });

const KINDS = {
  rugs: {
    category: "Rugs",
    mount: "floor",
    // width x depth on the floor; height is nil — it lies flat.
    size: { w: 240, d: 170, h: 1 },
    tags: ["role:rug", "place:free", "pairs:sofa"],
    price: 18000,
  },
  art: {
    category: "Decor",
    mount: "wall",
    // width x height on the wall; depth is the frame.
    size: { w: 120, d: 4, h: 80 },
    tags: ["role:wall-art", "place:wall"],
    price: 12000,
  },
};

const THUMBS = "storage/thumbnails";
const existing = new Set(
  (await db.execute("SELECT name FROM Product")).rows.map((r) => String(r.name).toLowerCase()),
);

let added = 0;
let skipped = 0;
for (const [kind, spec] of Object.entries(KINDS)) {
  const dir = path.join(ROOT, kind);
  if (!fs.existsSync(dir)) {
    console.log(`  ${dir} — not present, skipping`);
    continue;
  }
  for (const file of fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))) {
    const base = path.basename(file, path.extname(file));
    // "Name@240x170" lets one file carry its real size.
    const m = base.match(/^(.*?)@(\d+)x(\d+)$/);
    const name = (m ? m[1] : base).trim();
    const w = m ? Number(m[2]) : spec.size.w;
    const second = m ? Number(m[3]) : (kind === "rugs" ? spec.size.d : spec.size.h);

    if (existing.has(name.toLowerCase())) {
      skipped++;
      continue;
    }

    const ext = path.extname(file) || ".png";
    const thumb = `${crypto.randomUUID()}${ext}`;
    console.log(`  ${kind.padEnd(4)} ${name.padEnd(30)} ${w}x${second}cm`);
    if (APPLY) {
      fs.mkdirSync(THUMBS, { recursive: true });
      fs.copyFileSync(path.join(dir, file), path.join(THUMBS, thumb));
      await db.execute({
        sql: `INSERT INTO Product
          (id, name, category, description, priceInr, styleTags, widthCm, depthCm, heightCm,
           status, thumbnailUrl, modelUrl, frontYaw, mount, aiTags)
          VALUES (?,?,?,NULL,?,?,?,?,?,'READY',?,NULL,0,?,?)`,
        args: [
          crypto.randomUUID(),
          name,
          spec.category,
          spec.price,
          JSON.stringify([]),
          w,
          kind === "rugs" ? second : spec.size.d,
          kind === "rugs" ? spec.size.h : second,
          `/api/files/thumbnails/${thumb}`,
          spec.mount,
          JSON.stringify(spec.tags),
        ],
      });
    }
    added++;
  }
}

console.log(`\n${added} flat products ${APPLY ? "added" : "to add"}, ${skipped} already present.`);
if (!APPLY) console.log("Dry run — pass --apply to write.");
