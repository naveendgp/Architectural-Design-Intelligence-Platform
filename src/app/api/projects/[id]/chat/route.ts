import { NextResponse } from "next/server";
import { listChatMessages, addChatMessage, clearChatMessages, setChatChoice } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* The AI Designer's conversation for one project.
   GET    -> every turn, oldest first
   POST   -> append one turn
   DELETE -> clear the conversation */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return NextResponse.json({ messages: await listChatMessages(id) });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const role = body.role === "user" ? "user" : "ai";
  const text = typeof body.text === "string" ? body.text : "";
  // A message with neither words nor a proposal is not worth keeping.
  if (!text && !body.plan && !body.imageUrl) {
    return NextResponse.json({ error: "empty message" }, { status: 400 });
  }

  const saved = await addChatMessage(id, {
    role,
    text,
    imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : null,
    plan: typeof body.plan === "string" ? body.plan : null,
    chose: typeof body.chose === "string" ? body.chose : null,
  });
  return NextResponse.json({ message: saved });
}

/* PATCH { messageId, chose } — record which option was taken. The choice is
   made after the message is written, and a restored conversation that shows
   three options but not which one was picked has lost the useful half. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const messageId = typeof body.messageId === "string" ? body.messageId : "";
  const chose = typeof body.chose === "string" ? body.chose : "";
  if (!messageId || !chose) {
    return NextResponse.json({ error: "messageId and chose required" }, { status: 400 });
  }
  await setChatChoice(id, messageId, chose);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await clearChatMessages(id);
  return NextResponse.json({ ok: true });
}
