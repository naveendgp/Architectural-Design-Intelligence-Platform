import { createClient, type Client } from "@libsql/client";

/* libSQL (SQLite-compatible) client. Local file in dev; point DATABASE_URL at a
   hosted libSQL/Turso (or swap the driver) for production — repo.ts is the only
   layer that talks SQL, so the rest of the app is unaffected. */

const globalForDb = globalThis as unknown as {
  db?: Client;
  dbReady?: Promise<void>;
};

export const db: Client =
  globalForDb.db ??
  createClient({ url: process.env.DATABASE_URL ?? "file:./dev.db" });

if (process.env.NODE_ENV !== "production") globalForDb.db = db;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS Vendor (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS Product (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    priceInr INTEGER NOT NULL,
    styleTags TEXT NOT NULL DEFAULT '[]',
    widthCm REAL,
    depthCm REAL,
    heightCm REAL,
    status TEXT NOT NULL DEFAULT 'READY',
    thumbnailUrl TEXT NOT NULL,
    modelUrl TEXT,
    sourceVideoUrl TEXT,
    meshyTaskId TEXT,
    frontYaw REAL NOT NULL DEFAULT 0,
    mount TEXT NOT NULL DEFAULT 'floor',
    vendorId TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS RoomProject (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    roomType TEXT NOT NULL,
    style TEXT NOT NULL,
    photoUrl TEXT NOT NULL,
    thumbnailUrl TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS PlacedItem (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES RoomProject(id) ON DELETE CASCADE,
    productId TEXT NOT NULL REFERENCES Product(id),
    posX REAL NOT NULL DEFAULT 0,
    posY REAL NOT NULL DEFAULT 0,
    posZ REAL NOT NULL DEFAULT 0,
    rotationY REAL NOT NULL DEFAULT 0,
    tiltX REAL NOT NULL DEFAULT 0,
    tiltZ REAL NOT NULL DEFAULT 0,
    scale REAL NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Photorealistic renders generated from a project's scene (before/after snapshots).
  `CREATE TABLE IF NOT EXISTS Render (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL REFERENCES RoomProject(id) ON DELETE CASCADE,
    beforeUrl TEXT NOT NULL,
    afterUrl TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// Additive migrations for databases created before a column existed.
const MIGRATIONS = [
  "ALTER TABLE PlacedItem ADD COLUMN tiltX REAL NOT NULL DEFAULT 0",
  "ALTER TABLE PlacedItem ADD COLUMN tiltZ REAL NOT NULL DEFAULT 0",
  "ALTER TABLE Product ADD COLUMN frontYaw REAL NOT NULL DEFAULT 0",
  "ALTER TABLE Product ADD COLUMN mount TEXT NOT NULL DEFAULT 'floor'",
  // Keeps the pre-edit room photo so AI room edits can be reverted.
  "ALTER TABLE RoomProject ADD COLUMN originalPhotoUrl TEXT",
  /* Machine-facing labels the shopper never sees: what a piece is FOR, the room
     it suits, how it wants to be placed, and what it pairs with. Names alone
     were doing this job and doing it badly — "Conference Table", "Marble
     Morning Dining Table" and "Urban Walnut C Table" all read as "table", so
     the designer used a meeting table as a bedside and the placement engine
     tucked a chair under a lamp called "Dome Marble Table Lamp". */
  "ALTER TABLE Product ADD COLUMN aiTags TEXT NOT NULL DEFAULT '[]'",
];

/** Ensure tables exist + columns are migrated. Runs once per process. */
export function ensureDb(): Promise<void> {
  if (!globalForDb.dbReady) {
    globalForDb.dbReady = (async () => {
      for (const stmt of SCHEMA) await db.execute(stmt);
      for (const stmt of MIGRATIONS) {
        try {
          await db.execute(stmt);
        } catch {
          // column already exists — ignore.
        }
      }
    })();
  }
  return globalForDb.dbReady;
}
