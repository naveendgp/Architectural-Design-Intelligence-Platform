/* Give every image-only PREVIEW listing a stand-in 3D model.

   The catalogue listings imported from the furniture photos have no model of
   their own yet, but a demo needs them to DO something when clicked. So each one
   borrows the geometry of the closest real model we already own -- same mount,
   same (or related) category, nearest width -- while keeping its own photo,
   name, price and real-world dimensions.

   The listing still reads PREVIEW, so the AI designer keeps planning only with
   genuine models and the UI can label it honestly. When the real model lands,
   point modelUrl at it and flip status to READY.

   Width stays the anchor the renderer scales by, so a borrowed sofa fills the
   width this product is sold at; depth and height are then re-derived from the
   stand-in's own proportions (run sync-product-dims afterwards) so the collision
   footprint matches what is drawn.

   Usage: node scripts/assign-standin-models.mjs [--apply] */

import fs from "fs";
import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");
const env = fs.readFileSync(".env", "utf8");
const url = (env.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? "file:./dev.db")
  .trim()
  .replace(/^["']|["']$/g, "");
const db = createClient({ url });

// Where to look for a stand-in, in order of preference.
const RELATED = {
  Sofas: ["Sofas", "Seating"],
  Seating: ["Seating", "Sofas"],
  Chairs: ["Chairs", "Seating"],
  Tables: ["Tables"],
  Storage: ["Storage", "Tables"],
  Beds: ["Beds", "Sofas"],
  Lighting: ["Lighting"],
  Decor: ["Lighting", "Tables"],
};

const rows = (await db.execute("SELECT * FROM Product")).rows;
const donors = rows.filter((r) => r.modelUrl && r.status === "READY");
const targets = rows.filter((r) => r.status === "PREVIEW");

console.log(`${donors.length} real models available, ${targets.length} preview listings`);

let done = 0;
const picks = [];
for (const t of targets) {
  const order = RELATED[t.category] ?? [t.category];
  let pool = [];
  for (const cat of order) {
    pool = donors.filter((d) => d.category === cat && d.mount === t.mount);
    if (pool.length) break;
  }
  if (!pool.length) pool = donors.filter((d) => d.mount === t.mount);
  if (!pool.length) {
    console.log(`  no stand-in for ${t.name} (${t.category}/${t.mount})`);
    continue;
  }
  // Closest in width reads most naturally once the renderer scales to width.
  const best = pool.reduce((a, b) =>
    Math.abs((b.widthCm ?? 100) - (t.widthCm ?? 100)) <
    Math.abs((a.widthCm ?? 100) - (t.widthCm ?? 100))
      ? b
      : a,
  );
  picks.push(`${t.name}  ←  ${best.name}`);
  if (APPLY) {
    await db.execute({
      sql: "UPDATE Product SET modelUrl = ?, frontYaw = ? WHERE id = ?",
      args: [best.modelUrl, best.frontYaw ?? 0, t.id],
    });
  }
  done++;
}

console.log(picks.slice(0, 12).join("\n"));
console.log(`...\n${done} listings ${APPLY ? "given" : "would get"} a stand-in model.`);
if (!APPLY) console.log("Dry run — pass --apply to write.");
