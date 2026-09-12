import type {
  ProductDTO,
  ProjectDTO,
  BudgetDTO,
  PlacedItemDTO,
  RenderDTO,
} from "./types";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  products: (params?: { q?: string; style?: string }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.style) qs.set("style", params.style);
    const suffix = qs.toString() ? `?${qs}` : "";
    return get<{ products: ProductDTO[] }>(`/api/products${suffix}`).then(
      (r) => r.products,
    );
  },
  projects: () =>
    get<{ projects: ProjectDTO[] }>("/api/projects").then((r) => r.projects),
  createProject: (input: {
    name: string;
    roomType: string;
    style: string;
    photoUrl: string;
    thumbnailUrl?: string;
  }) =>
    send<{ project: ProjectDTO }>("/api/projects", "POST", input).then(
      (r) => r.project,
    ),
  uploadFile: async (file: File, folder: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("folder", folder);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error("Upload failed");
    return (await res.json()) as { key: string; url: string };
  },
  projectScene: (id: string) =>
    get<{ project: ProjectDTO; placements: PlacedItemDTO[] }>(
      `/api/projects/${id}`,
    ),
  // AI: analyze the room — floor objects (obstacles) + floor/ceiling surface lines
  // (for grounding). `image` is the photo-only stage view so all coords match the
  // placement anchor space.
  analyze: (image: string) =>
    send<{
      objects: { label: string; x0: number; y0: number; x1: number; y1: number }[];
      floorTop: number[];
      ceilingBottom: number[];
      nearDepthM?: number;
      farDepthM?: number;
    }>("/api/ai/segment", "POST", { image }),
  // AI: ask Gemini where a new item should go, its facing angle, and whether it
  // fits — given a screenshot of the room with current furniture.
  place: (input: {
    image: string;
    item: {
      name: string;
      category: string;
      mount: "floor" | "ceiling";
      widthCm: number | null;
      depthCm: number | null;
      heightCm: number | null;
    };
    placed: { name: string; mount: "floor" | "ceiling"; ax: number; ay: number }[];
  }) =>
    send<{
      fits: boolean;
      reason: string;
      ax: number;
      ay: number;
      facingDeg: number;
      confidence: number;
      // Optional alternative candidate spots (used by the client-side spot cache to
      // avoid re-calling Gemini for every add). Populated only if the model returns them.
      spots?: { ax: number; ay: number; facingDeg: number; confidence?: number }[];
    }>("/api/ai/place", "POST", input),
  // AI: turn a free-form design request ("make this lobby a modern waiting area
  // under ₹5 lakh") into a concrete list of catalog pieces to add. The catalog is
  // resolved server-side, so this returns full products ready to render.
  design: async (input: {
    image: string;
    request: string;
    placed: { name: string; qty: number }[];
    capacity?: { floorAreaM2: number; freeFloorM2: number };
  }) => {
    const res = await fetch("/api/ai/design", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = (await res.json().catch(() => ({}))) as {
      intent?: string;
      reply?: string;
      offTopic?: boolean;
      budgetInr?: number;
      totalInr?: number;
      trimmed?: boolean;
      items?: { product: ProductDTO; qty: number; reason: string; subtotalInr: number }[];
      surfaceOptions?: { label: string; instruction: string; reason: string }[] | null;
      clearInstruction?: string | null;
      error?: string;
      code?: string;
    };
    if (!res.ok) {
      const err = new Error(data.error || `Design failed: ${res.status}`) as Error & {
        code?: string;
      };
      err.code = data.code;
      throw err;
    }
    return {
      intent: data.intent ?? "",
      reply: data.reply ?? "",
      offTopic: data.offTopic === true,
      budgetInr: data.budgetInr ?? 0,
      totalInr: data.totalInr ?? 0,
      trimmed: data.trimmed === true,
      items: data.items ?? [],
      surfaceOptions: data.surfaceOptions ?? null,
      clearInstruction: data.clearInstruction ?? null,
    };
  },
  // AI: edit the room's base photo (wallpaper, curtains, paint, flooring…) and set it
  // as the project's new photo. Returns the new photoUrl. Surfaces error code.
  editRoom: async (projectId: string, photoUrl: string, instruction: string) => {
    const res = await fetch("/api/ai/edit-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, photoUrl, instruction }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      photoUrl?: string;
      error?: string;
      code?: string;
    };
    if (!res.ok || !data.photoUrl) {
      const err = new Error(data.error || `Edit failed: ${res.status}`) as Error & { code?: string };
      err.code = data.code;
      throw err;
    }
    return data.photoUrl;
  },
  // Swap the project's room photo for a different one (user upload).
  setProjectPhoto: (projectId: string, photoUrl: string) =>
    send<{ photoUrl: string }>(`/api/projects/${projectId}`, "PATCH", { photoUrl }).then(
      (r) => r.photoUrl,
    ),
  // Restore the project's original (pre-edit) room photo.
  revertRoom: (projectId: string) =>
    send<{ photoUrl: string }>("/api/ai/revert-room", "POST", { projectId }).then(
      (r) => r.photoUrl,
    ),
  // AI: estimate a multiplier to fix furniture that's mis-scaled for the room.
  scaleFit: (image: string) =>
    send<{ scaleMultiplier: number }>("/api/ai/scale", "POST", { image }).then(
      (r) => r.scaleMultiplier,
    ),
  // AI: Gemini-powered ambient-lighting assessment for the lighting panel.
  // Uses the original room photo so the recommended total stays stable. Surfaces
  // the server's error code (e.g. "quota") so callers can avoid retry-storming a
  // rate limit.
  lightInsight: async (photoUrl: string, installed: number) => {
    const res = await fetch("/api/ai/light-insight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoUrl, installed }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      sufficient?: boolean;
      recommended?: number;
      insight?: string;
      error?: string;
      code?: string;
    };
    if (!res.ok || typeof data.recommended !== "number") {
      const err = new Error(data.error || `Request failed: ${res.status}`) as Error & {
        code?: string;
      };
      err.code = data.code ?? (res.status === 402 ? "quota" : undefined);
      throw err;
    }
    return {
      sufficient: data.sufficient ?? true,
      recommended: data.recommended,
      insight: data.insight ?? "",
    };
  },
  // AI: turn a composited scene screenshot into a photorealistic render. When a
  // projectId is given, the render is saved to that project's gallery.
  // Surfaces the server's error message + code (e.g. "billing") on failure.
  render: async (
    image: string,
    opts: { projectId?: string; ceilingLights?: number; renderId?: string; pieces?: string[] } = {},
  ) => {
    const res = await fetch("/api/ai/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, ...opts }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      url?: string;
      id?: string;
      error?: string;
      code?: string;
    };
    if (!res.ok || !data.url) {
      const err = new Error(data.error || `Render failed: ${res.status}`) as Error & {
        code?: string;
      };
      err.code = data.code;
      throw err;
    }
    return { url: data.url, id: data.id };
  },
  // Saved photorealistic renders (all, or for one project).
  renders: (projectId?: string) =>
    get<{ renders: RenderDTO[] }>(
      `/api/renders${projectId ? `?projectId=${projectId}` : ""}`,
    ).then((r) => r.renders),
  deleteRender: (id: string) =>
    send<{ ok: true }>(`/api/renders/${id}`, "DELETE"),
  budget: (projectId?: string) =>
    get<{ budget: BudgetDTO }>(
      `/api/budget${projectId ? `?projectId=${projectId}` : ""}`,
    ).then((r) => r.budget),

  addItem: (projectId: string, productId: string) =>
    send<{ placement: PlacedItemDTO }>(
      `/api/projects/${projectId}/items`,
      "POST",
      { productId },
    ).then((r) => r.placement),
  updatePlacement: (
    id: string,
    patch: Partial<
      Pick<PlacedItemDTO, "posX" | "posZ" | "rotationY" | "tiltX" | "tiltZ" | "scale">
    >,
  ) => send<{ ok: true }>(`/api/placements/${id}`, "PATCH", patch),
  deletePlacement: (id: string) =>
    send<{ ok: true }>(`/api/placements/${id}`, "DELETE"),
  deleteProduct: (id: string) =>
    send<{ ok: true }>(`/api/products/${id}`, "DELETE"),
};
