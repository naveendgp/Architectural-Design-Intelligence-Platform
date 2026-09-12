"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Plus,
  Lightbulb,
  Paintbrush,
  Sparkles,
  ChevronLeft,
  Sliders,
  RotateCw,
  Move3d,
  Trash2,
  ImagePlus,
  RotateCcw,
  X,
  Box,
  Camera,
  Maximize2,
  Wallet,
  ChevronDown,
  Ruler,
  Grid2x2,
  Loader2,
  Shuffle,
  Search,
  LayoutGrid,
} from "lucide-react";
import { cn, formatINR, formatINRFull } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { getDepthField, type DepthField } from "@/lib/depth";
import type { PlacedItemDTO, ProductDTO, ProjectDTO } from "@/lib/types";
import type { Calibration } from "@/lib/placement";
import {
  ceilingAnchor,
  itemAnchor,
  findFreeAnchor,
  anchorOverlaps,
  type FootprintSpec,
  type OBB,
  type FloorObjectBox,
  objectBoxToOBB,
  setSceneCalib,
  rearrangeAnchors,
  floorCapacity,
  floorRegion,
  footprintAreaM2,
  CEILING_ANCHOR_BAND,
} from "@/lib/placement";
import { captureComposite, capturePhotoView } from "@/lib/capture";
import { MeasureOverlay, type MeasureConfig } from "@/components/studio/measure-overlay";
import { StudioChat } from "@/components/studio/studio-chat";
import { RenderDialog } from "@/components/studio/render-dialog";

// R3F cannot server-render — load the canvas only on the client.
const RoomScene = dynamic(
  () => import("@/components/studio/room-scene").then((m) => m.RoomScene),
  { ssr: false },
);

// Placement is decided by Gemini per room (see addFurniture). These are only safe
// fallbacks used when the AI is unreachable: a floor piece lands centre-ish, a
// ceiling fixture lands centre-top. New pieces start at their REAL metric size
// (100%) so footprints/collision match reality — 1.4 made a 2 m sofa collide as
// 2.8 m and floods small rooms with false "no space".
const DEFAULT_SCALE = 1.0;
const FLOOR_FALLBACK = { posX: 0.5, posZ: 0.72 };
const CEILING_FALLBACK = { posX: 0.5, posZ: 0.05 };
// Synthetic id for the not-yet-added piece while we test whether it can fit.
const PENDING_ID = "__pending__";
/* Surface presets offered by the "+" menu. Each is a plain-English instruction so
   the same Gemini image edit handles it as a typed request would. */
const FLOOR_PRESETS = [
  { label: "Warm oak wood", swatch: "#b5824a", prompt: "Change the flooring to warm oak wood planks" },
  { label: "Light grey tile", swatch: "#c9ccce", prompt: "Change the flooring to large light grey floor tiles" },
  { label: "White marble", swatch: "#eae7e1", prompt: "Change the flooring to polished white marble" },
  { label: "Dark walnut", swatch: "#5c3a24", prompt: "Change the flooring to dark walnut wood planks" },
];
const WALL_PRESETS = [
  { label: "Warm beige", swatch: "#e3d5c1", prompt: "Change the wall colour to a warm beige" },
  { label: "Soft white", swatch: "#f4f2ee", prompt: "Change the wall colour to a soft off-white" },
  { label: "Sage green", swatch: "#9aa88f", prompt: "Change the wall colour to a muted sage green" },
  { label: "Wood panelling", swatch: "#8a5f3c", prompt: "Change the walls to warm wood panelling" },
];
const clampAnchor = (v: number) => Math.min(0.94, Math.max(0.06, v));
const DEFAULT_CALIB: Calibration = {
  fov: 55,
  nearDepth: 1.7,
  farDepth: 6.5,
  // Furniture at real metric size (100%) reads a touch large in these rooms; 90%
  // sits more convincingly. Users can still fine-tune via Calibrate → Furniture size.
  scale: 0.9,
};

export default function StudioPage() {
  return (
    <Suspense fallback={<div className="h-svh grid place-items-center text-muted">Loading studio…</div>}>
      <Studio />
    </Suspense>
  );
}

function Studio() {
  const params = useSearchParams();
  const projectId = params.get("project");

  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [items, setItems] = useState<PlacedItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [renderOpen, setRenderOpen] = useState(false);
  const [renderEmptyAlert, setRenderEmptyAlert] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [rearranging, setRearranging] = useState(false);
  const [noSpace, setNoSpace] = useState<{ title: string; reason: string } | null>(null);
  const [lighting, setLighting] = useState<{
    sufficient: boolean;
    recommended: number;
    insight: string;
  } | null>(null);
  const [lightingStatus, setLightingStatus] = useState<"loading" | "ready" | "error">("loading");
  const [lightingNonce, setInstalledLightsNonce] = useState(0);
  const [addFilter, setAddFilter] = useState<"all" | "ceiling">("all");
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [panel, setPanel] = useState<"properties" | "calibrate">("properties");
  const [calib, setCalib] = useState<Calibration>(DEFAULT_CALIB);
  const [scaleFitBusy, setScaleFitBusy] = useState(false);
  const [depth, setDepth] = useState<DepthField | null>(null);
  const [depthBusy, setDepthBusy] = useState(false);
  const [cachedFloorSpots, setCachedFloorSpots] = useState<{ ax: number; ay: number; facingDeg: number; confidence?: number }[]>([]);
  // Real furniture/objects occupying the floor (from AI segmentation) — obstacles
  // the deterministic engine must avoid when placing new pieces.
  const [realObjects, setRealObjects] = useState<FloorObjectBox[]>([]);
  const [measureMenuOpen, setMeasureMenuOpen] = useState(false);
  // Manual tools live behind the AI bar's "+" so the room isn't walled in by chrome.
  const [toolsOpen, setToolsOpen] = useState(false);
  // Bumped each time the room analysis lands, so callers can await a fresh one.
  const [analysisNonce, setAnalysisNonce] = useState(0);
  const roomPhotoInputRef = useRef<HTMLInputElement>(null);
  // True once the photo differs from the one the project started with.
  const roomEdited = !!(project?.originalPhotoUrl && project.originalPhotoUrl !== project.photoUrl);
  const [swappingPhoto, setSwappingPhoto] = useState(false);
  // Surface picker ("Change flooring" / "Change wall panel") and the prompt it
  // hands to the AI bar, which confirms before repainting the photo.
  const [surfaceMenu, setSurfaceMenu] = useState<"floor" | "wall" | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  // Calibration (incl. furniture size) persists per project so fixes stick.
  useEffect(() => {
    if (!projectId) return;
    try {
      const saved = window.localStorage.getItem(`calib:${projectId}`);
      setCalib(saved ? { ...DEFAULT_CALIB, ...JSON.parse(saved) } : DEFAULT_CALIB);
    } catch {
      setCalib(DEFAULT_CALIB);
    }
  }, [projectId]);
  const applyCalib = useCallback(
    (updater: (c: Calibration) => Calibration) => {
      setCalib((prev) => {
        const next = updater(prev);
        if (projectId) {
          try {
            window.localStorage.setItem(`calib:${projectId}`, JSON.stringify(next));
          } catch {
            /* ignore */
          }
        }
        return next;
      });
    },
    [projectId],
  );
  const [showDetected, setShowDetected] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Overlays are OFF by default so the room stays the hero — the homeowner turns
  // measurements on contextually from the Measure menu when they want them.
  const [measureConfig, setMeasureConfig] = useState<MeasureConfig>({
    productDims: false,
    productSpacing: false,
    roomDims: false,
    unit: "cm",
  });
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 1, h: 1 });

  // Track the canvas box so measurements use the same aspect as the 3D scene.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project]);

  // Load the project scene.
  useEffect(() => {
    let active = true;
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .projectScene(projectId)
      .then((s) => {
        if (!active) return;
        setProject(s.project);
        setItems(s.placements);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId]);

  // Analyse the room depth (Depth Anything V2, in-browser) so furniture auto-seats
  // on the real floor with correct perspective. Placement works with a fallback
  // until this resolves, then re-renders using the depth map.
  useEffect(() => {
    const url = project?.photoUrl;
    if (!url) return;
    let active = true;
    setDepth(null);
    setDepthBusy(true);
    // Depth (floor/perspective). Vanishing point is now determined completely by Gemini AI.
    getDepthField(url)
      .then((d) => {
        if (!active) return;
        setDepth({ ...d, roomYawDeg: 0 });
      })
      .catch(() => {})
      .finally(() => active && setDepthBusy(false));
    return () => {
      active = false;
    };
  }, [project?.photoUrl]);

  // Analyze the room once per project (cached): real floor objects (obstacles) +
  // the floor & ceiling surface lines used to ground pieces so they don't float.
  useEffect(() => {
    const url = project?.photoUrl;
    setSceneCalib(null); // clear any previous room's calibration
    setCachedFloorSpots([]); // invalidate candidate cache when room changes
    if (!url || !projectId) return;
    // Keyed on the PHOTO, not just the project: a restyle produces a new photo,
    // and reusing the old analysis kept furniture the edit had already removed as
    // phantom floor obstacles — which reported a cleared room as 0m² free.
    const cacheKey = `roomAnalysis:${projectId}:${url}`;
    const applyAnalysis = (a: {
      objects: FloorObjectBox[];
      floorTop: number[];
      ceilingBottom: number[];
      nearDepthM?: number;
      farDepthM?: number;
    }) => {
      /* Scale everything to the room's REAL depth. The near/far constants used to
         be fixed at 1.7-6.5m, which suits a living room but not a lift lobby that
         runs 10m+: a chair placed down the corridor was drawn as if it stood 3m
         away when it really stood 8m, so it rendered about 2.5x too large. A hand
         calibration always wins — we only fill in what the user hasn't set. */
      if (
        typeof a.nearDepthM === "number" &&
        typeof a.farDepthM === "number" &&
        a.farDepthM > a.nearDepthM
      ) {
        /* Depth is a MEASUREMENT of the room, so it always follows the analysis —
           gating it on "has the user calibrated?" would strand every project that
           had ever run auto-fit, since that writes the same saved calibration.
           `scale` is taste and stays exactly as the user left it. */
        applyCalib((c) => ({ ...c, nearDepth: a.nearDepthM!, farDepth: a.farDepthM! }));
      }
      setSceneCalib({ floorTop: a.floorTop, ceilingBottom: a.ceilingBottom });
      setRealObjects(a.objects); // state change re-renders the scene with the new calib
      // Signals "this room has been measured". The AI bar waits on this before
      // furnishing a freshly restyled room — placing beforehand meant no floor
      // calibration and no known obstacles, so pieces landed on top of things.
      setAnalysisNonce((n) => n + 1);
    };
    const cached = typeof window !== "undefined" ? window.localStorage.getItem(cacheKey) : null;
    if (cached) {
      try {
        applyAnalysis(JSON.parse(cached));
        return;
      } catch {
        /* fall through to fetch */
      }
    }
    let active = true;
    // Wait for the stage, then capture the photo-only view and analyze it. Retry a
    // few times to ride out a not-yet-ready stage or a transient Gemini 503; never
    // retry a quota error.
    const t = setTimeout(async () => {
      for (let attempt = 0; attempt < 4 && active; attempt++) {
        try {
          const el = stageRef.current;
          if (!el) throw new Error("stage not ready");
          const shot = await capturePhotoView(el, url);
          const analysis = await api.analyze(shot);
          if (!active) return;
          applyAnalysis(analysis);
          try {
            window.localStorage.setItem(cacheKey, JSON.stringify(analysis));
          } catch {
            /* ignore */
          }
          return;
        } catch (e) {
          if (!active) return;
          if ((e as { code?: string }).code === "quota") return; // don't hammer a rate limit
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }, 1200);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [project?.photoUrl, projectId, applyCalib]);

  // Marketplace products that have a usable 3D model.
  useEffect(() => {
    api
      .products()
      .then((p) => setProducts(p.filter((x) => x.modelUrl)))
      .catch(() => {});
  }, []);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const budgetTotal = items.reduce((s, it) => s + it.product.priceInr, 0);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const installedLights = items.filter((it) => it.product.mount === "ceiling").length;

  // Gemini-powered lighting insight — refreshed (debounced) whenever the number of
  // ceiling lights changes, using a screenshot of the current scene.
  useEffect(() => {
    if (installedLights === 0 || !project?.photoUrl) {
      setLighting(null);
      setLightingStatus("loading");
      return;
    }
    const photoUrl = project.photoUrl;
    // Cache per (project, light count): the recommendation is stable for a given
    // room + number of lights, so we don't re-spend a Gemini call on every reload.
    const cacheKey = `lightInsight:${projectId}:${installedLights}`;
    const cached = typeof window !== "undefined" ? window.localStorage.getItem(cacheKey) : null;
    if (cached) {
      try {
        setLighting(JSON.parse(cached));
        setLightingStatus("ready");
        return;
      } catch {
        /* fall through to fetch */
      }
    }

    let active = true;
    setLightingStatus("loading");
    const t = setTimeout(async () => {
      // Retry ONCE for a transient (dropped request / 5xx / timeout), but NEVER on a
      // rate limit — retrying a quota error just burns more quota.
      for (let attempt = 0; attempt < 2 && active; attempt++) {
        try {
          const res = await Promise.race([
            api.lightInsight(photoUrl, installedLights),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 25000)),
          ]);
          if (active) {
            setLighting(res);
            setLightingStatus("ready");
            try {
              window.localStorage.setItem(cacheKey, JSON.stringify(res));
            } catch {
              /* ignore quota/full storage */
            }
          }
          return;
        } catch (e) {
          if (!active) return;
          const rateLimited = (e as { code?: string }).code === "quota";
          if (!rateLimited && attempt < 1) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          setLighting(null);
          setLightingStatus("error");
          return;
        }
      }
    }, 400);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [installedLights, project?.photoUrl, projectId, lightingNonce]);

  const addFurniture = useCallback(
    async (productId: string) => {
      if (!projectId) return { ok: false as const, reason: "not-ready" as const };
      const product = products.find((p) => p.id === productId);
      const mount: "floor" | "ceiling" = product?.mount === "ceiling" ? "ceiling" : "floor";
      const ceiling = mount === "ceiling";
      const aspect = stage.w / Math.max(1, stage.h);
      const region = ceiling ? CEILING_ANCHOR_BAND : floorRegion();
      const samePlane = items.filter((it) => (it.product.mount === "ceiling") === ceiling);
      const fallback = ceiling ? CEILING_FALLBACK : FLOOR_FALLBACK;
      // Real floor objects (segmentation) → obstacle boxes the engine must avoid.
      const obstacles: OBB[] = ceiling
        ? []
        : realObjects.map((b) => objectBoxToOBB(b, aspect, calib, depth));
      const makePending = (ax: number, ay: number, rotationY = 0): PlacedItemDTO => ({
        id: PENDING_ID,
        productId: product!.id,
        product: product!,
        posX: ax,
        posY: 0,
        posZ: ay,
        rotationY,
        tiltX: 0,
        tiltZ: 0,
        scale: DEFAULT_SCALE,
      });
      // Footprint of the new piece, oriented by its facing angle, for OBB spacing.
      const newSpec = (rotationY: number): FootprintSpec => ({
        widthCm: product?.widthCm ?? null,
        depthCm: product?.depthCm ?? null,
        scale: DEFAULT_SCALE,
        yawDeg: (product?.frontYaw ?? 0) + (depth?.roomYawDeg ?? 0) + rotationY,
        mount,
      });

      // ── Layer 1: is there space at all? (pure geometry, no Gemini call) ──
      // Test feasibility on the NEW piece's plane only (a full floor must not block
      // adding a ceiling light, and vice-versa). If even a rearrange of that plane
      // can't seat it without overlap, it's full — stop before spending a Gemini call.
      if (product) {
        const feasible =
          rearrangeAnchors(
            [...samePlane, makePending(fallback.posX, fallback.posZ)],
            aspect,
            calib,
            depth,
            obstacles,
          ).unplaced === 0;
        if (!feasible) {
          setNoSpace({
            title: `No space for ${product.name}`,
            reason: `There isn't enough clear ${ceiling ? "ceiling" : "floor"} space for ${product.name}, even after rearranging. Remove a piece and try again.`,
          });
          setAddOpen(false);
          return { ok: false as const, reason: "no-space" as const };
        }
      }

      // ── Layer 2: space exists → get placement from Cache or Gemini ──
      setPlacing(true);
      let plan: Awaited<ReturnType<typeof api.place>> | null = null;
      let selectedSpot: { ax: number; ay: number; facingDeg: number } | null = null;

      try {
        if (product && project?.photoUrl && stageRef.current) {
          // 2a. Evaluate Cached Candidates (Floor Only)
          if (!ceiling && cachedFloorSpots.length > 0) {
            const scoredCandidates = cachedFloorSpots
              .map((c) => {
                const candSpec = { ...newSpec(c.facingDeg), mount: "floor" as const };
                const isFree = !anchorOverlaps(c.ax, c.ay, candSpec, samePlane, aspect, calib, depth, obstacles);
                // Secondary scoring: prefer center of room horizontally, and higher original confidence
                const dist = Math.abs(c.ax - 0.5); 
                const score = (c.confidence ?? 0.5) - dist * 0.2;
                return { spot: c, isFree, score };
              })
              .filter((c) => c.isFree)
              .sort((a, b) => b.score - a.score);

            if (scoredCandidates.length > 0) {
              const best = scoredCandidates[0].spot;
              selectedSpot = { ax: best.ax, ay: best.ay, facingDeg: best.facingDeg };
              console.log("Used valid cached candidate:", best);
            } else {
              console.log("Cached candidates invalid for footprint, falling back to Gemini.");
            }
          }

          // 2b. Call Gemini if no valid cached spot
          if (!selectedSpot) {
            const shot = await captureComposite(stageRef.current, project.photoUrl);
            plan = await Promise.race([
              api.place({
                image: shot,
                item: {
                  name: product.name,
                  category: product.category,
                  mount,
                  widthCm: product.widthCm,
                  depthCm: product.depthCm,
                  heightCm: product.heightCm,
                },
                placed: items.map((it) => {
                  const a = itemAnchor(it);
                  return { name: it.product.name, mount: it.product.mount, ax: a.ax, ay: a.ay };
                }),
              }),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 25000)),
            ]);

            if (plan) {
              selectedSpot = { ax: plan.ax, ay: plan.ay, facingDeg: plan.facingDeg };
              if (!ceiling && plan.spots && plan.spots.length > 0) {
                // Cache the spots returned by Gemini for future items
                setCachedFloorSpots(plan.spots);
              } else if (!ceiling) {
                setCachedFloorSpots([]);
              }
            }
          }
        }
      } catch {
        plan = null; // network/quota/timeout — fall back to a safe default below
      } finally {
        setPlacing(false);
      }

      // ── Layer 3: snap Gemini's/Cache's suggestion to a real, non-overlapping spot ──
      console.log("Selected spot:", selectedSpot);
      const rawX = selectedSpot ? selectedSpot.ax : fallback.posX;
      const rawY = selectedSpot ? selectedSpot.ay : fallback.posZ;
      const start = ceiling ? ceilingAnchor(rawX, rawY) : { ax: rawX, ay: rawY };

      const facing = ceiling ? 0 : selectedSpot?.facingDeg ?? 0;
      let target = { ax: clampAnchor(start.ax), ay: clampAnchor(start.ay) };
      
      // Ensure floor items are physically in the lower half of the view
      if (!ceiling) {
        target.ay = Math.min(0.94, Math.max(0.55, target.ay));
      }
      console.log("Final target before repack:", target);
      
      let repackMoves: { id: string; ax: number; ay: number }[] = [];
      if (product) {
        // Prefer a spot clear of real floor objects; fall back to avoiding only
        // placed items so a loose obstacle box can't block the add entirely.
        const free =
          findFreeAnchor(start.ax, start.ay, newSpec(facing), samePlane, aspect, calib, depth, region, obstacles) ??
          findFreeAnchor(start.ax, start.ay, newSpec(facing), samePlane, aspect, calib, depth, region, []);
        if (free) {
          target = free;
        }
        // If no completely free spot is found nearby, we no longer aggressively repack
        // the entire room (which annoyed users by shoving their old furniture away).
        // Instead, we just spawn it at the target and let the user drag it to a better spot.
      }

      // Apply any repositioning of existing pieces needed to make room.
      if (repackMoves.length) {
        const byId = new Map(repackMoves.map((a) => [a.id, a] as const));
        setItems((prev) =>
          prev.map((it) => {
            const a = byId.get(it.id);
            return a ? { ...it, posX: a.ax, posZ: a.ay } : it;
          }),
        );
        repackMoves.forEach((a) =>
          api.updatePlacement(a.id, { posX: a.ax, posZ: a.ay }).catch(() => {}),
        );
      }

      const placement = await api.addItem(projectId, productId);
      if (placement) {
        const pos = ceiling
          ? ceilingAnchor(target.ax, target.ay)
          : { ax: clampAnchor(target.ax), ay: clampAnchor(target.ay) };
        const patch = { posX: pos.ax, posZ: pos.ay, rotationY: facing, scale: DEFAULT_SCALE };
        const seated = { ...placement, ...patch };
        setItems((prev) => [...prev, seated]);
        setSelectedId(seated.id);
        api.updatePlacement(seated.id, patch).catch(() => {});
      }
      setAddOpen(false);
      return { ok: true as const };
    },
    [projectId, items, products, project?.photoUrl, stage, calib, depth, realObjects],
  );

  // The room as it looks right now (photo + placed 3D) — what the AI designer
  // reads to judge the space and what's already in it.
  const captureStage = useCallback(async () => {
    if (!stageRef.current || !project?.photoUrl) throw new Error("stage not ready");
    return captureComposite(stageRef.current, project.photoUrl);
  }, [project?.photoUrl]);

  // Compact "what's already here" list for the planner, so it doesn't re-add
  // pieces the room already has.
  const placedSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.product.name, (counts.get(it.product.name) ?? 0) + 1);
    return [...counts].map(([name, qty]) => ({ name, qty }));
  }, [items]);

  // How much floor the planner actually has to work with. Measured with the same
  // geometry the placement engine packs into, so the AI is told a real number
  // instead of judging capacity by eye from the photo.
  const roomCapacity = useMemo(() => {
    const aspect = stage.w / Math.max(1, stage.h);
    const obstacles = realObjects.map((b) => objectBoxToOBB(b, aspect, calib, depth));
    const { totalM2, freeM2 } = floorCapacity(items, aspect, calib, depth, obstacles);
    return { floorAreaM2: totalM2, freeFloorM2: freeM2 };
  }, [items, stage, calib, depth, realObjects]);

  /* Dry-run a plan through the real packing engine before we show it.

     The planner proposes from the photo, so it can over-order for a narrow space.
     Rather than promising pieces that won't fit and apologising after the user
     hits Apply, we pack them here — no DB writes — and hand back the quantities
     that genuinely seat. */
  const fitPlan = useCallback(
    (entries: { productId: string; qty: number }[]) => {
      const aspect = stage.w / Math.max(1, stage.h);
      const obstacles: OBB[] = realObjects.map((b) => objectBoxToOBB(b, aspect, calib, depth));
      let working: PlacedItemDTO[] = [...items];
      const fitted: { productId: string; qty: number }[] = [];

      // Largest pieces first: a sofa that only fits in an empty room should claim
      // its spot before the stools nibble away at the space.
      const order = entries
        .map((e) => ({ entry: e, product: products.find((p) => p.id === e.productId) }))
        .filter((x): x is { entry: typeof x.entry; product: ProductDTO } => !!x.product)
        .sort(
          (a, b) =>
            footprintAreaM2(
              { widthCm: b.product.widthCm, depthCm: b.product.depthCm, scale: DEFAULT_SCALE },
              calib,
            ) -
            footprintAreaM2(
              { widthCm: a.product.widthCm, depthCm: a.product.depthCm, scale: DEFAULT_SCALE },
              calib,
            ),
        );

      for (const { entry, product } of order) {
        const ceiling = product.mount === "ceiling";
        const region = ceiling ? CEILING_ANCHOR_BAND : floorRegion();
        const spec: FootprintSpec = {
          widthCm: product.widthCm,
          depthCm: product.depthCm,
          scale: DEFAULT_SCALE,
          yawDeg: (product.frontYaw ?? 0) + (depth?.roomYawDeg ?? 0),
          mount: ceiling ? "ceiling" : "floor",
        };
        const fallback = ceiling ? CEILING_FALLBACK : FLOOR_FALLBACK;

        let seatedCount = 0;
        for (let i = 0; i < entry.qty; i++) {
          const samePlane = working.filter((it) => (it.product.mount === "ceiling") === ceiling);
          const free =
            findFreeAnchor(fallback.posX, fallback.posZ, spec, samePlane, aspect, calib, depth, region, obstacles) ??
            findFreeAnchor(fallback.posX, fallback.posZ, spec, samePlane, aspect, calib, depth, region, []);
          if (!free) break; // plane is full — stop adding this piece
          seatedCount++;
          working = [
            ...working,
            {
              id: `${PENDING_ID}${working.length}`,
              productId: product.id,
              product,
              posX: free.ax,
              posY: 0,
              posZ: free.ay,
              rotationY: 0,
              tiltX: 0,
              tiltZ: 0,
              scale: DEFAULT_SCALE,
            },
          ];
        }
        if (seatedCount > 0) fitted.push({ productId: product.id, qty: seatedCount });
      }
      return fitted;
    },
    [items, products, stage, calib, depth, realObjects],
  );

  /* Place a whole AI design plan at once.

     addFurniture() can't just be called in a loop: it closes over `items`, so N
     rapid calls all see the same empty room and compute the SAME free anchor —
     which is why an AI plan used to dump every piece on one spot. Here we thread a
     local `working` copy through the loop so each piece is placed against the ones
     before it, and we spend a single Gemini call for the whole batch (its candidate
     spots seed the search; geometry does the separating). */
  const addFurnitureBatch = useCallback(
    async (entries: { productId: string; qty: number }[]) => {
      if (!projectId) return { added: 0, skipped: [] as string[] };

      const queue: ProductDTO[] = [];
      for (const e of entries) {
        const p = products.find((x) => x.id === e.productId);
        if (!p) continue;
        for (let i = 0; i < Math.max(1, e.qty); i++) queue.push(p);
      }
      if (queue.length === 0) return { added: 0, skipped: [] as string[] };

      const aspect = stage.w / Math.max(1, stage.h);
      const obstacles: OBB[] = realObjects.map((b) => objectBoxToOBB(b, aspect, calib, depth));

      setPlacing(true);

      // One Gemini call for the batch: its candidate spots become seeds we cycle
      // through, so pieces start in sensible, spread-out parts of the room.
      let seeds: { ax: number; ay: number; facingDeg: number }[] = [];
      const leadFloor = queue.find((p) => p.mount !== "ceiling");
      try {
        if (leadFloor && project?.photoUrl && stageRef.current) {
          const shot = await captureComposite(stageRef.current, project.photoUrl);
          const plan = await Promise.race([
            api.place({
              image: shot,
              item: {
                name: leadFloor.name,
                category: leadFloor.category,
                mount: "floor",
                widthCm: leadFloor.widthCm,
                depthCm: leadFloor.depthCm,
                heightCm: leadFloor.heightCm,
              },
              placed: items.map((it) => {
                const a = itemAnchor(it);
                return { name: it.product.name, mount: it.product.mount, ax: a.ax, ay: a.ay };
              }),
            }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 25000)),
          ]);
          if (plan) {
            seeds = [
              { ax: plan.ax, ay: plan.ay, facingDeg: plan.facingDeg ?? 0 },
              ...(plan.spots ?? []).map((s) => ({ ax: s.ax, ay: s.ay, facingDeg: s.facingDeg ?? 0 })),
            ];
          }
        }
      } catch {
        seeds = []; // quota/timeout — geometry-only placement below still works
      }

      let working: PlacedItemDTO[] = [...items];
      const skipped: string[] = [];
      let added = 0;
      let floorIndex = 0;

      for (const product of queue) {
        const ceiling = product.mount === "ceiling";
        const region = ceiling ? CEILING_ANCHOR_BAND : floorRegion();
        const samePlane = working.filter((it) => (it.product.mount === "ceiling") === ceiling);
        const spec: FootprintSpec = {
          widthCm: product.widthCm,
          depthCm: product.depthCm,
          scale: DEFAULT_SCALE,
          yawDeg: (product.frontYaw ?? 0) + (depth?.roomYawDeg ?? 0),
          mount: ceiling ? "ceiling" : "floor",
        };

        // Seed: cycle Gemini's candidates for floor pieces so they don't all start
        // from the same point; ceiling fixtures spread along the ceiling band.
        let start: { ax: number; ay: number };
        let facing = 0;
        if (ceiling) {
          const n = samePlane.length;
          start = ceilingAnchor(n === 0 ? 0.5 : 0.5 + (n % 2 === 1 ? 0.18 : -0.18) * Math.ceil(n / 2), CEILING_FALLBACK.posZ);
        } else if (seeds.length) {
          const seed = seeds[floorIndex % seeds.length];
          floorIndex++;
          start = { ax: seed.ax, ay: Math.min(0.94, Math.max(0.55, seed.ay)) };
          facing = seed.facingDeg;
        } else {
          start = { ax: FLOOR_FALLBACK.posX, ay: FLOOR_FALLBACK.posZ };
        }

        const free =
          findFreeAnchor(start.ax, start.ay, spec, samePlane, aspect, calib, depth, region, obstacles) ??
          findFreeAnchor(start.ax, start.ay, spec, samePlane, aspect, calib, depth, region, []);
        if (!free) {
          // Genuinely no clear space left on this plane — report instead of stacking.
          if (!skipped.includes(product.name)) skipped.push(product.name);
          continue;
        }

        const placement = await api.addItem(projectId, product.id);
        if (!placement) continue;
        const pos = ceiling
          ? ceilingAnchor(free.ax, free.ay)
          : { ax: clampAnchor(free.ax), ay: clampAnchor(free.ay) };
        const patch = { posX: pos.ax, posZ: pos.ay, rotationY: ceiling ? 0 : facing, scale: DEFAULT_SCALE };
        const seated = { ...placement, ...patch };
        working = [...working, seated];
        added++;
        setItems((prev) => [...prev, seated]);
        api.updatePlacement(seated.id, patch).catch(() => {});
      }

      setPlacing(false);
      if (skipped.length) {
        setNoSpace({
          title: "Not everything fit",
          reason: `I placed what I could, but there wasn't clear floor space left for: ${skipped.join(", ")}. Remove a piece or try a smaller set.`,
        });
      }
      return { added, skipped };
    },
    [projectId, items, products, project?.photoUrl, stage, calib, depth, realObjects],
  );

  // Re-pack the whole room into a non-overlapping layout (pure geometry, no AI).
  // Fixes pieces placed before spacing existed, or after manual dragging.
  const rearrangeRoom = useCallback(async () => {
    if (items.length < 2) return;
    setRearranging(true);
    const aspect = stage.w / Math.max(1, stage.h);
    const obstacles = realObjects.map((b) => objectBoxToOBB(b, aspect, calib, depth));
    const { anchors, unplaced } = rearrangeAnchors(items, aspect, calib, depth, obstacles);
    const byId = new Map(anchors.map((a) => [a.id, a] as const));
    setItems((prev) =>
      prev.map((it) => {
        const a = byId.get(it.id);
        return a ? { ...it, posX: a.ax, posZ: a.ay } : it;
      }),
    );
    await Promise.all(
      anchors.map((a) =>
        api.updatePlacement(a.id, { posX: a.ax, posZ: a.ay }).catch(() => {}),
      ),
    );
    setRearranging(false);
    // Some pieces couldn't be separated — the room is over capacity.
    if (unplaced > 0) {
      setNoSpace({
        title: "Room is over capacity",
        reason: `Arranged as much as possible, but ${unplaced} piece${unplaced === 1 ? "" : "s"} couldn't be separated without overlap. Remove a piece for a clean layout.`,
      });
    }
  }, [items, stage, calib, depth, realObjects]);

  // AI auto-fit: ask Gemini if the placed furniture is realistically sized for the
  // room, and adjust the global furniture-size calibration to match.
  const autoFitScale = useCallback(async () => {
    if (!project?.photoUrl || !stageRef.current || items.length === 0) return;
    setScaleFitBusy(true);
    try {
      const shot = await captureComposite(stageRef.current, project.photoUrl);
      const m = await api.scaleFit(shot);
      applyCalib((c) => ({ ...c, scale: Math.min(2, Math.max(0.4, c.scale * m)) }));
    } catch {
      /* leave scale unchanged on failure */
    } finally {
      setScaleFitBusy(false);
    }
  }, [project?.photoUrl, items.length, applyCalib]);

  // AI chat edited the room's base photo (wallpaper/curtains/paint/flooring). Swap the
  // base image; furniture (a 3D overlay) stays. Invalidate photo-derived AI caches so
  // depth, floor/ceiling calibration, obstacles and lighting re-run for the new look.
  const onRoomEdited = useCallback(
    (newPhotoUrl: string) => {
      setProject((p) => (p ? { ...p, photoUrl: newPhotoUrl } : p));
      if (projectId && typeof window !== "undefined") {
        try {
          // Analyses are keyed per photo, so drop every one for this project —
          // including entries left by earlier edits.
          for (const k of Object.keys(window.localStorage)) {
            if (k.startsWith(`roomAnalysis:${projectId}`)) window.localStorage.removeItem(k);
          }
          for (let i = 0; i <= 12; i++) window.localStorage.removeItem(`lightInsight:${projectId}:${i}`);
        } catch {
          /* ignore */
        }
      }
      setRealObjects([]);
      setSceneCalib(null);
      setLighting(null);
      setLightingStatus("loading");
    },
    [projectId],
  );

  // Restore the project's original room photo (undo AI room edits).
  const revertRoom = useCallback(async () => {
    if (!projectId) return;
    const url = await api.revertRoom(projectId);
    onRoomEdited(url);
  }, [projectId, onRoomEdited]);

  /** Replace the room photo with one the user picks. Revert restores the old one. */
  const changeRoomPhoto = useCallback(
    async (file: File) => {
      if (!projectId) return;
      setSwappingPhoto(true);
      try {
        const { url } = await api.uploadFile(file, "rooms");
        await api.setProjectPhoto(projectId, url);
        onRoomEdited(url); // clears caches, re-runs analysis for the new room
      } catch {
        setNoSpace({
          title: "Couldn't change the photo",
          reason: "That image couldn't be uploaded. Try a JPG or PNG of the room.",
        });
      } finally {
        setSwappingPhoto(false);
      }
    },
    [projectId, onRoomEdited],
  );

  // Live drag — update local position only (cheap, runs every pointer move).
  const liveMove = useCallback((id: string, x: number, z: number) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, posX: x, posZ: z } : it)),
    );
  }, []);

  // On drop — persist the final position to the database.
  const dropItem = useCallback((id: string) => {
    setItems((prev) => {
      const it = prev.find((x) => x.id === id);
      if (it) api.updatePlacement(id, { posX: it.posX, posZ: it.posZ }).catch(() => {});
      return prev;
    });
  }, []);

  const updateSelected = useCallback(
    (
      patch: Partial<Pick<PlacedItemDTO, "rotationY" | "tiltX" | "tiltZ" | "scale">>,
      persist = false,
    ) => {
      if (!selectedId) return;
      setItems((prev) =>
        prev.map((it) => (it.id === selectedId ? { ...it, ...patch } : it)),
      );
      if (persist) api.updatePlacement(selectedId, patch).catch(() => {});
    },
    [selectedId],
  );

  const removeSelected = useCallback(async () => {
    if (!selectedId) return;
    const id = selectedId;
    setItems((prev) => prev.filter((it) => it.id !== id));
    setSelectedId(null);
    api.deletePlacement(id).catch(() => {});
  }, [selectedId]);

  // ---- Empty / loading states -------------------------------------------
  if (!projectId) {
    return <NoProject />;
  }

  return (
    <div className="flex h-svh overflow-hidden">
      {/* Canvas area */}
      <div className="relative flex-1 min-w-0 bg-surface-muted">
        {/* Top floating bar */}
        <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between gap-3 pointer-events-none">
          <Link href="/projects" className="pointer-events-auto">
            <button className="inline-flex items-center gap-2 h-10 px-3.5 rounded-xl glass border border-border text-sm font-medium hover:bg-surface transition-colors">
              <ChevronLeft className="h-4 w-4" /> Projects
            </button>
          </Link>
          <div className="glass border border-border rounded-xl px-4 h-10 flex items-center text-sm font-medium pointer-events-auto">
            {project?.name ?? "Loading…"}
          </div>
          <Button
            size="sm"
            className="pointer-events-auto"
            disabled={!project}
            onClick={() => (items.length === 0 ? setRenderEmptyAlert(true) : setRenderOpen(true))}
          >
            <Sparkles className="h-4 w-4" /> Render Scene
          </Button>
        </div>

        {/* Live budget */}
        {project && (
          <div className="absolute top-[72px] left-4 z-20">
            <button
              onClick={() => setBudgetOpen((o) => !o)}
              className="glass border border-border rounded-2xl shadow-[var(--shadow-md)] flex items-center gap-2.5 h-11 pl-3 pr-3.5 hover:bg-surface transition-colors"
            >
              <span className="grid place-items-center h-7 w-7 rounded-lg brand-gradient text-white">
                <Wallet className="h-4 w-4" />
              </span>
              <span className="text-left leading-tight">
                <span className="block text-[11px] text-muted">Room total</span>
                <span className="block font-semibold text-[15px] -mt-0.5">
                  {formatINRFull(budgetTotal)}
                </span>
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted transition-transform",
                  budgetOpen && "rotate-180",
                )}
              />
            </button>

            <AnimatePresence>
              {budgetOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="mt-2 w-72 glass border border-border rounded-2xl shadow-[var(--shadow-lg)] p-3 max-h-[50vh] overflow-y-auto"
                >
                  {items.length === 0 ? (
                    <p className="text-sm text-muted text-center py-4">
                      No furniture added yet.
                    </p>
                  ) : (
                    <>
                      <div className="space-y-1">
                        {items.map((it) => (
                          <button
                            key={it.id}
                            onClick={() => setSelectedId(it.id)}
                            className={cn(
                              "w-full flex items-center gap-2.5 p-2 rounded-xl text-left hover:bg-surface-muted transition-colors",
                              selectedId === it.id && "bg-surface-muted",
                            )}
                          >
                            <span className="relative h-9 w-9 rounded-lg overflow-hidden shrink-0">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={it.product.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium truncate">{it.product.name}</span>
                              <span className="block text-xs text-subtle">{it.product.category}</span>
                            </span>
                            <span className="text-sm font-semibold shrink-0">
                              {formatINR(it.product.priceInr)}
                            </span>
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center justify-between px-2 pt-2.5 mt-1.5 border-t border-border">
                        <span className="text-sm text-muted">
                          {items.length} item{items.length === 1 ? "" : "s"}
                        </span>
                        <span className="font-semibold text-primary">
                          {formatINRFull(budgetTotal)}
                        </span>
                      </div>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Room photo backdrop + 3D overlay */}
        {loading ? (
          <div className="absolute inset-0 grid place-items-center">
            <Skeleton className="h-full w-full" />
          </div>
        ) : project ? (
          <div className="absolute inset-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={project.photoUrl}
              alt={project.name}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div ref={stageRef} className="absolute inset-0">
              <RoomScene
                items={items}
                calib={calib}
                depth={depth}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={liveMove}
                onDrop={dropItem}
              />
              {measureConfig && (measureConfig.productDims || measureConfig.productSpacing || measureConfig.roomDims) ? (
                <MeasureOverlay
                  items={items}
                  selectedId={selectedId}
                  aspect={stage.w / Math.max(1, stage.h)}
                  calib={calib}
                  depth={depth}
                  config={measureConfig}
                />
              ) : null}
              {/* Detected real floor objects (obstacles the AI avoids). */}
              {showDetected
                ? realObjects.map((o, i) => (
                    <div
                      key={`obj-${i}`}
                      className="absolute border-2 border-dashed border-amber-400/80 rounded pointer-events-none"
                      style={{
                        left: `${o.x0 * 100}%`,
                        top: `${o.y0 * 100}%`,
                        width: `${(o.x1 - o.x0) * 100}%`,
                        height: `${(o.y1 - o.y0) * 100}%`,
                      }}
                    >
                      <span className="absolute -top-5 left-0 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white whitespace-nowrap">
                        {o.label}
                      </span>
                    </div>
                  ))
                : null}
            </div>

            {depthBusy && (
              <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
                <div className="glass border border-border rounded-full px-4 h-9 flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 text-primary animate-spin" />
                  Analyzing room depth…
                </div>
              </div>
            )}

            {/* Show the lighting nudge only when it's actionable — hide the persistent
                "looks good" pill so it doesn't sit over the room permanently. */}
            {installedLights > 0 && !(lightingStatus === "ready" && lighting?.sufficient) && (
              <LightingRecommendation
                installed={installedLights}
                insight={lighting}
                status={lightingStatus}
                onRetry={() => setInstalledLightsNonce((n) => n + 1)}
              />
            )}

            {/* AI is deciding where the new piece goes */}
            {placing && (
              <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
                <div className="glass border border-border rounded-full px-4 h-9 flex items-center gap-2 text-sm shadow-[var(--shadow-md)]">
                  <Loader2 className="h-4 w-4 text-primary animate-spin" />
                  Finding the best spot…
                </div>
              </div>
            )}

            {/* No room for the requested piece */}
            <AnimatePresence>
              {noSpace && (
                <motion.div
                  className="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 pointer-events-auto"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                >
                  <div className="max-w-sm bg-surface border border-amber-500/40 rounded-2xl shadow-[var(--shadow-lg)] p-3.5 flex gap-3">
                    <div className="grid place-items-center h-9 w-9 shrink-0 rounded-xl bg-amber-500/15 text-amber-600">
                      <X className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{noSpace.title}</p>
                      <p className="text-xs text-muted mt-0.5 leading-relaxed">{noSpace.reason}</p>
                      <button
                        onClick={() => setNoSpace(null)}
                        className="mt-2 text-xs font-medium text-primary hover:underline"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {items.length === 0 && (
              <div className="absolute inset-x-0 top-32 grid place-items-center pointer-events-none">
                <div className="glass border border-border rounded-2xl px-5 py-3 text-sm text-center max-w-sm">
                  <p className="font-medium">Your room is ready</p>
                  <p className="text-muted mt-0.5">
                    Tell the AI below what you want this space to become — it
                    designs it from your marketplace and seats everything on the floor.
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-center px-6">
            <p className="text-muted">Project not found.</p>
          </div>
        )}

        <input
          ref={roomPhotoInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // let the same file be picked again
            if (f) changeRoomPhoto(f);
          }}
        />

        {/* Bottom cluster — ONE row, so the room stays the hero. The AI bar is the
            only permanent control; the manual tools live behind its "+" menu. */}
        <div className="absolute inset-x-0 bottom-4 z-30 flex flex-col items-center gap-2 px-4 pointer-events-none">
          <StudioChat
            products={products}
            onAdd={addFurniture}
            projectId={projectId ?? undefined}
            photoUrl={project?.photoUrl}
            onRoomEdited={onRoomEdited}
            onRevert={revertRoom}
            edited={roomEdited}
            capture={captureStage}
            placed={placedSummary}
            capacity={roomCapacity}
            onFitPlan={fitPlan}
            onApplyPlan={addFurnitureBatch}
            roomEmpty={items.length === 0}
            analysisNonce={analysisNonce}
            pendingPrompt={pendingPrompt}
            onPendingPromptHandled={() => setPendingPrompt(null)}
            tools={
              <div className="relative shrink-0">
                {(toolsOpen || measureMenuOpen || surfaceMenu) && (
                  <button
                    aria-label="Close tools"
                    onClick={() => {
                      setToolsOpen(false);
                      setMeasureMenuOpen(false);
                      setSurfaceMenu(null);
                    }}
                    className="fixed inset-0 z-0 cursor-default"
                  />
                )}
                <button
                  onClick={() => {
                    if (measureMenuOpen) setMeasureMenuOpen(false);
                    if (surfaceMenu) setSurfaceMenu(null);
                    setToolsOpen((o) => !o);
                  }}
                  title="Tools"
                  aria-label="Tools"
                  aria-expanded={toolsOpen}
                  className={cn(
                    "relative z-10 grid place-items-center h-9 w-9 rounded-xl transition-colors",
                    toolsOpen || measureMenuOpen || surfaceMenu
                      ? "bg-primary/10 text-primary"
                      : "text-muted hover:bg-surface-muted hover:text-foreground",
                  )}
                >
                  <Plus className={cn("h-5 w-5 transition-transform", toolsOpen && "rotate-45")} />
                </button>

                <AnimatePresence>
                  {/* Flooring / wall presets — one click sends the AI a request,
                      which then asks for confirmation before repainting. */}
                  {surfaceMenu && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      className="absolute bottom-full left-0 z-10 mb-2 w-60 bg-white dark:bg-zinc-900 border border-border rounded-2xl shadow-[var(--shadow-lg)] p-1.5"
                    >
                      <button
                        onClick={() => {
                          setSurfaceMenu(null);
                          setToolsOpen(true);
                        }}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground transition-colors"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" /> Tools
                      </button>
                      {(surfaceMenu === "floor" ? FLOOR_PRESETS : WALL_PRESETS).map((preset) => (
                        <ToolItem
                          key={preset.label}
                          icon={
                            <span
                              className="h-4 w-4 rounded-full border border-black/10 dark:border-white/15"
                              style={{ background: preset.swatch }}
                            />
                          }
                          label={preset.label}
                          onClick={() => {
                            setSurfaceMenu(null);
                            setPendingPrompt(preset.prompt);
                          }}
                        />
                      ))}
                    </motion.div>
                  )}

                  {/* Measure options replace the tool list rather than nesting. */}
                  {measureMenuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      className="absolute bottom-full left-0 z-10 mb-2 w-72 bg-white dark:bg-zinc-900 border border-border rounded-2xl shadow-[var(--shadow-lg)] p-4 space-y-4"
                    >
                      <button
                        onClick={() => {
                          setMeasureMenuOpen(false);
                          setToolsOpen(true);
                        }}
                        className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground transition-colors"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" /> Tools
                      </button>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">Product dimensions</span>
                        <Toggle
                          checked={measureConfig.productDims}
                          onChange={(c) => setMeasureConfig(m => ({ ...m, productDims: c }))}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">Product spacing</span>
                        <Toggle
                          checked={measureConfig.productSpacing}
                          onChange={(c) => setMeasureConfig(m => ({ ...m, productSpacing: c }))}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">Room dimensions</span>
                        <Toggle
                          checked={measureConfig.roomDims}
                          onChange={(c) => setMeasureConfig(m => ({ ...m, roomDims: c }))}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">
                          Detected objects
                          {realObjects.length > 0 ? ` (${realObjects.length})` : ""}
                        </span>
                        <Toggle checked={showDetected} onChange={setShowDetected} />
                      </div>
                      <div className="flex items-center justify-between pt-3 border-t border-border">
                        <span className="text-sm font-semibold">Unit</span>
                        <div className="flex w-32 bg-surface-muted rounded-xl border border-border p-1">
                          <button
                            onClick={() => setMeasureConfig(m => ({ ...m, unit: "ft" }))}
                            className={cn(
                              "flex-1 h-8 text-xs font-bold rounded-lg transition-all",
                              measureConfig.unit === "ft" ? "bg-white dark:bg-zinc-800 shadow-sm text-foreground" : "text-muted hover:text-foreground"
                            )}
                          >
                            ft
                          </button>
                          <button
                            onClick={() => setMeasureConfig(m => ({ ...m, unit: "cm" }))}
                            className={cn(
                              "flex-1 h-8 text-xs font-bold rounded-lg transition-all",
                              measureConfig.unit === "cm" ? "bg-white dark:bg-zinc-800 shadow-sm text-foreground" : "text-muted hover:text-foreground"
                            )}
                          >
                            cm
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {toolsOpen && !measureMenuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      className="absolute bottom-full left-0 z-10 mb-2 w-56 bg-white dark:bg-zinc-900 border border-border rounded-2xl shadow-[var(--shadow-lg)] p-1.5"
                    >
                      <ToolItem
                        icon={<Plus className="h-4 w-4 text-primary" />}
                        label="Add furniture"
                        onClick={() => {
                          setAddFilter("all");
                          setAddOpen(true);
                          setToolsOpen(false);
                        }}
                      />
                      <ToolItem
                        icon={<Lightbulb className="h-4 w-4" />}
                        label="Add a ceiling light"
                        onClick={() => {
                          setAddFilter("ceiling");
                          setAddOpen(true);
                          setToolsOpen(false);
                        }}
                      />
                      <ToolItem
                        icon={rearranging ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <Shuffle className="h-4 w-4" />}
                        label="Auto-arrange room"
                        disabled={rearranging || items.length < 2}
                        onClick={() => {
                          setToolsOpen(false);
                          rearrangeRoom();
                        }}
                      />
                      <ToolItem
                        icon={<Grid2x2 className="h-4 w-4" />}
                        label="Change flooring"
                        onClick={() => {
                          setToolsOpen(false);
                          setSurfaceMenu("floor");
                        }}
                      />
                      <ToolItem
                        icon={<Paintbrush className="h-4 w-4" />}
                        label="Change wall panel"
                        onClick={() => {
                          setToolsOpen(false);
                          setSurfaceMenu("wall");
                        }}
                      />
                      <ToolItem
                        icon={
                          swappingPhoto ? (
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                          ) : (
                            <ImagePlus className="h-4 w-4" />
                          )
                        }
                        label="Change room photo"
                        disabled={swappingPhoto}
                        onClick={() => {
                          setToolsOpen(false);
                          roomPhotoInputRef.current?.click();
                        }}
                      />
                      {roomEdited && (
                        <ToolItem
                          icon={<RotateCcw className="h-4 w-4" />}
                          label="Revert room photo"
                          onClick={() => {
                            setToolsOpen(false);
                            revertRoom();
                          }}
                        />
                      )}
                      <ToolItem
                        icon={<Ruler className="h-4 w-4" />}
                        label="Measurements"
                        onClick={() => {
                          setToolsOpen(false);
                          setMeasureMenuOpen(true);
                        }}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            }
          />
        </div>

        {/* Photorealistic render of the composited scene */}
        {project && (
          <RenderDialog
            open={renderOpen}
            onClose={() => setRenderOpen(false)}
            stageRef={stageRef}
            photoUrl={project.photoUrl}
            projectId={projectId ?? undefined}
            ceilingLights={installedLights}
            pieces={placedSummary.map((p) => (p.qty > 1 ? `${p.qty} × ${p.name}` : p.name))}
          />
        )}

        {/* Render pressed with an empty room — nudge the user to add furniture first */}
        <AnimatePresence>
          {renderEmptyAlert && (
            <motion.div
              className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setRenderEmptyAlert(false)}
            >
              <motion.div
                initial={{ scale: 0.96, y: 8 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.96, y: 8 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm rounded-3xl bg-surface border border-border shadow-[var(--shadow-lg)] p-6 text-center"
              >
                <div className="grid place-items-center h-14 w-14 rounded-2xl bg-primary/10 text-primary mx-auto mb-4">
                  <Sparkles className="h-7 w-7" />
                </div>
                <h3 className="text-lg font-semibold tracking-tight">Nothing to render yet</h3>
                <p className="text-muted text-sm mt-1.5">
                  Add furniture to the room and arrange it, then hit{" "}
                  <span className="font-medium text-foreground">Render Scene</span> to get a
                  photorealistic image.
                </p>
                <div className="flex gap-2 mt-5">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setRenderEmptyAlert(false)}
                  >
                    Got it
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => {
                      setRenderEmptyAlert(false);
                      setAddFilter("all");
                      setAddOpen(true);
                    }}
                  >
                    <Plus className="h-4 w-4" /> Add furniture
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Right context panel */}
      <aside className="hidden xl:flex flex-col w-[340px] shrink-0 border-l border-border bg-surface">
        <div className="flex p-1.5 m-3 rounded-xl bg-surface-muted">
          {(["properties", "calibrate"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPanel(p)}
              className={cn(
                "flex-1 h-9 rounded-lg text-sm font-medium capitalize transition-colors relative",
                panel === p ? "text-foreground" : "text-muted",
              )}
            >
              {panel === p && (
                <motion.span
                  layoutId="studio-panel-tab"
                  className="absolute inset-0 bg-surface rounded-lg shadow-[var(--shadow-sm)]"
                />
              )}
              <span className="relative z-10 flex items-center justify-center gap-1.5">
                {p === "properties" ? <Sliders className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
                {p}
              </span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-6">
          {panel === "calibrate" ? (
            <div className="space-y-5">
              <p className="text-sm text-muted">
                Placement is automatic — the room&apos;s depth is detected by AI and
                furniture seats on the floor with correct perspective. These are
                optional fine-tuning controls.
              </p>
              {/* AI auto-fit — the quickest fix for over/undersized furniture. */}
              <div className="p-4 rounded-2xl border border-primary/30 bg-primary/5">
                <div className="flex items-center gap-2 text-sm font-medium mb-1">
                  <Sparkles className="h-4 w-4 text-primary" /> Auto-fit furniture size
                </div>
                <p className="text-xs text-muted mb-3">
                  Let AI check if your furniture is sized realistically for the room and
                  correct it.
                </p>
                <Button
                  className="w-full"
                  onClick={autoFitScale}
                  disabled={scaleFitBusy || items.length === 0}
                >
                  {scaleFitBusy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Checking…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" /> Auto-fit with AI
                    </>
                  )}
                </Button>
              </div>
              <SliderRow
                label="Field of view"
                icon={Camera}
                value={calib.fov}
                min={35}
                max={85}
                step={1}
                suffix="°"
                onChange={(v) => applyCalib((c) => ({ ...c, fov: v }))}
              />
              <SliderRow
                label="Front distance"
                icon={Maximize2}
                value={Math.round(calib.nearDepth * 100)}
                min={80}
                max={400}
                step={5}
                suffix="cm"
                onChange={(v) => applyCalib((c) => ({ ...c, nearDepth: v / 100 }))}
              />
              <SliderRow
                label="Back distance"
                icon={Maximize2}
                value={Math.round(calib.farDepth * 100)}
                min={300}
                max={1200}
                step={10}
                suffix="cm"
                onChange={(v) => applyCalib((c) => ({ ...c, farDepth: v / 100 }))}
              />
              <SliderRow
                label="Furniture size"
                icon={Box}
                value={Math.round(calib.scale * 100)}
                min={40}
                max={200}
                step={5}
                suffix="%"
                onChange={(v) => applyCalib((c) => ({ ...c, scale: v / 100 }))}
              />
              <Button variant="secondary" className="w-full" onClick={() => applyCalib(() => DEFAULT_CALIB)}>
                Reset calibration
              </Button>
            </div>
          ) : selected ? (
              <div className="space-y-5">
                <div className="relative aspect-[4/3] rounded-2xl overflow-hidden border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={selected.product.thumbnailUrl} alt={selected.product.name} className="h-full w-full object-cover" />
                </div>
                <div>
                  <p className="text-xs text-subtle">{selected.product.category}</p>
                  <p className="font-semibold text-lg tracking-tight">{selected.product.name}</p>
                  <p className="text-primary font-semibold">{formatINR(selected.product.priceInr)}</p>
                </div>

                {/* Friendly, non-technical cue — AI handles placement automatically. */}
                <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-primary/5 border border-primary/15">
                  <Sparkles className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  <p className="text-xs text-muted leading-relaxed">
                    {selected.product.mount === "ceiling"
                      ? "Placed on the ceiling by AI. Drag it to reposition — it stays flush to the ceiling."
                      : "Placed on the floor by AI. Just drag it in the room to move it — no setup needed."}
                  </p>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <Dim label="Length" v={selected.product.depthCm} />
                  <Dim label="Width" v={selected.product.widthCm} />
                  <Dim label="Height" v={selected.product.heightCm} />
                </div>

                <Button variant="outline" className="w-full !text-rose-500 !border-rose-500/30 hover:!bg-rose-500/10" onClick={removeSelected}>
                  <Trash2 className="h-4 w-4" /> Remove from room
                </Button>

                {/* Advanced 3D controls — hidden by default so the panel isn't intimidating. */}
                <div className="border-t border-border pt-3">
                  <button
                    onClick={() => setAdvancedOpen((v) => !v)}
                    aria-expanded={advancedOpen}
                    className="w-full flex items-center justify-between text-sm font-medium text-muted hover:text-foreground transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      <Sliders className="h-4 w-4" /> Advanced controls
                    </span>
                    <ChevronDown className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />
                  </button>
                  {advancedOpen && (
                    <div className="space-y-4 mt-4">
                      <SliderRow
                        label="Rotation"
                        icon={RotateCw}
                        value={selected.rotationY}
                        min={0}
                        max={360}
                        step={1}
                        suffix="°"
                        onChange={(v) => updateSelected({ rotationY: v })}
                        onCommit={(v) => updateSelected({ rotationY: v }, true)}
                      />
                      {selected.product.mount !== "ceiling" && (
                        <>
                          <SliderRow
                            label="Lean — front / back"
                            icon={Move3d}
                            value={Math.round(selected.tiltX)}
                            min={-30}
                            max={30}
                            step={1}
                            suffix="°"
                            onChange={(v) => updateSelected({ tiltX: v })}
                            onCommit={(v) => updateSelected({ tiltX: v }, true)}
                          />
                          <SliderRow
                            label="Lean — side"
                            icon={Move3d}
                            value={Math.round(selected.tiltZ)}
                            min={-30}
                            max={30}
                            step={1}
                            suffix="°"
                            onChange={(v) => updateSelected({ tiltZ: v })}
                            onCommit={(v) => updateSelected({ tiltZ: v }, true)}
                          />
                        </>
                      )}
                      <SliderRow
                        label="Size"
                        icon={Box}
                        value={Math.round(selected.scale * 100)}
                        min={50}
                        max={200}
                        step={1}
                        suffix="%"
                        onChange={(v) => updateSelected({ scale: v / 100 })}
                        onCommit={(v) => updateSelected({ scale: v / 100 }, true)}
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-16 text-muted">
                <Sliders className="h-8 w-8 mx-auto mb-3 text-subtle" />
                <p className="font-medium">Nothing selected</p>
                <p className="text-sm mt-1">
                  Tap a piece in the room to edit it, or add one from the dock.
                </p>
              </div>
          )}
        </div>
      </aside>

      {/* Add furniture sheet */}
      <AnimatePresence>
        {addOpen && (
          <AddFurnitureSheet
            products={products}
            onAdd={addFurniture}
            onClose={() => setAddOpen(false)}
            initialFilter={addFilter}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function LightingRecommendation({
  installed,
  insight,
  status,
  onRetry,
}: {
  installed: number;
  insight: { sufficient: boolean; recommended: number; insight: string } | null;
  status: "loading" | "ready" | "error";
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const enough = insight?.sufficient ?? true;
  const additional = insight ? Math.max(0, insight.recommended - installed) : 0;

  const label =
    status === "loading"
      ? "Analyzing lighting…"
      : status === "error"
        ? "Lighting check unavailable"
        : enough
          ? "Lighting looks good"
          : `Add ${additional} more light${additional === 1 ? "" : "s"}`;

  return (
    <div className="absolute top-24 right-5 z-20 pointer-events-auto">
      <button
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className={cn(
          "glass border border-border rounded-full shadow-[var(--shadow-md)] h-10 px-3.5 flex items-center gap-2 text-sm font-medium transition-colors hover:bg-surface",
          status === "loading"
            ? "text-muted"
            : status === "error"
              ? "text-muted"
              : enough
                ? "text-emerald-600"
                : "text-amber-600",
        )}
      >
        {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lightbulb className="h-4 w-4" />}
        {label}
      </button>
      {expanded && (
        <div className="absolute right-0 mt-2 w-72 glass border border-border rounded-2xl shadow-[var(--shadow-lg)] p-3.5">
          <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> AI lighting check
          </p>
          {status === "error" ? (
            <>
              <p className="text-xs text-muted mt-1 leading-relaxed">
                Couldn&apos;t reach the AI lighting check. It may be rate-limited or offline.
              </p>
              <button onClick={onRetry} className="mt-2 text-xs font-medium text-primary hover:underline">
                Try again
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-muted mt-1 leading-relaxed">
                {status === "loading"
                  ? "Assessing the room's ambient light…"
                  : insight?.insight}
              </p>
              {status === "ready" && insight && (
                <p className="text-[11px] text-subtle mt-1.5">
                  {installed} placed · {insight.recommended} recommended for this room.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SliderRow({
  label, icon: Icon, value, min, max, step, suffix, onChange, onCommit,
}: {
  label: string; icon: typeof RotateCw; value: number; min: number; max: number;
  step: number; suffix: string; onChange: (v: number) => void; onCommit?: (v: number) => void;
}) {
  return (
    <div className="p-4 rounded-2xl border border-border bg-surface-2">
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Icon className="h-4 w-4 text-primary" /> {label}
        </span>
        <span className="text-sm text-muted">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        className="w-full accent-[var(--primary)]"
        aria-label={label}
      />
    </div>
  );
}

function Dim({ label, v }: { label: string; v: number | null }) {
  return (
    <div className="p-2.5 rounded-xl border border-border bg-surface-2">
      <p className="text-xs text-subtle">{label}</p>
      <p className="font-medium text-sm mt-0.5">{v ? `${v}` : "—"}</p>
    </div>
  );
}

// ── Catalog taxonomy — buckets any product into a friendly category, and infers
//    material for the filter, so the library scales as the client adds models. ──
const CATEGORY_ORDER = ["Sofas", "Chairs", "Tables", "Beds", "Storage", "Lighting", "Decor", "Other"];
const CATEGORY_RULES: [string, RegExp][] = [
  ["Sofas", /\b(sofa|couch|loveseat|settee|sectional|divan)\b/],
  ["Chairs", /\b(chair|armchair|recliner|stool|bench|ottoman|seat)\b/],
  ["Tables", /\b(table|desk|console|nightstand|coffee)\b/],
  ["Beds", /\b(bed|mattress|headboard|bunk|crib)\b/],
  ["Storage", /\b(shelf|shelves|bookshelf|cabinet|wardrobe|dresser|sideboard|drawer|storage|closet|rack|tv unit)\b/],
  ["Lighting", /\b(lamp|light|chandelier|pendant|sconce|lantern)\b/],
  ["Decor", /\b(rug|carpet|plant|mirror|vase|art|cushion|curtain|clock|decor)\b/],
];
const MATERIAL_RULES: [string, RegExp][] = [
  ["Wood", /\b(wood|wooden|oak|teak|walnut|pine|plywood|sheesham)\b/],
  ["Leather", /\b(leather|leatherette)\b/],
  ["Fabric", /\b(fabric|cloth|linen|cotton|velvet|upholster)\b/],
  ["Metal", /\b(metal|steel|iron|aluminium|aluminum|brass)\b/],
  ["Glass", /\b(glass|acrylic)\b/],
  ["Marble", /\b(marble|stone|granite)\b/],
];
const PRICE_BRACKETS: { label: string; test: (n: number) => boolean }[] = [
  { label: "Under ₹10k", test: (n) => n < 10000 },
  { label: "₹10k–50k", test: (n) => n >= 10000 && n < 50000 },
  { label: "₹50k–1L", test: (n) => n >= 50000 && n < 100000 },
  { label: "Over ₹1L", test: (n) => n >= 100000 },
];
function categoryOf(p: ProductDTO): string {
  if (p.mount === "ceiling") return "Lighting";
  const hay = `${p.category ?? ""} ${p.name}`.toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(hay)) return cat;
  return "Other";
}
function materialOf(p: ProductDTO): string | null {
  const hay = `${p.category ?? ""} ${p.name}`.toLowerCase();
  for (const [m, re] of MATERIAL_RULES) if (re.test(hay)) return m;
  return null;
}

function AddFurnitureSheet({
  products, onAdd, onClose, initialFilter,
}: {
  products: ProductDTO[]; onAdd: (id: string) => void; onClose: () => void; initialFilter: "all" | "ceiling";
}) {
  // The Lights dock entry opens the picker scoped to ceiling fixtures.
  const scope = useMemo(
    () => (initialFilter === "ceiling" ? products.filter((p) => p.mount === "ceiling") : products),
    [products, initialFilter],
  );

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [style, setStyle] = useState<string | null>(null);
  const [material, setMaterial] = useState<string | null>(null);
  const [price, setPrice] = useState<string | null>(null); // bracket label

  // Canonical categories present, with counts, in a natural order — scales to any catalog.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of scope) counts.set(categoryOf(p), (counts.get(categoryOf(p)) ?? 0) + 1);
    return CATEGORY_ORDER.filter((c) => counts.has(c)).map((name) => ({ name, count: counts.get(name)! }));
  }, [scope]);

  // Filter options that actually exist in the catalog (so we never show empty filters).
  const styleOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of scope) for (const t of p.styleTags) s.add(t);
    return [...s].sort();
  }, [scope]);
  const materialOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of scope) { const m = materialOf(p); if (m) s.add(m); }
    return [...s].sort();
  }, [scope]);
  const priceOptions = useMemo(
    () => PRICE_BRACKETS.filter((b) => scope.some((p) => b.test(p.priceInr))).map((b) => b.label),
    [scope],
  );

  const q = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      scope.filter((p) => {
        if (category !== "all" && categoryOf(p) !== category) return false;
        if (style && !p.styleTags.includes(style as ProductDTO["styleTags"][number])) return false;
        if (material && materialOf(p) !== material) return false;
        if (price && !PRICE_BRACKETS.find((b) => b.label === price)?.test(p.priceInr)) return false;
        if (q && !`${p.name} ${p.category ?? ""}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    [scope, category, style, material, price, q],
  );

  const hasFilters = !!(style || material || price);
  const clearFilters = () => {
    setStyle(null);
    setMaterial(null);
    setPrice(null);
  };

  // Close Esc + snappy: pick one → close immediately, placement runs on the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const pick = (id: string) => {
    onAdd(id);
    onClose();
  };

  const dims = (p: ProductDTO) =>
    [p.widthCm, p.depthCm, p.heightCm].every((d) => d == null)
      ? null
      : `${p.widthCm ?? "?"}×${p.depthCm ?? "?"}×${p.heightCm ?? "?"} cm`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm grid place-items-end sm:place-items-center sm:p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 40, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 40, opacity: 0, scale: 0.98 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-5xl h-[88vh] sm:h-[82vh] sm:rounded-3xl rounded-t-3xl bg-surface border border-border shadow-[var(--shadow-lg)] flex flex-col overflow-hidden"
      >
        {/* Header: title + search + close */}
        <div className="flex items-center gap-3 px-5 h-16 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight leading-tight">
              {initialFilter === "ceiling" ? "Add a ceiling light" : "Add furniture"}
            </h2>
            <p className="text-muted text-xs">
              {results.length} of {scope.length} model{scope.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="relative ml-auto w-40 sm:w-72 max-w-[45vw]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-subtle pointer-events-none" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full h-10 pl-9 pr-3 rounded-xl bg-surface-muted border border-border text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15 transition"
            />
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid place-items-center h-10 w-10 rounded-xl hover:bg-surface-muted shrink-0"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Mobile category chips */}
        {categories.length > 0 && (
          <div className="sm:hidden flex gap-2 overflow-x-auto px-4 py-3 border-b border-border shrink-0">
            <CatChip active={category === "all"} onClick={() => setCategory("all")} label="All" count={scope.length} />
            {categories.map((c) => (
              <CatChip key={c.name} active={category === c.name} onClick={() => setCategory(c.name)} label={c.name} count={c.count} />
            ))}
          </div>
        )}

        <div className="flex flex-1 min-h-0">
          {/* Category rail (desktop) */}
          <nav className="hidden sm:flex flex-col w-52 shrink-0 border-r border-border p-3 gap-0.5 overflow-y-auto">
            <RailButton active={category === "all"} onClick={() => setCategory("all")} label="All items" count={scope.length} icon />
            {categories.map((c) => (
              <RailButton key={c.name} active={category === c.name} onClick={() => setCategory(c.name)} label={c.name} count={c.count} />
            ))}
            <Link href="/settings" className="mt-auto pt-3">
              <span className="flex items-center gap-2 h-10 px-3 rounded-xl text-sm text-muted hover:bg-surface-muted hover:text-foreground transition-colors">
                <ImagePlus className="h-4 w-4" /> Upload model
              </span>
            </Link>
          </nav>

          {/* Product column: filter bar + scrollable grid */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            {(styleOptions.length + materialOptions.length + priceOptions.length) > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 sm:px-5 py-3 border-b border-border shrink-0">
                {styleOptions.length > 0 && (
                  <FilterGroup label="Style" options={styleOptions} value={style} onChange={setStyle} />
                )}
                {materialOptions.length > 0 && (
                  <FilterGroup label="Material" options={materialOptions} value={material} onChange={setMaterial} />
                )}
                {priceOptions.length > 0 && (
                  <FilterGroup label="Price" options={priceOptions} value={price} onChange={setPrice} />
                )}
                {hasFilters && (
                  <button onClick={clearFilters} className="text-xs font-medium text-primary hover:underline ml-auto shrink-0">
                    Clear filters
                  </button>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5">
            {scope.length === 0 ? (
              <EmptyState
                title="No 3D models yet"
                body="Upload furniture with a .glb model from Settings → Upload 3D Model, then it'll appear here to place."
                cta
              />
            ) : results.length === 0 ? (
              <EmptyState title="No matches" body={`Nothing matches your search or filters. Try clearing a filter.`} />
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
                {results.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => pick(p.id)}
                    className="group text-left rounded-2xl border border-border bg-surface-2 overflow-hidden hover:border-primary/40 hover:shadow-[var(--shadow-md)] hover:-translate-y-0.5 transition-all focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <div className="relative aspect-[4/3] bg-surface-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.thumbnailUrl} alt={p.name} className="h-full w-full object-cover" loading="lazy" />
                      <span className="absolute inset-x-0 bottom-0 grid place-items-center py-2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-white text-gray-900 px-3 h-8 text-xs font-semibold">
                          <Plus className="h-3.5 w-3.5" /> Add to room
                        </span>
                      </span>
                      {p.mount === "ceiling" && (
                        <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/55 text-white px-1.5 py-0.5 text-[10px] font-medium">
                          <Lightbulb className="h-3 w-3" /> Ceiling
                        </span>
                      )}
                    </div>
                    <div className="p-2.5">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <p className="text-[11px] text-subtle truncate">{p.category || "Other"}{dims(p) ? ` · ${dims(p)}` : ""}</p>
                      <p className="text-primary text-sm font-semibold mt-0.5">{formatINR(p.priceInr)}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function FilterGroup({
  label, options, value, onChange,
}: {
  label: string; options: string[]; value: string | null; onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle mr-0.5">{label}</span>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(value === o ? null : o)}
          className={cn(
            "h-7 px-2.5 rounded-full text-xs font-medium border transition-colors",
            value === o
              ? "bg-primary text-white border-primary"
              : "border-border text-muted hover:text-foreground hover:border-primary/40",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function RailButton({
  active, onClick, label, count, icon,
}: {
  active: boolean; onClick: () => void; label: string; count: number; icon?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 h-10 px-3 rounded-xl text-sm transition-colors text-left",
        active ? "bg-primary/10 text-primary font-semibold" : "text-foreground hover:bg-surface-muted",
      )}
    >
      {icon && <LayoutGrid className="h-4 w-4 shrink-0" />}
      <span className="truncate flex-1 capitalize">{label}</span>
      <span className={cn("text-xs tabular-nums", active ? "text-primary" : "text-subtle")}>{count}</span>
    </button>
  );
}

function CatChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-full text-sm whitespace-nowrap transition-colors",
        active ? "bg-primary text-white font-medium" : "bg-surface-muted text-muted hover:text-foreground",
      )}
    >
      <span className="capitalize">{label}</span>
      <span className={cn("text-xs", active ? "text-white/80" : "text-subtle")}>{count}</span>
    </button>
  );
}

function EmptyState({ title, body, cta }: { title: string; body: string; cta?: boolean }) {
  return (
    <div className="h-full grid place-items-center text-center px-6">
      <div className="max-w-sm">
        <Box className="h-10 w-10 text-subtle mx-auto mb-3" />
        <p className="font-medium text-lg">{title}</p>
        <p className="text-muted mt-1 text-sm">{body}</p>
        {cta && (
          <Link href="/settings" className="inline-block mt-5">
            <Button><ImagePlus className="h-4 w-4" /> Upload a model</Button>
          </Link>
        )}
      </div>
    </div>
  );
}

function NoProject() {
  return (
    <div className="h-svh grid place-items-center text-center px-6">
      <div>
        <div className="grid place-items-center h-16 w-16 rounded-2xl bg-surface border border-border mx-auto mb-4">
          <ImagePlus className="h-7 w-7 text-subtle" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">No room loaded</h1>
        <p className="text-muted mt-1.5 max-w-sm mx-auto">
          Create a project with a room photo, then drop furniture from the
          marketplace onto it.
        </p>
        <div className="flex items-center justify-center gap-3 mt-6">
          <Link href="/new"><Button><Plus className="h-4 w-4" /> New Project</Button></Link>
          <Link href="/projects"><Button variant="secondary">My Projects</Button></Link>
        </div>
      </div>
    </div>
  );
}

/** One row in the AI bar's "+" tool menu. */
function ToolItem({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 h-10 px-2.5 rounded-xl text-left text-sm font-medium hover:bg-surface-muted transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="grid place-items-center h-5 w-5 shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle shrink-0">{hint}</span>}
    </button>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out",
        checked ? "bg-black dark:bg-white" : "bg-gray-300 dark:bg-zinc-700"
      )}
    >
      <span
        className={cn(
          "pointer-events-none flex items-center justify-center h-6 w-6 rounded-full bg-white dark:bg-zinc-900 shadow transition-transform duration-200 ease-in-out",
          checked ? "translate-x-[22px]" : "translate-x-[2px]"
        )}
      >
        {checked ? (
          <svg className="h-4 w-4 text-black dark:text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : null}
      </span>
    </button>
  );
}
