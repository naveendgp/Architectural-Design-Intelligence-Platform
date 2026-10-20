import { layoutRoom, GeminiQuotaError, type LayoutPiece } from "@/lib/gemini";

export const runtime = "nodejs";

/* POST { image, pieces[], floorBand } -> a position and facing for every piece.

   One call arranges the whole set. The client treats the result as a proposal:
   each spot is grounded onto the floor line, paired pieces are re-seated by
   rule, and the packer resolves anything that still collides. */
export async function POST(req: Request) {
  let payload: {
    image?: string;
    pieces?: LayoutPiece[];
    floorBand?: { minY: number; maxY: number };
  };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { image, pieces, floorBand } = payload;
  if (!image || typeof image !== "string" || !image.startsWith("data:")) {
    return Response.json({ error: "image data URL required" }, { status: 400 });
  }
  if (!Array.isArray(pieces) || pieces.length === 0) {
    return Response.json({ error: "pieces required" }, { status: 400 });
  }

  const match = image.match(/^data:(image\/\w+);base64,(.+)$/s);
  if (!match) {
    return Response.json({ error: "unsupported image encoding" }, { status: 400 });
  }
  const [, mime, b64] = match;

  const band = {
    minY: Number.isFinite(floorBand?.minY) ? Number(floorBand!.minY) : 0.55,
    maxY: Number.isFinite(floorBand?.maxY) ? Number(floorBand!.maxY) : 0.94,
  };

  try {
    const spots = await layoutRoom(Buffer.from(b64, "base64"), mime, pieces, band);
    return Response.json({ spots });
  } catch (err) {
    if (err instanceof GeminiQuotaError) {
      return Response.json({ error: err.message, code: "quota" }, { status: 402 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "layout failed" },
      { status: 502 },
    );
  }
}
