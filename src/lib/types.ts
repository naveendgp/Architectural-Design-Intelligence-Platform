/* Plain DTOs returned by the API (JSON-serializable). The DB layer maps Prisma
   rows into these so the client never deals with Date objects or JSON strings. */

export type Style =
  | "Modern"
  | "Classical"
  | "Luxury"
  | "Minimal"
  | "Scandinavian";

export type ProductDTO = {
  id: string;
  name: string;
  category: string;
  description: string | null;
  priceInr: number;
  styleTags: Style[];
  widthCm: number | null;
  depthCm: number | null;
  heightCm: number | null;
  /* PREVIEW = an image-only catalogue listing with no 3D model yet. It can be
     browsed and priced in the marketplace but never placed in a room; attach a
     modelUrl and flip it to READY when the real model lands. */
  status: "PROCESSING" | "READY" | "FAILED" | "PREVIEW";
  /* Machine-facing labels, never shown to a shopper. See MIGRATIONS in db.ts.
     Vocabulary: role:* what it is for, room:* where it belongs, place:* how it
     should be seated, pairs:* what it goes with. */
  aiTags: string[];
  thumbnailUrl: string;
  modelUrl: string | null;
  frontYaw: number; // yaw (°) that makes the model's front face the camera
  mount: "floor" | "ceiling"; // where the piece attaches
  createdAt: string;
};

export type ProjectDTO = {
  id: string;
  name: string;
  roomType: string;
  style: string;
  photoUrl: string;
  originalPhotoUrl?: string | null; // pre-edit photo, when the room has been AI-edited
  thumbnailUrl: string;
  progress: number;
  updatedAt: string;
  itemCount: number;
};

export type PlacedItemDTO = {
  id: string;
  productId: string;
  product: ProductDTO;
  posX: number;
  posY: number;
  posZ: number;
  rotationY: number;
  tiltX: number;
  tiltZ: number;
  scale: number;
};

export type RenderDTO = {
  id: string;
  projectId: string;
  projectName: string;
  beforeUrl: string;
  afterUrl: string;
  createdAt: string;
};

export type BudgetDTO = {
  projectId: string;
  projectName: string;
  items: { id: string; name: string; category: string; priceInr: number }[];
  total: number;
  byCategory: { name: string; value: number }[];
};

/** One turn of the AI Designer's conversation, as stored with its project. */
export type ChatMessageDTO = {
  id: string;
  role: "user" | "ai";
  text: string;
  imageUrl: string | null;
  /** JSON snapshot of a proposal that was shown; history, not a live plan. */
  plan: string | null;
  /** Which option was taken, when the message offered a choice. */
  chose: string | null;
  createdAt: string;
};
