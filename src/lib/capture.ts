/* Composite the room photo + the WebGL furniture overlay into a single image that
   matches exactly what the user sees on screen (object-cover photo, transparent
   3D canvas drawn on top). Shared by the render dialog and AI placement — both
   need "the scene as it looks right now" as a JPEG data URL.

   Browser-only (uses <canvas>/<img>); import from client components. */

/* Resolve once the bitmap is usable by drawImage.

   decode() alone is not safe here: for a detached <img> it can stall forever
   (seen with a fully-loaded 1192×896 photo, naturalWidth set, promise never
   settling), which hung capture — and with it AI design, room analysis and
   Render Scene. The load event is the reliable signal; decode() is kept only as
   a best-effort way to avoid a decode hitch, capped so it can never block. */
async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  if (!(img.complete && img.naturalWidth > 0)) {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Could not load room photo: ${src}`));
    });
  }
  await Promise.race([
    img.decode().catch(() => {}),
    new Promise<void>((r) => setTimeout(r, 1000)),
  ]);
  return img;
}

/** Draw the room photo object-cover into a `w×h` canvas (matches the on-screen view). */
async function drawPhotoCover(
  ctx: CanvasRenderingContext2D,
  photoUrl: string,
  w: number,
  h: number,
): Promise<void> {
  const img = await loadImage(photoUrl);
  const ir = img.width / img.height;
  const cr = w / h;
  let dw = w;
  let dh = h;
  if (ir > cr) {
    dh = h;
    dw = h * ir;
  } else {
    dw = w;
    dh = w / ir;
  }
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/* Size of the on-screen stage. Prefer the WebGL canvas (its box is exactly the
   anchor space placement coordinates are expressed in), but ignore it while it
   still reports the 300×150 default it has before R3F lays it out — capturing at
   that size would hand the AI a thumbnail to reason about. */
function stageSize(stageEl: HTMLElement): { w: number; h: number } {
  const canvas = stageEl.querySelector("canvas");
  const cw = canvas?.clientWidth ?? 0;
  const ch = canvas?.clientHeight ?? 0;
  const laidOut = cw > 300 && ch > 150;
  return {
    w: (laidOut ? cw : stageEl.clientWidth) || cw || 1,
    h: (laidOut ? ch : stageEl.clientHeight) || ch || 1,
  };
}

export async function captureComposite(
  stageEl: HTMLElement,
  photoUrl: string,
): Promise<string> {
  const canvas = stageEl.querySelector("canvas");
  if (!canvas) throw new Error("Scene canvas not found");
  const { w, h } = stageSize(stageEl);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  await drawPhotoCover(ctx, photoUrl, w, h);
  // The WebGL canvas is transparent except for the furniture — draw it on top.
  ctx.drawImage(canvas, 0, 0, w, h);

  return out.toDataURL("image/jpeg", 0.92);
}

/** Photo-only view (no 3D furniture) in stage coordinates — for segmenting the
    REAL room objects so their boxes align with the placement anchor space. */
export async function capturePhotoView(
  stageEl: HTMLElement,
  photoUrl: string,
): Promise<string> {
  const { w, h } = stageSize(stageEl);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  await drawPhotoCover(ctx, photoUrl, w, h);
  return out.toDataURL("image/jpeg", 0.92);
}
