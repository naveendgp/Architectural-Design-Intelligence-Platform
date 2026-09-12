import * as THREE from "three";
import type { PlacedItemDTO } from "./types";
import type { DepthField } from "./depth";

/* Pure placement math — shared by the 3D scene and the 2D measurement overlay.
   Deliberately free of React/R3F imports so it can be used anywhere.

   Each item stores a normalized anchor (ax, ay) ∈ [0,1] = where its base sits on
   the room photo. That anchor IS its screen position, which is why the overlay can
   draw labels without any projection. */

export type Calibration = {
  fov: number;
  nearDepth: number; // depth at the bottom of the frame (m)
  farDepth: number; // depth near the top of the frame (m)
  scale: number; // global size multiplier
};

export const DEFAULT_CALIB: Calibration = {
  fov: 55,
  nearDepth: 1.7,
  farDepth: 6.5,
  scale: 0.9, // 90% reads more realistic than exact metric size in these rooms
};

/** Where a piece lands when it has no valid anchor yet. */
export const FALLBACK_ANCHOR = { ax: 0.5, ay: 0.62 };

/**
 * Ceiling-mounted objects may move horizontally, but their attachment point is
 * kept inside the upper part of the room photo. This prevents a pendant from
 * being left floating halfway down a wall while preserving perspective.
 */
// Gemini now chooses the exact hang point per room, so this is only a safety guard:
// keep a ceiling fixture's canopy in the upper region of the photo (never down on
// the floor), while leaving the horizontal position and most of the vertical range
// free for the AI's decision.
export const CEILING_ANCHOR_BAND = { minX: 0.04, maxX: 0.96, minY: 0.0, maxY: 0.4 };

export function ceilingAnchor(ax: number, ay: number) {
  return {
    ax: Math.min(CEILING_ANCHOR_BAND.maxX, Math.max(CEILING_ANCHOR_BAND.minX, ax)),
    ay: Math.min(CEILING_ANCHOR_BAND.maxY, Math.max(CEILING_ANCHOR_BAND.minY, ay)),
  };
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const inRange = (v: number) => v >= 0 && v <= 1;

/* ── Scene calibration (real floor & ceiling lines, from AI room analysis) ──
   floorTop / ceilingBottom are y-samples (0..1) across x = 0..1. The base of a
   placed piece renders exactly at its anchor pixel, so "grounding" is a 2D snap:
   push a floor piece's anchor onto the floor, a ceiling piece's canopy onto the
   ceiling. Held as module state so the pure anchor helpers can use it without
   threading it through every call site (client-only rendering). */
export type SceneCalib = { floorTop: number[]; ceilingBottom: number[] };
let SCENE_CALIB: SceneCalib | null = null;
export function setSceneCalib(c: SceneCalib | null) {
  SCENE_CALIB = c;
}
export function getSceneCalib(): SceneCalib | null {
  return SCENE_CALIB;
}

/** Interpolate a y-line sampled evenly across x∈[0,1] at position ax. */
export function sampleLine(samples: number[], ax: number): number {
  if (!samples.length) return 0;
  if (samples.length === 1) return samples[0];
  const t = clamp01(ax) * (samples.length - 1);
  const i = Math.floor(t);
  if (i >= samples.length - 1) return samples[samples.length - 1];
  return samples[i] + (samples[i + 1] - samples[i]) * (t - i);
}

/**
 * Snap an anchor onto the real surface for its mount. Floor pieces: the base must
 * be at or below the floor line (never up a wall). Ceiling pieces: the canopy sits
 * within the visible ceiling band. Falls back to the old ceiling guard when no
 * calibration is available yet.
 */
export function groundAnchor(
  ax: number,
  ay: number,
  mount: "floor" | "ceiling",
): { ax: number; ay: number } {
  const calib = SCENE_CALIB;
  if (mount === "ceiling") {
    if (!calib) return ceilingAnchor(ax, ay);
    const cb = sampleLine(calib.ceilingBottom, ax);
    // Canopy on the visible ceiling strip: between the top edge and the wall line.
    return { ax: clamp01(ax), ay: Math.min(Math.max(ay, 0.02), Math.max(0.03, cb - 0.01)) };
  }
  if (!calib) return { ax, ay };
  const ft = sampleLine(calib.floorTop, ax);
  // Base must sit on the floor (below the floor line). Only push DOWN — an anchor
  // already deeper into the floor is fine.
  return { ax: clamp01(ax), ay: clamp01(Math.max(ay, ft + 0.015)) };
}

/* Widest band a floor piece may be DRAGGED to, used when there is no scene
   calibration to ground against. Looser than FLOOR_REGION (which is where
   auto-placement seats things) so a user can deliberately tuck a piece nearer an
   edge than the AI would — but never up a wall or into the ceiling. */
const DRAG_FLOOR_BAND = { minX: 0.03, maxX: 0.97, minY: 0.55, maxY: 0.97 };

/**
 * Constrain a dragged anchor to a surface its mount can actually sit on. Uses the
 * detected floor/ceiling lines when the room has been analysed, and a safe static
 * band when it hasn't — without this a sofa can be dragged onto the back wall.
 */
export function clampDragAnchor(
  ax: number,
  ay: number,
  mount: "floor" | "ceiling",
): { ax: number; ay: number } {
  if (mount === "ceiling") return groundAnchor(ax, ay, "ceiling");
  const x = Math.min(DRAG_FLOOR_BAND.maxX, Math.max(DRAG_FLOOR_BAND.minX, ax));
  const y = Math.min(DRAG_FLOOR_BAND.maxY, Math.max(DRAG_FLOOR_BAND.minY, ay));
  // With calibration, the real floor line is the authority (it may sit lower than
  // the static band in a photo where the floor starts late, e.g. a corridor).
  return SCENE_CALIB ? groundAnchor(x, y, "floor") : { ax: x, ay: y };
}

export function anchorToPoint(
  ax: number,
  ay: number,
  aspect: number,
  calib: Calibration,
  nearness: number, // 0..1 (1 = closest); from the depth map, or ay as fallback
): THREE.Vector3 {
  const ndcX = ax * 2 - 1;
  const ndcY = 1 - 2 * ay;
  const tanV = Math.tan(((calib.fov * Math.PI) / 180) / 2);
  const d = calib.farDepth + (calib.nearDepth - calib.farDepth) * nearness;
  return new THREE.Vector3(ndcX * tanV * aspect * d, ndcY * tanV * d, -d);
}

export function pointToAnchor(
  pt: THREE.Vector3,
  aspect: number,
  calib: Calibration,
): { ax: number; ay: number } {
  const tanV = Math.tan(((calib.fov * Math.PI) / 180) / 2);
  const ndcX = pt.x / (tanV * aspect * -pt.z);
  const ndcY = pt.y / (tanV * -pt.z);
  return {
    ax: (ndcX + 1) / 2,
    ay: (1 - ndcY) / 2,
  };
}

/** Normalized screen anchor of a placed item's base, snapped onto the real floor /
    ceiling surface (from scene calibration) so it renders grounded, not floating.
    Applies to existing placements too, so reopening a project auto-corrects them. */
export function itemAnchor(item: PlacedItemDTO): { ax: number; ay: number } {
  const ax = inRange(item.posX) ? item.posX : FALLBACK_ANCHOR.ax;
  const ay = inRange(item.posZ) ? item.posZ : FALLBACK_ANCHOR.ay;
  return groundAnchor(ax, ay, item.product.mount);
}

/* Depth used for a piece's anchor projection. FLOOR furniture ignores the depth
   map's Z entirely and derives its position from the screen anchor (a ground-plane
   model) so it always rests on the floor and never floats on a depth artifact.
   Ceiling fixtures still use the depth map. */
function nearnessFor(
  mount: "floor" | "ceiling",
  ax: number,
  ay: number,
  depth: DepthField | null,
): number {
  if (mount === "ceiling") return depth ? depth.sample(ax, ay) : ay;
  return ay;
}

/** World position of a placed item's base. */
export function itemWorldPos(
  item: PlacedItemDTO,
  aspect: number,
  calib: Calibration,
  depth: DepthField | null,
): THREE.Vector3 {
  const { ax, ay } = itemAnchor(item);
  const nearness = nearnessFor(item.product.mount, ax, ay, depth);
  const p = anchorToPoint(ax, ay, aspect, calib, nearness);
  return p;
}

/** World XZ of a raw anchor for a given plane (used for collision boxes). */
function groundXZ(
  ax: number,
  ay: number,
  mount: "floor" | "ceiling",
  aspect: number,
  calib: Calibration,
  depth: DepthField | null,
): { x: number; z: number } {
  const p = anchorToPoint(ax, ay, aspect, calib, nearnessFor(mount, ax, ay, depth));
  return { x: p.x, z: p.z };
}

/** Metric distance between two placed items (approximate — depth is relative). */
export function itemDistance(
  a: PlacedItemDTO,
  b: PlacedItemDTO,
  aspect: number,
  calib: Calibration,
  depth: DepthField | null,
): number {
  return itemWorldPos(a, aspect, calib, depth).distanceTo(
    itemWorldPos(b, aspect, calib, depth),
  );
}

/* ── Deterministic spacing / collision (Oriented Bounding Boxes + SAT) ──────
   Furniture is rectangular, so we model each footprint as an oriented bounding
   box (OBB) in the world XZ plane — centre, half-width/half-depth, and yaw — and
   test intersection with the Separating Axis Theorem. This is exact for rotated
   rectangles, unlike a bounding circle which over-rejects long/thin pieces. */

export type OBB = { cx: number; cz: number; hw: number; hd: number; angle: number };

/** Footprint of a not-yet-placed piece. */
export type FootprintSpec = {
  widthCm: number | null;
  depthCm: number | null;
  scale: number;
  yawDeg: number;
  mount: "floor" | "ceiling";
};

const GAP_M = 0.08; // ~8 cm clearance kept between pieces

function halfExtents(widthCm: number | null, depthCm: number | null, scale: number, calib: Calibration) {
  return {
    hw: (((widthCm ?? 100) / 100) * scale * calib.scale) / 2,
    hd: (((depthCm ?? 100) / 100) * scale * calib.scale) / 2,
  };
}

/** The four world-XZ corners of an OBB. */
function obbCorners(o: OBB): { x: number; z: number }[] {
  const c = Math.cos(o.angle);
  const s = Math.sin(o.angle);
  const ux = { x: c, z: s }; // local width axis in world
  const uz = { x: -s, z: c }; // local depth axis in world
  return [
    { x: o.cx + ux.x * o.hw + uz.x * o.hd, z: o.cz + ux.z * o.hw + uz.z * o.hd },
    { x: o.cx + ux.x * o.hw - uz.x * o.hd, z: o.cz + ux.z * o.hw - uz.z * o.hd },
    { x: o.cx - ux.x * o.hw + uz.x * o.hd, z: o.cz - ux.z * o.hw + uz.z * o.hd },
    { x: o.cx - ux.x * o.hw - uz.x * o.hd, z: o.cz - ux.z * o.hw - uz.z * o.hd },
  ];
}

/** True if `axis` separates the two corner sets (their projections don't overlap). */
function separates(ca: { x: number; z: number }[], cb: { x: number; z: number }[], axis: { x: number; z: number }): boolean {
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const p of ca) {
    const d = p.x * axis.x + p.z * axis.z;
    if (d < minA) minA = d;
    if (d > maxA) maxA = d;
  }
  for (const p of cb) {
    const d = p.x * axis.x + p.z * axis.z;
    if (d < minB) minB = d;
    if (d > maxB) maxB = d;
  }
  return maxA < minB || maxB < minA;
}

/** OBB–OBB intersection via the Separating Axis Theorem (2D, XZ plane). */
export function obbOverlap(a: OBB, b: OBB): boolean {
  const ca = obbCorners(a);
  const cb = obbCorners(b);
  const axes = [
    { x: Math.cos(a.angle), z: Math.sin(a.angle) },
    { x: -Math.sin(a.angle), z: Math.cos(a.angle) },
    { x: Math.cos(b.angle), z: Math.sin(b.angle) },
    { x: -Math.sin(b.angle), z: Math.cos(b.angle) },
  ];
  for (const ax of axes) if (separates(ca, cb, ax)) return false;
  return true; // no separating axis → the rectangles overlap
}

/** OBB footprint of a placed item, oriented by its full render yaw. */
export function itemOBB(item: PlacedItemDTO, aspect: number, calib: Calibration, depth: DepthField | null): OBB {
  const { ax, ay } = itemAnchor(item);
  const { x, z } = groundXZ(ax, ay, item.product.mount, aspect, calib, depth);
  const { hw, hd } = halfExtents(item.product.widthCm, item.product.depthCm, item.scale, calib);
  const angle = ((item.product.frontYaw + (depth?.roomYawDeg ?? 0) + item.rotationY) * Math.PI) / 180;
  return { cx: x, cz: z, hw, hd, angle };
}

/** OBB footprint of a candidate placement (inflated by the clearance gap). */
function specOBB(ax: number, ay: number, spec: FootprintSpec, aspect: number, calib: Calibration, depth: DepthField | null): OBB {
  const { x, z } = groundXZ(ax, ay, spec.mount, aspect, calib, depth);
  const { hw, hd } = halfExtents(spec.widthCm, spec.depthCm, spec.scale, calib);
  return { cx: x, cz: z, hw: hw + GAP_M, hd: hd + GAP_M, angle: (spec.yawDeg * Math.PI) / 180 };
}

/** Rough footprint area (m²) — used only to order pieces (largest seated first). */
export function footprintAreaM2(spec: { widthCm: number | null; depthCm: number | null; scale: number }, calib: Calibration): number {
  const { hw, hd } = halfExtents(spec.widthCm, spec.depthCm, spec.scale, calib);
  return 4 * hw * hd;
}

/**
 * Usable floor of the room in m², and how much of it is still free.
 *
 * The AI planner used to eyeball capacity from the photo, which is why it would
 * propose a five-piece lounge set for a narrow lift lobby. This measures the same
 * floor the placement engine actually packs into, so the planner can be told a
 * real number instead of guessing.
 *
 * The floor band is a rectangle in image space but a trapezoid in world space
 * (perspective), so the corners are projected and the area taken by shoelace.
 */
export function floorCapacity(
  placed: PlacedItemDTO[],
  aspect: number,
  calib: Calibration,
  depth: DepthField | null,
  obstacles: OBB[] = [],
  region: Region = floorRegion(),
): { totalM2: number; freeM2: number } {
  const corners: { x: number; z: number }[] = [
    groundXZ(region.minX, region.minY, "floor", aspect, calib, depth),
    groundXZ(region.maxX, region.minY, "floor", aspect, calib, depth),
    groundXZ(region.maxX, region.maxY, "floor", aspect, calib, depth),
    groundXZ(region.minX, region.maxY, "floor", aspect, calib, depth),
  ];
  let twice = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    twice += a.x * b.z - b.x * a.z;
  }
  const totalM2 = Math.abs(twice) / 2;

  let used = 0;
  for (const it of placed) {
    if (it.product.mount === "ceiling") continue;
    used += footprintAreaM2(
      { widthCm: it.product.widthCm, depthCm: it.product.depthCm, scale: it.scale },
      calib,
    );
  }
  // Detected real objects (existing sofas, a wheelchair…) also eat floor.
  for (const o of obstacles) used += 4 * o.hw * o.hd;

  return { totalM2, freeM2: Math.max(0, totalM2 - used) };
}

/** A real floor object detected by segmentation: normalized image box (top-left). */
export type FloorObjectBox = { label: string; x0: number; y0: number; x1: number; y1: number };

/**
 * Convert a detected floor-object's image box into a world-XZ obstacle OBB. The
 * object's floor contact is its bottom edge; its world width comes from the box's
 * horizontal span at that line, and depth is assumed ~square (a 2D box can't reveal
 * how far it extends into the room).
 */
export function objectBoxToOBB(
  box: FloorObjectBox,
  aspect: number,
  calib: Calibration,
  depth: DepthField | null,
): OBB {
  const axc = (box.x0 + box.x1) / 2;
  const ayb = box.y1; // bottom edge = where it meets the floor
  const c = groundXZ(axc, ayb, "floor", aspect, calib, depth);
  const left = groundXZ(box.x0, ayb, "floor", aspect, calib, depth);
  const right = groundXZ(box.x1, ayb, "floor", aspect, calib, depth);
  // 2D box can't reveal room depth. Keep the footprint generous so we don't
  // accidentally spawn huge furniture inside real objects like wheelchairs!
  const hw = Math.max(0.15, (Math.hypot(right.x - left.x, right.z - left.z) / 2) * 0.95);
  // Assume objects are roughly as deep as they are wide, up to a reasonable max
  const hd = Math.min(hw, 0.8);
  return { cx: c.x, cz: c.z, hw, hd, angle: 0 };
}

/**
 * True if a piece with `spec` at anchor (ax, ay) would overlap any of `others`.
 * Only same-plane pieces should be passed (floor vs floor / ceiling vs ceiling) —
 * a pendant above a sofa is fine.
 */
export function anchorOverlaps(
  ax: number,
  ay: number,
  spec: FootprintSpec,
  others: PlacedItemDTO[],
  aspect: number,
  calib: Calibration,
  depth: DepthField | null,
  obstacles: OBB[] = [],
): boolean {
  const g = groundAnchor(ax, ay, spec.mount); // test where it will actually land
  const box = specOBB(g.ax, g.ay, spec, aspect, calib, depth);
  for (const it of others) {
    if (obbOverlap(box, itemOBB(it, aspect, calib, depth))) return true;
  }
  // Real floor objects (from segmentation) block floor pieces only.
  if (spec.mount === "floor") {
    for (const ob of obstacles) if (obbOverlap(box, ob)) return true;
  }
  return false;
}

export type Region = { minX: number; maxX: number; minY: number; maxY: number };
// Usable floor band on the photo. The camera looks straight ahead, so the floor is
// the LOWER portion of the frame — an anchor above ~0.5 maps to above the camera
// line and would float. Keep floor pieces comfortably below that so their base sits
// on the ground, not up a wall.
export const FLOOR_REGION: Region = { minX: 0.1, maxX: 0.9, minY: 0.64, maxY: 0.92 };

/**
 * The floor this particular room actually has.
 *
 * FLOOR_REGION above is a deliberately timid fallback sized so furniture can't
 * float when we know nothing about the room — but it describes the same ~4m²
 * strip whether the photo shows a cramped corner or a wide empty hall, which
 * made the planner offer a single accent chair for a clearly spacious room.
 * Once the room has been analysed we know where the floor really starts, so use
 * it: take the LOWEST detected floor start across the width, so every column of
 * the band is genuinely floor rather than wall.
 */
export function floorRegion(): Region {
  const calib = SCENE_CALIB;
  if (!calib?.floorTop?.length) return FLOOR_REGION;
  // MEDIAN, not max: one column where the floor starts late (a tall object at the
  // frame edge) would otherwise collapse the whole band — it measured a wide empty
  // room at 1.9m². Per-column grounding in groundAnchor keeps individual pieces
  // off the wall, so the band itself only needs to describe the typical floor.
  const sorted = [...calib.floorTop].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return FLOOR_REGION;
  const median = sorted[Math.floor(sorted.length / 2)];
  const minY = Math.min(0.8, Math.max(0.35, median + 0.015));
  return { minX: 0.06, maxX: 0.94, minY, maxY: 0.96 };
}

/**
 * Find a spot with no overlap, starting from a preferred anchor and spiralling
 * outward within `region`. Returns null when the space is genuinely full — the
 * signal the UI uses to say "no room for this piece". Vertical steps are damped
 * because moving down the photo (nearer the camera) changes scale/spacing fast.
 */
export function findFreeAnchor(
  preferAx: number,
  preferAy: number,
  spec: FootprintSpec,
  others: PlacedItemDTO[],
  aspect: number,
  calib: Calibration,
  depth: DepthField | null,
  region: Region = floorRegion(),
  obstacles: OBB[] = [],
): { ax: number; ay: number } | null {
  const inRegion = (x: number, y: number) =>
    x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY;
  const clampToRegion = (x: number, y: number) => ({
    ax: Math.min(region.maxX, Math.max(region.minX, x)),
    ay: Math.min(region.maxY, Math.max(region.minY, y)),
  });

  const start = clampToRegion(preferAx, preferAy);
  // Return the GROUNDED anchor so the stored spot matches where the base renders.
  if (!anchorOverlaps(start.ax, start.ay, spec, others, aspect, calib, depth, obstacles))
    return groundAnchor(start.ax, start.ay, spec.mount);

  // Expanding rings around the preferred point.
  for (let ring = 1; ring <= 10; ring++) {
    const rad = ring * 0.05;
    for (let a = 0; a < 360; a += 20) {
      const t = (a * Math.PI) / 180;
      const ax = preferAx + Math.cos(t) * rad;
      const ay = preferAy + Math.sin(t) * rad * 0.6; // damp vertical
      if (!inRegion(ax, ay)) continue;
      if (!anchorOverlaps(ax, ay, spec, others, aspect, calib, depth, obstacles))
        return groundAnchor(ax, ay, spec.mount);
    }
  }
  return null; // no free spot — room is full
}

/** Build a FootprintSpec from a placed item (its real orientation + size). */
export function itemSpec(item: PlacedItemDTO, depth: DepthField | null): FootprintSpec {
  return {
    widthCm: item.product.widthCm,
    depthCm: item.product.depthCm,
    scale: item.scale,
    yawDeg: item.product.frontYaw + (depth?.roomYawDeg ?? 0) + item.rotationY,
    mount: item.product.mount,
  };
}

/**
 * Re-pack every placed item into a non-overlapping layout. Floor and ceiling are
 * solved independently; within each plane the largest pieces are seated first
 * (they need the most room), each near its current spot, checked against the ones
 * already re-seated. Returns the new anchor for every item (unchanged ones keep
 * their spot). Pure geometry — no network, safe to run on demand.
 */
export function rearrangeAnchors(
  items: PlacedItemDTO[],
  aspect: number,
  calib: Calibration,
  depth: DepthField | null,
  obstacles: OBB[] = [],
): { anchors: { id: string; ax: number; ay: number }[]; unplaced: number } {
  const anchors: { id: string; ax: number; ay: number }[] = [];
  let unplaced = 0;

  for (const plane of ["floor", "ceiling"] as const) {
    const region = plane === "ceiling" ? CEILING_ANCHOR_BAND : floorRegion();
    const planeObstacles = plane === "floor" ? obstacles : []; // real objects block floor only
    const group = items.filter((it) => it.product.mount === plane);
    const sorted = [...group].sort(
      (a, b) =>
        footprintAreaM2({ widthCm: b.product.widthCm, depthCm: b.product.depthCm, scale: b.scale }, calib) -
        footprintAreaM2({ widthCm: a.product.widthCm, depthCm: a.product.depthCm, scale: a.scale }, calib),
    );

    const seated: PlacedItemDTO[] = [];
    for (const it of sorted) {
      const cur = itemAnchor(it);
      const spec = itemSpec(it, depth);
      // Prefer a spot clear of real floor objects, but treat those as SOFT: if none
      // is free, fall back to avoiding only other placed items. Loose segmentation
      // boxes must never cause a false "over capacity".
      const free =
        findFreeAnchor(cur.ax, cur.ay, spec, seated, aspect, calib, depth, region, planeObstacles) ??
        findFreeAnchor(cur.ax, cur.ay, spec, seated, aspect, calib, depth, region, []);
      if (!free) unplaced++; // genuinely over capacity (placed items alone don't fit)
      const anchor = free ?? cur; // keep current spot if nothing is free
      seated.push({ ...it, posX: anchor.ax, posZ: anchor.ay });
      anchors.push({ id: it.id, ax: anchor.ax, ay: anchor.ay });
    }
  }
  return { anchors, unplaced };
}
