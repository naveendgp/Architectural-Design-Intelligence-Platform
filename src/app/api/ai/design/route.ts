import { designPlan, GeminiQuotaError, type CatalogEntry } from "@/lib/gemini";
import { listProducts } from "@/lib/repo";

export const runtime = "nodejs";

/* POST { image: dataURL, request, placed[] } -> design plan
   The intent layer behind the AI Designer: reads a free-form request ("make this
   lobby a modern waiting area under ₹5 lakh") against the room photo and the real
   catalog, and returns the pieces to add. The catalog is read server-side so ids
   are authoritative, and the budget is re-enforced here rather than trusted to
   the model's arithmetic. */
export async function POST(req: Request) {
  let payload: {
    image?: string;
    request?: string;
    placed?: { name: string; qty: number }[];
    capacity?: { floorAreaM2: number; freeFloorM2: number };
    stage?: "room" | "furniture";
  };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { image, request: userRequest, placed, capacity, stage } = payload;
  if (!image || typeof image !== "string" || !image.startsWith("data:")) {
    return Response.json({ error: "image data URL required" }, { status: 400 });
  }
  if (!userRequest || typeof userRequest !== "string" || !userRequest.trim()) {
    return Response.json({ error: "request required" }, { status: 400 });
  }

  const match = image.match(/^data:(image\/\w+);base64,(.+)$/s);
  if (!match) {
    return Response.json({ error: "unsupported image encoding" }, { status: 400 });
  }
  const [, mime, b64] = match;
  const buffer = Buffer.from(b64, "base64");

  // Only READY products with a usable 3D model can actually be placed.
  const products = (await listProducts()).filter((p) => p.status === "READY" && p.modelUrl);
  if (products.length === 0) {
    return Response.json({ error: "catalog is empty", code: "empty" }, { status: 409 });
  }

  const catalog: CatalogEntry[] = products.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    styleTags: p.styleTags,
    priceInr: p.priceInr,
    widthCm: p.widthCm,
    depthCm: p.depthCm,
    heightCm: p.heightCm,
    mount: p.mount,
  }));

  try {
    const plan = await designPlan(
      buffer,
      mime,
      userRequest.trim(),
      catalog,
      Array.isArray(placed) ? placed : [],
      capacity && Number.isFinite(capacity.freeFloorM2) ? capacity : undefined,
      stage === "room" ? "room" : "furniture",
    );

    // Resolve to real products and enforce the budget here. Lines are kept in the
    // model's own priority order and dropped from the end once the cap is hit, so
    // the most important pieces survive.
    const byId = new Map(products.map((p) => [p.id, p] as const));
    const lines: {
      product: (typeof products)[number];
      qty: number;
      reason: string;
      subtotalInr: number;
    }[] = [];
    let totalInr = 0;
    let trimmed = false;

    for (const item of plan.items) {
      const product = byId.get(item.productId);
      if (!product) continue;
      let qty = item.qty;
      if (plan.budgetInr > 0) {
        const affordable = Math.floor((plan.budgetInr - totalInr) / Math.max(1, product.priceInr));
        if (affordable <= 0) {
          trimmed = true;
          continue;
        }
        if (affordable < qty) {
          qty = affordable;
          trimmed = true;
        }
      }
      const subtotalInr = product.priceInr * qty;
      totalInr += subtotalInr;
      lines.push({ product, qty, reason: item.reason, subtotalInr });
    }

    return Response.json({
      intent: plan.intent,
      reply: plan.reply,
      surfaceOptions: plan.surfaceOptions ?? null,
      clearInstruction: plan.clearInstruction ?? null,
      offTopic: plan.offTopic,
      budgetInr: plan.budgetInr,
      totalInr,
      trimmed,
      items: lines,
    });
  } catch (err) {
    if (err instanceof GeminiQuotaError) {
      return Response.json({ error: err.message, code: "quota" }, { status: 402 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "design planning failed" },
      { status: 502 },
    );
  }
}
