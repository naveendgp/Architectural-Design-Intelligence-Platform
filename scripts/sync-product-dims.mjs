/* Align stored product dimensions with how each model actually renders.

   room-scene scales a GLB so its X-span equals widthCm, and Meshy exports are
   normalised to a ~1.9-unit cube — so a model's rendered depth/height follow the
   MODEL's proportions, not the numbers in the database. When those disagree the
   placement engine reserves the wrong footprint: it seated a chair behind a lamp
   it believed was 60cm deep while the renderer drew it 104cm deep, and the two
   visibly overlapped.

   Width stays the anchor (it defines the render scale, so nothing resizes);
   depth and height are recomputed from the model's real aspect ratio.

   Usage: node scripts/sync-product-dims.mjs [--apply] */

import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");

const env = fs.readFileSync(".env", "utf8");
const url =
  (env.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? "file:./dev.db").trim().replace(/^["']|["']$/g, "");
const db = createClient({ url });

/** Bounding box of a .glb straight from its accessor min/max — no loader needed. */
function glbBBox(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const ai = prim.attributes?.POSITION;
      if (ai == null) continue;
      const acc = json.accessors[ai];
      if (!acc?.min || !acc?.max) continue;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], acc.min[i]);
        max[i] = Math.max(max[i], acc.max[i]);
      }
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
}

const res = await db.execute(
  "SELECT id, name, modelUrl, widthCm, depthCm, heightCm FROM Product WHERE modelUrl IS NOT NULL",
);

const changes = [];
for (const row of res.rows) {
  const file = path.join("storage", String(row.modelUrl).replace("/api/files/", ""));
  if (!fs.existsSync(file)) continue;
  const size = glbBBox(file);
  if (!size || size.x < 1e-6) continue;

  const widthCm = Number(row.widthCm) || 100;
  const fit = widthCm / 100 / size.x; // metres per model unit — what the renderer uses
  const depthCm = Math.round(size.z * fit * 100);
  const heightCm = Math.round(size.y * fit * 100);

  if (depthCm === Number(row.depthCm) && heightCm === Number(row.heightCm)) continue;
  changes.push({ id: row.id, name: row.name, from: [row.depthCm, row.heightCm], to: [depthCm, heightCm] });
}

for (const c of changes) {
  const drift = Math.abs(c.to[0] - Number(c.from[0]));
  console.log(
    `${String(c.name).padEnd(32)} depth ${String(c.from[0]).padStart(4)} → ${String(c.to[0]).padStart(4)}` +
      `   height ${String(c.from[1]).padStart(4)} → ${String(c.to[1]).padStart(4)}` +
      (drift >= 40 ? "   ← was badly off" : ""),
  );
}
console.log(`\n${changes.length} of ${res.rows.length} products need correcting.`);

if (APPLY) {
  for (const c of changes) {
    await db.execute({
      sql: "UPDATE Product SET depthCm = ?, heightCm = ? WHERE id = ?",
      args: [c.to[0], c.to[1], c.id],
    });
  }
  console.log("Applied.");
} else {
  console.log("Dry run — pass --apply to write.");
}
