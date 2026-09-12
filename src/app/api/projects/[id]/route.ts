import { NextResponse } from "next/server";
import { getProjectScene, updateProjectPhoto } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = await getProjectScene(id);
  if (!scene) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json(scene);
}

/* PATCH { photoUrl } — swap the room photo for a different one the user uploaded.
   Goes through updateProjectPhoto so the ORIGINAL photo is preserved on the first
   change, which is what Revert restores. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let photoUrl: unknown;
  try {
    ({ photoUrl } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (typeof photoUrl !== "string" || !photoUrl.startsWith("/api/files/")) {
    return NextResponse.json({ error: "photoUrl required" }, { status: 400 });
  }

  const scene = await getProjectScene(id);
  if (!scene) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await updateProjectPhoto(id, photoUrl);
  return NextResponse.json({ photoUrl });
}
