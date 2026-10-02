import { randomUUID } from "crypto";
import { db, ensureDb } from "./db";
import type {
  ProductDTO,
  ProjectDTO,
  BudgetDTO,
  PlacedItemDTO,
  RenderDTO,
  Style,
} from "./types";

type Row = Record<string, unknown>;

const str = (v: unknown) => (v == null ? "" : String(v));
const strOrNull = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

function parseStyles(json: unknown): Style[] {
  try {
    return JSON.parse(str(json)) as Style[];
  } catch {
    return [];
  }
}

function toProductDTO(r: Row): ProductDTO {
  return {
    id: str(r.id),
    name: str(r.name),
    category: str(r.category),
    description: strOrNull(r.description),
    priceInr: num(r.priceInr),
    styleTags: parseStyles(r.styleTags),
    widthCm: numOrNull(r.widthCm),
    depthCm: numOrNull(r.depthCm),
    heightCm: numOrNull(r.heightCm),
    status: str(r.status) as ProductDTO["status"],
    thumbnailUrl: str(r.thumbnailUrl),
    modelUrl: strOrNull(r.modelUrl),
    frontYaw: num(r.frontYaw),
    mount: (str(r.mount) === "ceiling" ? "ceiling" : "floor") as ProductDTO["mount"],
    createdAt: str(r.createdAt),
  };
}

export async function listProducts(filter?: {
  q?: string;
  style?: string;
}): Promise<ProductDTO[]> {
  await ensureDb();
  /* Pieces with their own model come first and stand-ins last, so the strongest
     work leads every catalogue view. Both the library and the studio picker only
     filter this list, never re-sort it, so ordering here covers both. */
  const res = await db.execute(
    "SELECT * FROM Product ORDER BY CASE WHEN status = 'PREVIEW' THEN 1 ELSE 0 END, createdAt DESC",
  );
  let items = (res.rows as unknown as Row[]).map(toProductDTO);

  if (filter?.q) {
    const q = filter.q.toLowerCase();
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
  }
  if (filter?.style && filter.style !== "All" && filter.style !== "Wooden") {
    items = items.filter((p) => p.styleTags.includes(filter.style as Style));
  }
  return items;
}

export async function createProduct(input: {
  name: string;
  category: string;
  priceInr: number;
  styleTags?: Style[];
  thumbnailUrl: string;
  description?: string;
  widthCm?: number;
  depthCm?: number;
  heightCm?: number;
  status?: string;
  modelUrl?: string;
  sourceVideoUrl?: string;
  meshyTaskId?: string;
  frontYaw?: number;
  mount?: "floor" | "ceiling";
}): Promise<ProductDTO> {
  await ensureDb();
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO Product
      (id, name, category, description, priceInr, styleTags, widthCm, depthCm, heightCm, status, thumbnailUrl, modelUrl, sourceVideoUrl, meshyTaskId, frontYaw, mount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id,
      input.name,
      input.category,
      input.description ?? null,
      input.priceInr,
      JSON.stringify(input.styleTags ?? []),
      input.widthCm ?? null,
      input.depthCm ?? null,
      input.heightCm ?? null,
      input.status ?? "READY",
      input.thumbnailUrl,
      input.modelUrl ?? null,
      input.sourceVideoUrl ?? null,
      input.meshyTaskId ?? null,
      input.frontYaw ?? 0,
      input.mount ?? "floor",
    ],
  });
  const res = await db.execute({
    sql: "SELECT * FROM Product WHERE id = ?",
    args: [id],
  });
  return toProductDTO(res.rows[0] as unknown as Row);
}

export async function deleteProduct(id: string): Promise<void> {
  await ensureDb();
  // Remove any placements of this product first, then the product itself.
  await db.execute({ sql: "DELETE FROM PlacedItem WHERE productId = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM Product WHERE id = ?", args: [id] });
}

export async function listProjects(): Promise<ProjectDTO[]> {
  await ensureDb();
  const res = await db.execute(
    `SELECT p.*, (SELECT COUNT(*) FROM PlacedItem pi WHERE pi.projectId = p.id) AS itemCount
     FROM RoomProject p ORDER BY p.updatedAt DESC`,
  );
  return (res.rows as unknown as Row[]).map((r) => ({
    id: str(r.id),
    name: str(r.name),
    roomType: str(r.roomType),
    style: str(r.style),
    photoUrl: str(r.photoUrl),
    thumbnailUrl: str(r.thumbnailUrl),
    progress: num(r.progress),
    updatedAt: str(r.updatedAt),
    itemCount: num(r.itemCount),
  }));
}

export async function createProject(input: {
  name: string;
  roomType: string;
  style: string;
  photoUrl: string;
  thumbnailUrl?: string;
}): Promise<ProjectDTO> {
  await ensureDb();
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO RoomProject (id, name, roomType, style, photoUrl, thumbnailUrl)
          VALUES (?,?,?,?,?,?)`,
    args: [
      id,
      input.name,
      input.roomType,
      input.style,
      input.photoUrl,
      input.thumbnailUrl ?? input.photoUrl,
    ],
  });
  const res = await db.execute({
    sql: "SELECT * FROM RoomProject WHERE id = ?",
    args: [id],
  });
  const r = res.rows[0] as unknown as Row;
  return {
    id: str(r.id),
    name: str(r.name),
    roomType: str(r.roomType),
    style: str(r.style),
    photoUrl: str(r.photoUrl),
    thumbnailUrl: str(r.thumbnailUrl),
    progress: num(r.progress),
    updatedAt: str(r.updatedAt),
    itemCount: 0,
  };
}

/** Replace a project's base room photo (used by AI room editing). Captures the
    pre-edit photo as the original the first time, so edits can be reverted. */
export async function updateProjectPhoto(id: string, photoUrl: string): Promise<void> {
  await ensureDb();
  const cur = await db.execute({
    sql: "SELECT photoUrl, originalPhotoUrl FROM RoomProject WHERE id = ?",
    args: [id],
  });
  if (cur.rows.length === 0) return;
  const row = cur.rows[0] as unknown as Row;
  const original = strOrNull(row.originalPhotoUrl) ?? str(row.photoUrl); // keep first original
  await db.execute({
    sql: "UPDATE RoomProject SET photoUrl = ?, originalPhotoUrl = ?, updatedAt = datetime('now') WHERE id = ?",
    args: [photoUrl, original, id],
  });
}

/** Restore a project's original (pre-edit) room photo. Returns the restored url. */
export async function revertProjectPhoto(id: string): Promise<string | null> {
  await ensureDb();
  const cur = await db.execute({
    sql: "SELECT photoUrl, originalPhotoUrl FROM RoomProject WHERE id = ?",
    args: [id],
  });
  if (cur.rows.length === 0) return null;
  const row = cur.rows[0] as unknown as Row;
  const original = strOrNull(row.originalPhotoUrl);
  if (!original) return str(row.photoUrl); // never edited — nothing to revert
  await db.execute({
    sql: "UPDATE RoomProject SET photoUrl = ?, updatedAt = datetime('now') WHERE id = ?",
    args: [original, id],
  });
  return original;
}

export async function getProjectScene(id: string): Promise<{
  project: ProjectDTO;
  placements: PlacedItemDTO[];
} | null> {
  await ensureDb();
  const pres = await db.execute({
    sql: "SELECT * FROM RoomProject WHERE id = ?",
    args: [id],
  });
  if (pres.rows.length === 0) return null;
  const r = pres.rows[0] as unknown as Row;

  const placeRes = await db.execute({
    sql: `SELECT pi.*, pr.id AS p_id, pr.name AS p_name, pr.category AS p_category,
                 pr.description AS p_description, pr.priceInr AS p_priceInr,
                 pr.styleTags AS p_styleTags, pr.widthCm AS p_widthCm, pr.depthCm AS p_depthCm,
                 pr.heightCm AS p_heightCm, pr.status AS p_status, pr.thumbnailUrl AS p_thumbnailUrl,
                 pr.modelUrl AS p_modelUrl, pr.frontYaw AS p_frontYaw, pr.mount AS p_mount, pr.createdAt AS p_createdAt
          FROM PlacedItem pi JOIN Product pr ON pr.id = pi.productId
          WHERE pi.projectId = ? ORDER BY pi.createdAt ASC`,
    args: [id],
  });

  const placements: PlacedItemDTO[] = (placeRes.rows as unknown as Row[]).map(
    (pl) => ({
      id: str(pl.id),
      productId: str(pl.productId),
      product: toProductDTO({
        id: pl.p_id,
        name: pl.p_name,
        category: pl.p_category,
        description: pl.p_description,
        priceInr: pl.p_priceInr,
        styleTags: pl.p_styleTags,
        widthCm: pl.p_widthCm,
        depthCm: pl.p_depthCm,
        heightCm: pl.p_heightCm,
        status: pl.p_status,
        thumbnailUrl: pl.p_thumbnailUrl,
        modelUrl: pl.p_modelUrl,
        frontYaw: pl.p_frontYaw,
        mount: pl.p_mount,
        createdAt: pl.p_createdAt,
      }),
      posX: num(pl.posX),
      posY: num(pl.posY),
      posZ: num(pl.posZ),
      rotationY: num(pl.rotationY),
      tiltX: num(pl.tiltX),
      tiltZ: num(pl.tiltZ),
      scale: num(pl.scale),
    }),
  );

  return {
    project: {
      id: str(r.id),
      name: str(r.name),
      roomType: str(r.roomType),
      style: str(r.style),
      photoUrl: str(r.photoUrl),
      originalPhotoUrl: strOrNull(r.originalPhotoUrl),
      thumbnailUrl: str(r.thumbnailUrl),
      progress: num(r.progress),
      updatedAt: str(r.updatedAt),
      itemCount: placements.length,
    },
    placements,
  };
}

export async function addPlacement(
  projectId: string,
  productId: string,
): Promise<PlacedItemDTO | null> {
  await ensureDb();
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO PlacedItem (id, projectId, productId) VALUES (?,?,?)`,
    args: [id, projectId, productId],
  });
  await db.execute({
    sql: `UPDATE RoomProject SET updatedAt = datetime('now') WHERE id = ?`,
    args: [projectId],
  });
  const res = await db.execute({
    sql: `SELECT pi.*, pr.id AS p_id, pr.name AS p_name, pr.category AS p_category,
                 pr.description AS p_description, pr.priceInr AS p_priceInr,
                 pr.styleTags AS p_styleTags, pr.widthCm AS p_widthCm, pr.depthCm AS p_depthCm,
                 pr.heightCm AS p_heightCm, pr.status AS p_status, pr.thumbnailUrl AS p_thumbnailUrl,
                 pr.modelUrl AS p_modelUrl, pr.frontYaw AS p_frontYaw, pr.mount AS p_mount, pr.createdAt AS p_createdAt
          FROM PlacedItem pi JOIN Product pr ON pr.id = pi.productId WHERE pi.id = ?`,
    args: [id],
  });
  if (res.rows.length === 0) return null;
  const pl = res.rows[0] as unknown as Row;
  return {
    id: str(pl.id),
    productId: str(pl.productId),
    product: toProductDTO({
      id: pl.p_id, name: pl.p_name, category: pl.p_category,
      description: pl.p_description, priceInr: pl.p_priceInr, styleTags: pl.p_styleTags,
      widthCm: pl.p_widthCm, depthCm: pl.p_depthCm, heightCm: pl.p_heightCm,
      status: pl.p_status, thumbnailUrl: pl.p_thumbnailUrl, modelUrl: pl.p_modelUrl,
      frontYaw: pl.p_frontYaw, mount: pl.p_mount, createdAt: pl.p_createdAt,
    }),
    posX: num(pl.posX), posY: num(pl.posY), posZ: num(pl.posZ),
    rotationY: num(pl.rotationY), tiltX: num(pl.tiltX), tiltZ: num(pl.tiltZ),
    scale: num(pl.scale),
  };
}

export async function updatePlacement(
  id: string,
  patch: { posX?: number; posY?: number; posZ?: number; rotationY?: number; tiltX?: number; tiltZ?: number; scale?: number },
): Promise<void> {
  await ensureDb();
  const fields: string[] = [];
  const args: (number | string)[] = [];
  for (const key of ["posX", "posY", "posZ", "rotationY", "tiltX", "tiltZ", "scale"] as const) {
    if (patch[key] != null) {
      fields.push(`${key} = ?`);
      args.push(patch[key] as number);
    }
  }
  if (fields.length === 0) return;
  args.push(id);
  await db.execute({
    sql: `UPDATE PlacedItem SET ${fields.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function deletePlacement(id: string): Promise<void> {
  await ensureDb();
  await db.execute({ sql: `DELETE FROM PlacedItem WHERE id = ?`, args: [id] });
}

export async function getBudget(projectId?: string): Promise<BudgetDTO | null> {
  await ensureDb();
  const pres = projectId
    ? await db.execute({
        sql: "SELECT * FROM RoomProject WHERE id = ?",
        args: [projectId],
      })
    : await db.execute(
        "SELECT * FROM RoomProject ORDER BY updatedAt DESC LIMIT 1",
      );
  if (pres.rows.length === 0) return null;
  const project = pres.rows[0] as unknown as Row;

  const res = await db.execute({
    sql: `SELECT pi.id AS id, pr.name AS name, pr.category AS category, pr.priceInr AS priceInr
          FROM PlacedItem pi JOIN Product pr ON pr.id = pi.productId
          WHERE pi.projectId = ? ORDER BY pi.createdAt ASC`,
    args: [str(project.id)],
  });

  const items = (res.rows as unknown as Row[]).map((i) => ({
    id: str(i.id),
    name: str(i.name),
    category: str(i.category),
    priceInr: num(i.priceInr),
  }));

  const byCategoryMap = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.category] = (acc[i.category] ?? 0) + i.priceInr;
    return acc;
  }, {});

  return {
    projectId: str(project.id),
    projectName: str(project.name),
    items,
    total: items.reduce((s, i) => s + i.priceInr, 0),
    byCategory: Object.entries(byCategoryMap).map(([name, value]) => ({
      name,
      value,
    })),
  };
}

// ── Renders ────────────────────────────────────────────────────────────────

export async function createRender(input: {
  projectId: string;
  beforeUrl: string;
  afterUrl: string;
}): Promise<RenderDTO> {
  await ensureDb();
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO Render (id, projectId, beforeUrl, afterUrl) VALUES (?,?,?,?)`,
    args: [id, input.projectId, input.beforeUrl, input.afterUrl],
  });
  const res = await db.execute({
    sql: `SELECT r.*, p.name AS projectName FROM Render r
          JOIN RoomProject p ON p.id = r.projectId WHERE r.id = ?`,
    args: [id],
  });
  return toRenderDTO(res.rows[0] as unknown as Row);
}

export async function listRenders(projectId?: string): Promise<RenderDTO[]> {
  await ensureDb();
  const res = await db.execute(
    projectId
      ? {
          sql: `SELECT r.*, p.name AS projectName FROM Render r
                JOIN RoomProject p ON p.id = r.projectId
                WHERE r.projectId = ? ORDER BY r.createdAt DESC`,
          args: [projectId],
        }
      : `SELECT r.*, p.name AS projectName FROM Render r
         JOIN RoomProject p ON p.id = r.projectId ORDER BY r.createdAt DESC`,
  );
  return (res.rows as unknown as Row[]).map(toRenderDTO);
}

function toRenderDTO(r: Row): RenderDTO {
  return {
    id: str(r.id),
    projectId: str(r.projectId),
    projectName: str(r.projectName),
    beforeUrl: str(r.beforeUrl),
    afterUrl: str(r.afterUrl),
    createdAt: str(r.createdAt),
  };
}

/** Replace a render's before/after images (used when re-rendering the same scene, so
    the gallery doesn't fill with duplicates). Returns the OLD urls to clean up, or
    null if the render no longer exists. */
export async function updateRenderImages(
  id: string,
  beforeUrl: string,
  afterUrl: string,
): Promise<{ beforeUrl: string; afterUrl: string } | null> {
  await ensureDb();
  const prev = await db.execute({
    sql: "SELECT beforeUrl, afterUrl FROM Render WHERE id = ?",
    args: [id],
  });
  if (prev.rows.length === 0) return null;
  const old = prev.rows[0] as unknown as Row;
  await db.execute({
    sql: "UPDATE Render SET beforeUrl = ?, afterUrl = ?, createdAt = datetime('now') WHERE id = ?",
    args: [beforeUrl, afterUrl, id],
  });
  return { beforeUrl: str(old.beforeUrl), afterUrl: str(old.afterUrl) };
}

/** Delete a render. Returns its image urls so the caller can remove the files. */
export async function deleteRender(id: string): Promise<{ beforeUrl: string; afterUrl: string } | null> {
  await ensureDb();
  const res = await db.execute({
    sql: "SELECT beforeUrl, afterUrl FROM Render WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as unknown as Row;
  await db.execute({ sql: "DELETE FROM Render WHERE id = ?", args: [id] });
  return { beforeUrl: str(r.beforeUrl), afterUrl: str(r.afterUrl) };
}
