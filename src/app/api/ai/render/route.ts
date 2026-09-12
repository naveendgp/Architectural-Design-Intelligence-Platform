import { saveFile, deleteFile } from "@/lib/storage";
import { renderRealistic, GeminiQuotaError } from "@/lib/gemini";
import { createRender, updateRenderImages } from "@/lib/repo";

export const runtime = "nodejs";

/* POST { image: dataURL, projectId? } -> { url, id? }
   Takes a screenshot of the studio scene (room photo + placed furniture, composited
   on the client), returns a photorealistic re-render saved to storage, and — when a
   projectId is given — saves a before/after Render record so it appears in the
   project's Render Gallery. 429 -> 402 so the client shows an "enable billing" note. */
export async function POST(req: Request) {
  let image: string | undefined;
  let projectId: string | undefined;
  let ceilingLights: number | undefined;
  let pieces: string[] | undefined;
  let renderId: string | undefined;
  try {
    ({ image, projectId, ceilingLights, renderId, pieces } = await req.json());
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (!image || typeof image !== "string" || !image.startsWith("data:")) {
    return Response.json({ error: "image data URL required" }, { status: 400 });
  }

  const match = image.match(/^data:(image\/\w+);base64,(.+)$/s);
  if (!match) {
    return Response.json({ error: "unsupported image encoding" }, { status: 400 });
  }
  const [, mime, b64] = match;
  const input = Buffer.from(b64, "base64");

  try {
    const out = await renderRealistic(input, mime, {
      ceilingLights: Math.max(0, Number(ceilingLights) || 0),
      pieces: Array.isArray(pieces) ? pieces.filter((p): p is string => typeof p === "string").slice(0, 24) : [],
    });
    const ext = out.mimeType.includes("jpeg") ? ".jpg" : ".png";
    const { url } = await saveFile(out.data, { folder: "renders", ext });

    // Persist a before/after Render for the gallery when tied to a project.
    // A re-render (renderId given) REPLACES the existing record + files so the
    // gallery doesn't fill with near-duplicates.
    let id: string | undefined = typeof renderId === "string" ? renderId : undefined;
    if (projectId && typeof projectId === "string") {
      const beforeExt = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : ".jpg";
      const before = await saveFile(input, { folder: "renders", ext: beforeExt });
      try {
        if (id) {
          const old = await updateRenderImages(id, before.url, url);
          if (old) {
            await deleteFile(old.beforeUrl);
            await deleteFile(old.afterUrl);
          } else {
            // The record vanished — create a fresh one instead.
            const record = await createRender({ projectId, beforeUrl: before.url, afterUrl: url });
            id = record.id;
          }
        } else {
          const record = await createRender({ projectId, beforeUrl: before.url, afterUrl: url });
          id = record.id;
        }
      } catch {
        /* project may not exist / DB issue — still return the render image */
      }
    }
    return Response.json({ url, id });
  } catch (err) {
    if (err instanceof GeminiQuotaError) {
      return Response.json({ error: err.message, code: "billing" }, { status: 402 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "render failed" },
      { status: 502 },
    );
  }
}
