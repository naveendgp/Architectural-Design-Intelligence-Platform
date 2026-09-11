/* Thin server-side wrapper over the Gemini REST API. Keep the key server-side —
   only import this from route handlers, never a client component (it reads
   process.env.GEMINI_API_KEY). */

// Stable alias that always points at the current Gemini Flash (cheap vision).
const MODEL = "gemini-3.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Shared low-level call: send an image + text, ask for a typed JSON object back.
async function generateJson(
  image: Buffer,
  mimeType: string,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: image.toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    throw new GeminiQuotaError("Gemini quota exceeded — check billing/rate limits.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = await res.json();
  const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");
  return JSON.parse(text) as Record<string, unknown>;
}

export type ItemToPlace = {
  name: string;
  category: string;
  mount: "floor" | "ceiling";
  widthCm: number | null;
  depthCm: number | null;
  heightCm: number | null;
};

export type PlacedSummary = {
  name: string;
  mount: "floor" | "ceiling";
  ax: number;
  ay: number;
};

export type PlacementSpot = {
  ax: number;
  ay: number;
  facingDeg: number;
  confidence?: number;
};

export type PlacementPlan = {
  fits: boolean;
  reason: string;
  ax: number;
  ay: number;
  facingDeg: number;
  confidence: number;
  spots?: PlacementSpot[];
};

/**
 * Decide where a new piece should go in a room, given a screenshot of the room
 * WITH the furniture already placed in it. Returns a normalized anchor (top-left
 * origin), the facing angle, and whether there is actually room for it.
 *
 * facingDeg: 0 = the piece's front faces the camera/viewer, +90 = faces to the
 * right of the image, 180 = faces away (front toward the back wall), 270 = faces
 * left. For floor furniture this orients it against the natural wall/layout; for
 * ceiling fixtures it is ignored by the caller.
 */
export async function placeItem(
  image: Buffer,
  mimeType: string,
  item: ItemToPlace,
  placed: PlacedSummary[],
): Promise<PlacementPlan> {
  const size = [item.widthCm && `${item.widthCm}cm wide`, item.depthCm && `${item.depthCm}cm deep`, item.heightCm && `${item.heightCm}cm tall`]
    .filter(Boolean)
    .join(", ");
  const placedList = placed.length
    ? placed
        .map((p) => `- ${p.name} (${p.mount}) at x=${p.ax.toFixed(2)}, y=${p.ay.toFixed(2)}`)
        .join("\n")
    : "- (none yet)";

  const ceiling = item.mount === "ceiling";
  const prompt = `You are an interior designer placing a new item into this room.
The image shows the room AS IT LOOKS NOW, including any furniture and lights already
placed. Coordinates are normalized: 0,0 = TOP-LEFT, 1,1 = BOTTOM-RIGHT.

New item to place: "${item.name}" — a ${item.category} (${item.mount}-mounted)${size ? `, ${size}` : ""}.

Items already in the room:
${placedList}

Decide the best spot for the new item. Rules:
${ceiling
  ? `- This is a CEILING fixture. Return the point on the visible ceiling where its
  canopy attaches (near the top of the image), centered over the main open/seating
  area and not overlapping an existing ceiling light.
- facingDeg is not important for a ceiling light; return 0.`
  : `- This sits on the FLOOR. Return up to 4 good candidate spots for floor-mounted furniture, ordered from best to worst.
- Each spot should return the point where the item's base CONTACTS THE FLOOR — i.e. the floor pixel the piece would stand on, NOT the object's mid-height and NOT a point on a wall. This point must be on the visible FLOOR SURFACE, which is the lower part of the photo; ay should be roughly 0.6–0.9 (well below the midline). Never return a point up on a wall or in the upper half of the image.
- Place it in a realistic, usable OPEN area of the floor — against or near a wall as appropriate for a ${item.category}, not floating in a walkway.
- CRITICAL: do NOT place it on top of anything already visible in the photo — avoid existing real furniture, sofas, chairs, tables, a wheelchair, or any occupied floor. Choose genuinely empty floor; if clear floor is limited, pick the largest empty gaps.`}
- fits: set false ONLY if the room is genuinely too crowded to add this item
  without overlapping existing pieces or blocking movement. If false, give a short
  human-readable reason and still return your best-guess coordinates.`;

  const parsed = await generateJson(image, mimeType, prompt, {
    type: "object",
    properties: {
      fits: { type: "boolean" },
      reason: { type: "string" },
      ax: { type: "number", description: "horizontal 0..1" },
      ay: { type: "number", description: "vertical 0..1" },
      confidence: { type: "number", description: "0..1" },
      spots: {
        type: "array",
        description: "Up to 4 candidate spots for floor items, best to worst.",
        items: {
          type: "object",
          properties: {
            ax: { type: "number" },
            ay: { type: "number" },
            confidence: { type: "number" },
          },
          required: ["ax", "ay"],
        },
      },
    },
    required: ["fits", "ax", "ay", "confidence"],
  });

  if (typeof parsed.ax !== "number" || typeof parsed.ay !== "number") {
    throw new Error("Gemini returned malformed coordinates");
  }
  let spots: PlacementSpot[] | undefined = undefined;
  if (Array.isArray(parsed.spots)) {
    spots = parsed.spots
      .filter((s: any) => typeof s.ax === "number" && typeof s.ay === "number")
      .map((s: any) => ({
        ax: clamp01(s.ax as number),
        ay: clamp01(s.ay as number),
        facingDeg: 0,
        confidence: typeof s.confidence === "number" ? clamp01(s.confidence) : undefined,
      }));
  }

  return {
    fits: parsed.fits !== false,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    ax: clamp01(parsed.ax as number),
    ay: clamp01(parsed.ay as number),
    facingDeg: 0,
    confidence: clamp01((parsed.confidence as number) ?? 0.5),
    spots,
  };
}

/* ── Design planner ───────────────────────────────────────────────────────────
   Turns a free-form request ("convert this lift lobby into a modern office
   waiting area, under ₹5 lakh") into a concrete list of catalog pieces. This is
   the intent layer: the model sees the actual room photo AND the marketplace, so
   it can judge what the space is, what it needs, and what actually fits. */

export type CatalogEntry = {
  id: string;
  name: string;
  category: string;
  styleTags: string[];
  priceInr: number;
  widthCm: number | null;
  depthCm: number | null;
  heightCm: number | null;
  mount: "floor" | "ceiling";
};

export type DesignPlanItem = { productId: string; qty: number; reason: string };

export type DesignPlan = {
  /** Short label of what the model understood, e.g. "Modern office waiting area". */
  intent: string;
  /** Conversational reply shown above the plan card. */
  reply: string;
  items: DesignPlanItem[];
  /** Budget parsed out of the request, in rupees; 0 when none was given. */
  budgetInr: number;
  /** True when the request wasn't about furniture at all (chat falls back). */
  offTopic: boolean;
};

const MAX_PLAN_LINES = 8;
const MAX_QTY_PER_LINE = 6;

/**
 * Read a free-form design request against the real room photo and the real
 * catalog, and return the pieces to add. Only ever returns ids that exist in
 * `catalog`; quantities and budget are re-validated by the caller.
 */
export async function designPlan(
  image: Buffer,
  mimeType: string,
  request: string,
  catalog: CatalogEntry[],
  placed: { name: string; qty: number }[],
): Promise<DesignPlan> {
  const catalogList = catalog
    .map((p) => {
      const dims = [p.widthCm && `${p.widthCm}w`, p.depthCm && `${p.depthCm}d`, p.heightCm && `${p.heightCm}h`]
        .filter(Boolean)
        .join("×");
      const styles = p.styleTags.length ? ` [${p.styleTags.join("/")}]` : "";
      return `- id=${p.id} | "${p.name}" | ${p.category} | ${p.mount}-mounted | ₹${p.priceInr}${dims ? ` | ${dims}cm` : ""}${styles}`;
    })
    .join("\n");

  const placedList = placed.length
    ? placed.map((p) => `- ${p.qty} × ${p.name}`).join("\n")
    : "- (room is empty)";

  const prompt = `You are an interior designer furnishing a real room from a real product catalog.

THE ROOM: the attached photo is the actual space. Study it first — what kind of
space is it (lobby, corridor, living room, office, bedroom)? How wide is the
usable floor? Is it a narrow walkway or an open area? Where would people
naturally sit, walk, or wait?

ALREADY IN THE ROOM:
${placedList}

THE CATALOG — you may ONLY choose from these, using the exact id string:
${catalogList}

THE REQUEST: "${request}"

Your job: understand what the user actually WANTS, then choose the pieces from
the catalog that deliver it. The request is often a goal, not a shopping list —
"convert this lift lobby into a modern office waiting area" means you decide that
a waiting area needs seating, a side/coffee table, and some lighting, and you
pick the specific catalog pieces that suit the space and style.

RULES:
- Choose real ids from the catalog above. Never invent an id or a product name.
- Match the STYLE the user asked for (modern, classical, luxury, minimal) using
  each product's style tags, and match the room you can see in the photo.
- Respect the SPACE. Read the floor area in the photo and only specify what
  physically fits with walking room left over. A narrow corridor or lift lobby
  fits perhaps 2-4 small pieces against the walls — NOT a full living-room set.
  Use each product's cm dimensions to judge this.
- BUDGET: if the request names one (e.g. "under 5 lakhs", "₹2L", "50k"), convert
  it to rupees in budgetInr (1 lakh = 100000) and keep the TOTAL of
  price × qty at or under it. If no budget is mentioned, set budgetInr to 0.
- Prefer a well-composed small set over quantity. Quantities must be sensible for
  the space: at most ${MAX_QTY_PER_LINE} of any one piece, at most ${MAX_PLAN_LINES} distinct pieces.
- Don't duplicate what the room already has unless the user asked for more.
- Ceiling-mounted fixtures only make sense if the ceiling is visible in the photo.
- reason: one short phrase per line saying why that piece (e.g. "seating for
  waiting guests", "warm light over the seating").
- reply: 1-2 friendly sentences describing the design you're proposing. Do NOT
  list prices or quantities in the reply — the UI renders those separately.
- intent: a 2-5 word label of what you understood, e.g. "Modern office waiting area".
- offTopic: set true ONLY if the request has nothing to do with furnishing or
  designing the room (e.g. "what's the weather"), and return no items.`;

  const parsed = await generateJson(image, mimeType, prompt, {
    type: "object",
    properties: {
      intent: { type: "string" },
      reply: { type: "string" },
      budgetInr: { type: "number", description: "rupees, 0 if not specified" },
      offTopic: { type: "boolean" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productId: { type: "string", description: "exact id from the catalog" },
            qty: { type: "number" },
            reason: { type: "string" },
          },
          required: ["productId", "qty"],
        },
      },
    },
    required: ["intent", "reply", "items", "offTopic"],
  });

  // Keep only ids that really exist, with sane quantities — the model is not
  // trusted to respect its own limits.
  const byId = new Map(catalog.map((p) => [p.id, p] as const));
  const seen = new Set<string>();
  const items: DesignPlanItem[] = [];
  for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
    const r = raw as { productId?: unknown; qty?: unknown; reason?: unknown };
    const id = typeof r.productId === "string" ? r.productId : "";
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    const qty = Math.min(MAX_QTY_PER_LINE, Math.max(1, Math.round(Number(r.qty) || 1)));
    items.push({ productId: id, qty, reason: typeof r.reason === "string" ? r.reason : "" });
    if (items.length >= MAX_PLAN_LINES) break;
  }

  return {
    intent: typeof parsed.intent === "string" ? parsed.intent : "",
    reply: typeof parsed.reply === "string" ? parsed.reply : "",
    items,
    budgetInr: Math.max(0, Math.round(Number(parsed.budgetInr) || 0)),
    offTopic: parsed.offTopic === true,
  };
}

export type LightingInsight = {
  sufficient: boolean;
  recommended: number;
  insight: string;
};

/**
 * Assess ambient lighting for a room from its current photo/scene and the number
 * of ceiling lights already placed. Returns a short human insight for the studio's
 * lighting panel.
 */
export async function lightingInsight(
  image: Buffer,
  mimeType: string,
  installed: number,
): Promise<LightingInsight> {
  const prompt = `You are a lighting designer. This is a photo of an empty room (its
original photo). The user has currently placed ${installed} ceiling light${installed === 1 ? "" : "s"} in it.

Judge how many ceiling lights THIS ROOM needs, based ONLY on the room itself — its
apparent size, ceiling height, and how bright or dark the space looks. Do NOT inflate
the number based on how many are already placed. Return:
- recommended: the ideal TOTAL number of ceiling lights for this room (a stable
  value that depends on the room, not on the current count).
- sufficient: true if ${installed} already meets or exceeds that total.
- insight: one short, specific sentence of advice (mention the room and whether to
  add more lights or that it is now well-lit).`;

  const parsed = await generateJson(image, mimeType, prompt, {
    type: "object",
    properties: {
      sufficient: { type: "boolean" },
      recommended: { type: "number" },
      insight: { type: "string" },
    },
    required: ["sufficient", "recommended", "insight"],
  });

  const recommended = Math.max(1, Math.round(Number(parsed.recommended) || 1));
  const isSufficient = installed >= recommended || parsed.sufficient === true;

  let finalInsight = typeof parsed.insight === "string" && parsed.insight
    ? parsed.insight
    : "Add ambient ceiling lighting suited to the room size.";

  if (isSufficient) {
    finalInsight = "The room is now well-lit with the current lighting setup.";
  }

  return {
    sufficient: isSufficient,
    recommended,
    insight: finalInsight,
  };
}

/**
 * Judge whether the 3D furniture placed in the scene looks correctly sized relative
 * to the room (and any real furniture visible), and return a single multiplier to
 * apply to furniture size: 1 = already correct, <1 = shrink (too big), >1 = grow.
 */
export async function estimateFurnitureScale(image: Buffer, mimeType: string): Promise<number> {
  const prompt = `This is a photo of a room with 3D furniture models placed into it.
Judge whether the PLACED furniture is realistically sized for this room — compare it to
the room's proportions and to any real furniture, doors, or windows visible (a 3-seater
sofa is ~2 m wide, an armchair ~0.9 m, a door ~2 m tall).

Return a single multiplier to apply to the placed furniture so it looks correctly
scaled: 1.0 means it is already right, 0.7 means it is too big and should shrink to 70%,
1.3 means it is too small. Only judge the inserted furniture, not the room.`;

  const parsed = await generateJson(image, mimeType, prompt, {
    type: "object",
    properties: {
      scaleMultiplier: { type: "number", description: "0.4..1.6; 1 = correct, <1 = shrink" },
      reason: { type: "string" },
    },
    required: ["scaleMultiplier"],
  });
  const m = Number(parsed.scaleMultiplier);
  if (!Number.isFinite(m)) return 1;
  return Math.min(1.6, Math.max(0.4, m)); // clamp to a sane range
}

export type FloorObject = { label: string; x0: number; y0: number; x1: number; y1: number };
// floorTop[i] / ceilingBottom[i] = the normalized y of the wall–floor / wall–ceiling
// line, sampled left→right at x = 0, 1/6, 2/6 … 1 (7 points). Floor is BELOW floorTop;
// ceiling is ABOVE ceilingBottom.
export type RoomAnalysis = { objects: FloorObject[]; floorTop: number[]; ceilingBottom: number[] };

/**
 * Analyze the room photo: (1) the real furniture/objects occupying FLOOR space, so
 * the engine won't place on top of them, and (2) where the floor and ceiling actually
 * are in the image, so placed pieces sit ON those surfaces instead of floating.
 * Coordinates are normalized (0..1, top-left origin). Run once per room and cache.
 */
export async function analyzeRoom(image: Buffer, mimeType: string): Promise<RoomAnalysis> {
  const prompt = `Analyze this room photo. Return THREE things.

1. objects: every real object that RESTS ON THE FLOOR and occupies floor space —
   sofas, chairs, stools, tables, cabinets on the floor, a wheelchair, floor lamps,
   large plants, boxes, etc. Each as a tight NORMALIZED bounding box (0,0 = TOP-LEFT,
   1,1 = BOTTOM-RIGHT): x0,y0 = top-left, x1,y1 = bottom-right (x1>x0, y1>y0) + a short
   label. Do NOT include wall-mounted things (TV, picture frames, AC, curtains),
   windows, doors, the ceiling, or the bare floor.

2. floorTop: an array of 7 numbers (each 0..1) giving the y of the line where the
   VISIBLE FLOOR begins — i.e. where the floor meets the back wall / far furniture —
   sampled at x = 0, 1/6, 2/6, 3/6, 4/6, 5/6, 1. Everything BELOW floorTop[i] at that
   x is floor. Trace the real floor boundary; it is usually lower on the sides and can
   rise toward the back. If the floor is hidden behind furniture at some x, estimate
   where the floor line would be.

3. ceilingBottom: an array of 7 numbers (0..1) giving the y where the CEILING meets
   the walls (the wall–ceiling line), sampled at the same 7 x positions. Everything
   ABOVE ceilingBottom[i] is ceiling. If no ceiling is visible, use small values (~0.05).`;

  const line7 = { type: "array", items: { type: "number" } };
  const parsed = await generateJson(image, mimeType, prompt, {
    type: "object",
    properties: {
      objects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            x0: { type: "number" },
            y0: { type: "number" },
            x1: { type: "number" },
            y1: { type: "number" },
          },
          required: ["label", "x0", "y0", "x1", "y1"],
        },
      },
      floorTop: line7,
      ceilingBottom: line7,
    },
    required: ["objects", "floorTop", "ceilingBottom"],
  });

  const raw = Array.isArray(parsed.objects) ? (parsed.objects as unknown[]) : [];
  const objects: FloorObject[] = [];
  for (const o of raw) {
    const r = o as Record<string, unknown>;
    const x0 = clamp01(Number(r.x0));
    const y0 = clamp01(Number(r.y0));
    const x1 = clamp01(Number(r.x1));
    const y1 = clamp01(Number(r.y1));
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
    objects.push({ label: typeof r.label === "string" ? r.label : "object", x0, y0, x1, y1 });
  }

  const clampLine = (v: unknown, fallback: number): number[] => {
    const arr = Array.isArray(v) ? (v as unknown[]).map((n) => clamp01(Number(n))) : [];
    const clean = arr.filter((n) => Number.isFinite(n));
    return clean.length >= 2 ? clean : [fallback, fallback];
  };
  return {
    objects,
    floorTop: clampLine(parsed.floorTop, 0.62),
    ceilingBottom: clampLine(parsed.ceilingBottom, 0.08),
  };
}

// Photoreal FINAL render — Nano Banana Pro (higher fidelity, pricier ~$0.134).
const RENDER_IMAGE_MODEL = "gemini-3-pro-image-preview";
// Quick room EDITS (wallpaper/curtains/paint) — cheaper/faster flash image model.
// The user re-renders with the pro model afterward, so edits don't need pro fidelity.
// NB: gemini-2.5-flash-image blocks faithful edits with IMAGE_RECITATION; the 3.1
// flash image model edits reliably and is ~2× faster than the pro model.
const EDIT_IMAGE_MODEL = "gemini-3.1-flash-image";
const imageEndpoint = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export class GeminiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiQuotaError";
  }
}

export type RenderedImage = { data: Buffer; mimeType: string };
export type RenderContext = { ceilingLights?: number };

/** Shared image-in / image-out call to a given image model. */
async function generateImage(
  image: Buffer,
  mimeType: string,
  prompt: string,
  model: string,
): Promise<RenderedImage> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const res = await fetch(imageEndpoint(model), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: image.toString("base64") } },
          ],
        },
      ],
    }),
  });

  if (res.status === 429) {
    throw new GeminiQuotaError(
      "Image generation needs billing enabled on the Gemini API key (the free tier allows 0 image requests).",
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = await res.json();
  const parts: Array<{ inlineData?: { data: string; mimeType: string }; inline_data?: { data: string; mime_type: string } }> =
    json?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data;
    if (inline?.data) {
      const mt = (p.inlineData?.mimeType ?? p.inline_data?.mime_type) || "image/png";
      return { data: Buffer.from(inline.data, "base64"), mimeType: mt };
    }
  }
  throw new Error("Gemini returned no image");
}

/**
 * Edit the room photo per a natural-language instruction (change wallpaper, remove
 * curtains, repaint walls, change flooring…). Changes ONLY what is asked and keeps the
 * room's geometry, perspective, windows, and anything else identical, so the edited
 * image can still be used as the base for furniture placement.
 */
export async function editRoomImage(
  image: Buffer,
  mimeType: string,
  instruction: string,
): Promise<RenderedImage> {
  const prompt = `You are a precise interior photo editor. This is a real photo of a
room. Apply EXACTLY ONE change to it: "${instruction}". Nothing more.

STRICT RULES — do not hallucinate:
- Do ONLY what the instruction literally says. Do NOT add, invent, or introduce any new
  object, furniture, decor, plant, rug, lamp, artwork, or texture that the instruction
  did not explicitly ask for.
- If the instruction is to REMOVE something (e.g. curtains), delete it and fill the space
  with what would realistically be behind it (the plain wall, window, or floor) — do NOT
  put a different object in its place.
- Everything the instruction did NOT mention must stay 100% identical: the room's shape
  and size, camera angle and perspective, the positions/sizes of windows, doors, and
  openings, all existing furniture and objects already in the photo, the floor plan, and
  the lighting direction. Same framing and aspect ratio.
- Keep it photorealistic and consistent with the room's real lighting and perspective —
  no cartoon look, no seams. Do NOT stylize or "3D-render" the whole image; only the one
  requested surface changes, the rest of the pixels stay as they are.

Return only the edited photograph.`;
  return generateImage(image, mimeType, prompt, EDIT_IMAGE_MODEL);
}

/**
 * Produce a faithful, physically-based photorealistic render (V-Ray/Corona style) of
 * the EXACT scene in the screenshot — same room, same furniture, same fixtures. It
 * must not invent, add, remove, move, or restyle anything; it only re-renders what is
 * there with realistic materials, global illumination, and shadows. When ceiling
 * lights are present the illumination is driven by them. Throws GeminiQuotaError on
 * 429 so the caller can tell the user to enable billing.
 */
export async function renderRealistic(
  image: Buffer,
  mimeType: string,
  ctx: RenderContext = {},
): Promise<RenderedImage> {
  const lights = ctx.ceilingLights ?? 0;
  const lightingClause =
    lights > 0
      ? `LIGHTING: The scene has ${lights} ceiling light fixture${lights === 1 ? "" : "s"} — the exact fixtures visible in the image. Treat them as the primary artificial light sources and render the room as if they are switched ON: warm, physically-plausible light emanating from each fixture, realistic falloff, soft layered shadows, gentle highlights and bounce (global illumination) on nearby surfaces. Balance this with the existing daylight from the windows. Do NOT add any light source that is not one of these fixtures or the windows.`
      : `LIGHTING: There are no ceiling fixtures placed. Light the room only with the natural daylight already coming through its windows — do not invent lamps, spotlights, or fixtures.`;

  const prompt = `You are a photorealistic architectural rendering engine (think V-Ray /
Corona). The input is a real photo of a room with furniture and light fixtures composited
into it. Output ONE photorealistic photograph of THIS EXACT SCENE.

ABSOLUTE FIDELITY — do not invent or hallucinate anything:
- Keep the SAME room: identical walls, floor, ceiling, windows, doors, curtains, wall
  art, TV, and any pre-existing real furniture — same colours, textures, and positions.
- Keep EVERY placed piece of furniture and every light fixture exactly as shown: same
  position, size, orientation, shape, colour, and material. Do NOT add new furniture,
  remove anything, move anything, resize, recolour, or restyle. No new decor, plants,
  rugs, or props. The camera angle, framing, and aspect ratio stay identical.
- If something looks like a rough 3D/pasted model, make ONLY that object read as real
  (materials, edges, contact shadow) — do not replace it with a different object.

MAKE IT PHOTOREAL (this is the only thing you change):
- Physically-based materials: correct leather/fabric/wood/metal/glass response, subtle
  reflections and micro-roughness. Accurate soft contact shadows and ambient occlusion
  where objects meet the floor and each other.
- Realistic global illumination and colour bleeding, natural white balance, no cartoon
  or over-saturated look, no visible "pasted-in" seams.

${lightingClause}

Return only the rendered image, same framing and aspect ratio as the input.`;

  return generateImage(image, mimeType, prompt, RENDER_IMAGE_MODEL);
}
