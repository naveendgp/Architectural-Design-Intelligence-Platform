/* Give every product the machine-facing labels the designer and the placement
   engine reason with. Shoppers never see these.

   Names were carrying this job and failing: "Conference Table", "Marble Morning
   Dining Table" and "Urban Walnut C Table" all read as "table", so a boardroom
   table could be proposed as a bedside and a chair could be tucked under the
   "Dome Marble Table Lamp".

   Vocabulary
     role:*   what the piece IS, functionally — the key the designer matches on
     room:*   rooms it belongs in (omit when it suits any)
     place:*  how it wants to be seated: wall | free | on-surface | ceiling | beside-seating
     pairs:*  what it belongs next to (a task chair pairs with a desk)

   Usage: node scripts/tag-catalog.mjs [--apply]  */

import fs from "fs";
import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");
const env = fs.readFileSync(".env", "utf8");
const url = (env.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? "file:./dev.db").trim().replace(/^["']|["']$/g, "");
const db = createClient({ url });

/* Ordered rules — the FIRST match wins, so put the specific before the general
   ("executive desk" before "table"). Matched against the product name. */
const RULES = [
  // ── work surfaces ───────────────────────────────────────────────────────
  [/boardroom|conference/i, ["role:meeting-table", "room:office", "room:meeting", "place:free", "pairs:task-chair"]],
  [/round meeting|meeting table/i, ["role:meeting-table", "room:office", "room:meeting", "place:free", "pairs:task-chair"]],
  [/l-shape.*desk|executive desk|desk with pedestal|executive warmth desk|warm modern executive desk/i,
    ["role:desk", "room:office", "place:wall", "pairs:task-chair"]],
  [/height adjustable desk|workspace desk|minimalist desk|study desk|study table/i,
    ["role:desk", "room:office", "place:wall", "pairs:task-chair"]],
  [/dining table/i, ["role:dining-table", "room:dining", "place:free", "pairs:dining-chair"]],
  [/coffee table|round coffee/i, ["role:coffee-table", "room:living", "place:beside-seating"]],
  [/side table|c table|drum table|pedestal side/i, ["role:side-table", "place:beside-seating"]],
  [/media (console|wall unit)|tv unit|media unit/i, ["role:media-unit", "room:living", "place:wall"]],
  [/nightstand|bedside/i, ["role:side-table", "room:bedroom", "place:wall", "pairs:bed"]],
  [/console/i, ["role:console", "place:wall"]],

  // ── seating ─────────────────────────────────────────────────────────────
  [/task chair|ergomesh|mesh.*chair|executive chair|executive comfort/i,
    ["role:task-chair", "room:office", "place:free", "pairs:desk"]],
  [/dining chair/i, ["role:dining-chair", "room:dining", "place:free", "pairs:dining-table"]],
  [/counter stool|stool/i, ["role:stool", "place:free"]],
  [/recliner/i, ["role:lounge-chair", "room:living", "place:free"]],
  [/wingback|armchair|crescent chair|serenity chair|reading nook|accent chair|sculptural/i,
    ["role:lounge-chair", "room:living", "place:free"]],
  [/sectional|modular lounge|u-shape|l-shape leather/i, ["role:sofa", "room:living", "place:wall"]],
  [/sofa|chesterfield/i, ["role:sofa", "room:living", "place:wall"]],

  // ── sleeping ────────────────────────────────────────────────────────────
  [/bed$|bed\b/i, ["role:bed", "room:bedroom", "place:wall"]],

  // ── storage ─────────────────────────────────────────────────────────────
  [/wardrobe/i, ["role:wardrobe", "room:bedroom", "place:wall"]],
  [/media (console|wall unit)|tv unit|media unit/i, ["role:media-unit", "room:living", "place:wall"]],
  [/sideboard/i, ["role:sideboard", "place:wall"]],
  [/dresser|chest of drawers|drawer chest|wooden chest|tall chest|chest$/i, ["role:dresser", "room:bedroom", "place:wall"]],
  [/display cabinet|crockery|shelf tower|shelf unit|storage wall|office storage/i,
    ["role:display", "place:wall"]],

  // ── lighting ────────────────────────────────────────────────────────────
  [/chandelier/i, ["role:chandelier", "place:ceiling"]],
  [/pendant/i, ["role:pendant", "place:ceiling"]],
  [/ceiling light|flush/i, ["role:ceiling-light", "place:ceiling"]],
  [/wall sconce|picture light|wall light/i, ["role:wall-light", "place:wall"]],
  [/floor lamp/i, ["role:floor-lamp", "place:beside-seating"]],
  [/table lamp|desk lamp/i, ["role:table-lamp", "place:on-surface", "pairs:desk"]],
  [/sculpture lamp|sculpture/i, ["role:decor", "place:on-surface"]],
];

const FALLBACK = {
  Sofas: ["role:sofa", "room:living", "place:wall"],
  Seating: ["role:sofa", "room:living", "place:wall"],
  Chairs: ["role:lounge-chair", "place:free"],
  Tables: ["role:side-table", "place:beside-seating"],
  Storage: ["role:sideboard", "place:wall"],
  Beds: ["role:bed", "room:bedroom", "place:wall"],
  Lighting: ["role:floor-lamp", "place:beside-seating"],
  Decor: ["role:decor", "place:on-surface"],
};

/* The name rules above are now the FALLBACK. The catalogue is tagged from each
   product's own PHOTO and measurements, because names lie: a 280x98x47cm
   "Walnut Horizon Table" matched no rule, fell through to the catch-all for
   Tables, and was labelled a side table — so the designer put a meeting table
   in a living room as the coffee table. */
const API = process.env.STUDIO_URL ?? "http://localhost:3000";

async function tagsFromPhoto(r) {
  const res = await fetch(`${API}/api/ai/tag-product`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: r.name,
      category: r.category,
      widthCm: r.widthCm,
      depthCm: r.depthCm,
      heightCm: r.heightCm,
      mount: r.mount,
      thumbnailUrl: r.thumbnailUrl,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { tags } = await res.json();
  return Array.isArray(tags) && tags.length ? tags : null;
}

/* --only="Name A,Name B" re-tags just those pieces, so a prompt correction can
   be checked against the handful it was meant to fix without paying for 105
   vision calls again. */
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice(7).split(",").map((n) => n.trim().toLowerCase()).filter(Boolean) : null;

let rows = (await db.execute(
  "SELECT id, name, category, mount, widthCm, depthCm, heightCm, thumbnailUrl FROM Product",
)).rows;
if (only) rows = rows.filter((r) => only.includes(String(r.name).toLowerCase()));
let tagged = 0;
const preview = [];
let fromPhoto = 0;
for (const r of rows) {
  const name = String(r.name);
  let tags = null;
  try {
    tags = await tagsFromPhoto(r);
    if (tags) fromPhoto++;
  } catch {
    tags = null; // fall back to the name rules below
  }
  if (!tags) {
    tags = RULES.find(([re]) => re.test(name))?.[1] ?? FALLBACK[String(r.category)] ?? ["role:decor"];
  }
  tags = [...tags];
  // A ceiling mount always wins over whatever the name suggested.
  if (String(r.mount) === "ceiling" && !tags.includes("place:ceiling")) {
    tags = tags.filter((t) => !t.startsWith("place:")).concat("place:ceiling");
  }
  preview.push(`${name.padEnd(34)} ${tags.join(" ")}`);
  if (APPLY) {
    await db.execute({ sql: "UPDATE Product SET aiTags = ? WHERE id = ?", args: [JSON.stringify(tags), r.id] });
  }
  tagged++;
}
console.log(preview.join("\n"));
console.log(`\n${tagged} products ${APPLY ? "tagged" : "would be tagged"} — ${fromPhoto} read from their photo, ${tagged - fromPhoto} from name rules.`);
if (!APPLY) console.log("Dry run — pass --apply to write.");
