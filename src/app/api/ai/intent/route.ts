import { classifyIntent, GeminiQuotaError } from "@/lib/gemini";

export const runtime = "nodejs";

/* POST { message, canRevert } -> { action, item? }

   Text-only and cheap, so it can sit in front of the chat's routing. If it
   fails the caller falls back to its own keyword rules — a wrong route is
   better than a dead chat. */
export async function POST(req: Request) {
  let payload: { message?: string; canRevert?: boolean };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) return Response.json({ error: "message required" }, { status: 400 });

  try {
    const intent = await classifyIntent(message, { canRevert: payload.canRevert === true });
    return Response.json(intent);
  } catch (err) {
    if (err instanceof GeminiQuotaError) {
      return Response.json({ error: err.message, code: "quota" }, { status: 402 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "classify failed" },
      { status: 502 },
    );
  }
}
