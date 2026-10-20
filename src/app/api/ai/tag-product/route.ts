import fs from "node:fs/promises";
import path from "node:path";
import { classifyProductTags, GeminiQuotaError } from "@/lib/gemini";

export const runtime = "nodejs";

/* POST { name, category, widthCm, depthCm, heightCm, mount, thumbnailUrl }
   -> { tags }

   Used by scripts/tag-catalog.mjs to label the catalogue from each product's
   own photo rather than from its name. */
export async function POST(req: Request) {
  let p: Record<string, unknown>;
  try {
    p = await req.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const thumb = typeof p.thumbnailUrl === "string" ? p.thumbnailUrl : "";
  const key = thumb.replace("/api/files/", "");
  if (!key || key.includes("..")) {
    return Response.json({ error: "thumbnailUrl required" }, { status: 400 });
  }

  try {
    const file = path.join(process.cwd(), "storage", key);
    const buf = await fs.readFile(file);
    const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
    const tags = await classifyProductTags(buf, mime, {
      name: String(p.name ?? ""),
      category: String(p.category ?? ""),
      widthCm: typeof p.widthCm === "number" ? p.widthCm : null,
      depthCm: typeof p.depthCm === "number" ? p.depthCm : null,
      heightCm: typeof p.heightCm === "number" ? p.heightCm : null,
      mount: String(p.mount ?? "floor"),
    });
    return Response.json({ tags });
  } catch (err) {
    if (err instanceof GeminiQuotaError) {
      return Response.json({ error: err.message, code: "quota" }, { status: 402 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "tagging failed" },
      { status: 502 },
    );
  }
}
