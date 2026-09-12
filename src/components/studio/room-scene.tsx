"use client";

import { Suspense, Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { useGLTF, Clone, Environment, Shadow } from "@react-three/drei";
import * as THREE from "three";
import type { PlacedItemDTO } from "@/lib/types";
import type { DepthField } from "@/lib/depth";
import {
  type Calibration,
  clamp01,
  clampDragAnchor,
  itemOBB,
  obbOverlap,
  itemAnchor,
  itemWorldPos,
  FALLBACK_ANCHOR,
} from "@/lib/placement";

/* Screen-anchored placement — the maths lives in @/lib/placement so the 2D
   measurement overlay can share it. Each piece's base is pinned to its anchor on
   the photo, so furniture is always seated where you drop it. */

function FovRig({ fov }: { fov: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  useEffect(() => {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }, [fov, camera]);
  return null;
}

type Registry = React.MutableRefObject<Map<string, THREE.Object3D>>;

function Furniture({
  item,
  selected,
  colliding,
  aspect,
  calib,
  depth,
  registry,
}: {
  item: PlacedItemDTO;
  selected: boolean;
  colliding: boolean;
  aspect: number;
  calib: Calibration;
  depth: DepthField | null;
  registry: Registry;
}) {
  const { scene } = useGLTF(item.product.modelUrl!);
  const ceilingMounted = item.product.mount === "ceiling";

  const { offset, fit, baseSpan, autoLevelX, autoLevelZ, modelSize } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const targetW = (item.product.widthCm ?? 100) / 100;
    const fit = size.x > 0.0001 ? targetW / size.x : 1;
    const ceiling = item.product.mount === "ceiling";
    // offset in MODEL units; it lives inside the scaled group so it scales with the
    // model. Ceiling pieces attach at their TOP (hang down); everything else sits
    // on its base.
    const offset: [number, number, number] = [
      -center.x,
      ceiling ? -box.max.y : -box.min.y,
      -center.z,
    ];
    const baseSpan = Math.max(size.x, size.z) * fit; // footprint width in metres
    // Model size in local units (before scale) for collision visualization.
    const modelSize: [number, number, number] = [size.x, size.y, size.z];

    let autoLevelX = 0;
    let autoLevelZ = 0;

    return { offset, fit, baseSpan, autoLevelX, autoLevelZ, modelSize };
  }, [scene, item.product.widthCm, item.product.mount]);

  const S = fit * item.scale * calib.scale;
  const { ax, ay } = itemAnchor(item);
  // Real floor depth at the drop point (falls back to vertical position).
  const pos = itemWorldPos(item, aspect, calib, depth);
  const fp = (baseSpan * item.scale * calib.scale) / 2;
  /* True half-extents of the footprint. `fp` above is a RADIUS taken from the
     longest dimension, so drawing a circle with it put a 1.1m halo around a sofa
     only 0.39m deep — it swept over neighbouring pieces and read as a collision
     even when the maths said they were clear. Ring and shadow use the real
     width x depth instead, and sit inside the yaw group so they turn with it. */
  const halfW = Math.max(0.12, ((item.product.widthCm ?? 100) / 100) * item.scale * calib.scale / 2);
  const halfD = Math.max(0.12, ((item.product.depthCm ?? 100) / 100) * item.scale * calib.scale / 2);

  // Yaw = product's captured front + Gemini's exact absolute facing angle + user nudge.
  const yaw =
    ((item.product.frontYaw + item.rotationY) *
      Math.PI) /
    180;

  return (
    <group
      ref={(o) => {
        if (o) registry.current.set(item.id, o);
        else registry.current.delete(item.id);
      }}
      position={pos}
      userData={{ anchor: { ax, ay }, mount: item.product.mount }}
    >
      {/* Outer group: yaw only — no X/Z so it never causes gimbal lean. */}
      <group rotation={[0, yaw, 0]}>
        {/* Inner group: tilt corrections (auto-level + manual) applied in
            the model's local frame so the sliders work independently. */}
        <group
          rotation={[
            ceilingMounted ? 0 : autoLevelX + (item.tiltX * Math.PI) / 180,
            0,
            ceilingMounted ? 0 : autoLevelZ + (item.tiltZ * Math.PI) / 180,
          ]}
        >
          {(selected || colliding) && (
            // Unit ring scaled to the footprint — an ellipse that hugs the piece.
            <group scale={[halfW * 1.16, 1, halfD * 1.16]}>
              <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]}>
                <ringGeometry args={[0.88, 1, 64]} />
                <meshBasicMaterial
                  color={colliding ? "#ef4444" : "#6366f1"}
                  transparent
                  opacity={colliding ? 0.95 : 0.9}
                />
              </mesh>
            </group>
          )}
          {/* Collision overlay — red translucent box */}
          {colliding && (
            <group scale={S}>
              <mesh position={[0, (modelSize[1] / 2), 0]}>
                <boxGeometry args={[modelSize[0] * 1.02, modelSize[1] * 1.02, modelSize[2] * 1.02]} />
                <meshBasicMaterial color="#ef4444" transparent opacity={0.1} depthWrite={false} />
              </mesh>
            </group>
          )}
          <Shadow
            position={[0, 0.008, 0]}
            // Matches the footprint too; a square shadow sized on the longest
            // dimension made every piece look far bigger than it is.
            scale={[halfW * 2.3, halfD * 2.3, 1]}
            color={colliding ? "#ef4444" : "#000000"}
            opacity={colliding ? 0.6 : 0.45}
          />
          {/* scaled group: the centering offset is INSIDE it, so it scales with
              the model and the base lands exactly on the anchor (y=0). */}
          <group scale={S}>
            <group position={offset}>
              <Clone object={scene} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

/* Pointer interaction via plain DOM events + manual raycasting (robust). */
function PointerLayer({
  registry,
  getCollidingIds,
  onSelect,
  onMove,
  onDrop,
}: {
  registry: Registry;
  getCollidingIds: () => Set<string>;
  onSelect: (id: string | null) => void;
  onMove: (id: string, ax: number, ay: number) => void;
  onDrop: (id: string) => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const dragId = useRef<string | null>(null);
  const grabOffset = useRef({ x: 0, y: 0 });
  const dragStartAnchor = useRef({ ax: 0, ay: 0 });

  useEffect(() => {
    const el = gl.domElement;
    const rect = () => el.getBoundingClientRect();
    const frac = (ev: PointerEvent) => {
      const r = rect();
      return {
        ax: clamp01((ev.clientX - r.left) / r.width),
        ay: clamp01((ev.clientY - r.top) / r.height),
      };
    };

    const pick = (ev: PointerEvent): string | null => {
      const r = rect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - r.left) / r.width) * 2 - 1,
        -(((ev.clientY - r.top) / r.height) * 2 - 1),
      );
      raycaster.setFromCamera(ndc, camera);
      let bestId: string | null = null;
      let bestDist = Infinity;
      for (const [id, obj] of registry.current) {
        const hits = raycaster.intersectObject(obj, true);
        if (hits.length && hits[0].distance < bestDist) {
          bestDist = hits[0].distance;
          bestId = id;
        }
      }
      return bestId;
    };

    const onDown = (ev: PointerEvent) => {
      const id = pick(ev);
      onSelect(id);
      if (id) {
        dragId.current = id;
        const obj = registry.current.get(id);
        const a = (obj?.userData?.anchor as { ax: number; ay: number }) ?? FALLBACK_ANCHOR;
        dragStartAnchor.current = { ax: a.ax, ay: a.ay };
        const p = frac(ev);
        grabOffset.current = { x: p.ax - a.ax, y: p.ay - a.ay };
        document.body.style.cursor = "grabbing";
      }
    };
    const onMoveDom = (ev: PointerEvent) => {
      if (dragId.current) {
        const p = frac(ev);
        const obj = registry.current.get(dragId.current);
        const ax = clamp01(p.ax - grabOffset.current.x);
        const ay = clamp01(p.ay - grabOffset.current.y);
        // Keep the piece on a surface it can sit on — a floor piece dragged toward
        // the top of the photo must stop at the floor line, not climb the wall.
        const mount = obj?.userData?.mount === "ceiling" ? "ceiling" : "floor";
        const anchor = clampDragAnchor(ax, ay, mount);
        onMove(dragId.current, anchor.ax, anchor.ay);
      } else {
        document.body.style.cursor = pick(ev) ? "grab" : "auto";
      }
    };
    const onUp = () => {
      if (dragId.current) {
        // Drop wherever the user lets go — no snap-back. A collision only shows a
        // red ring as a warning; the user stays in control of position.
        onDrop(dragId.current);
        dragId.current = null;
        document.body.style.cursor = "auto";
      }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMoveDom);
    window.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMoveDom);
      window.removeEventListener("pointerup", onUp);
    };
  }, [camera, gl, raycaster, registry, getCollidingIds, onSelect, onMove, onDrop]);

  return null;
}

/* ── Collision detection ─────────────────────────────────────────────── */

/* Collision is decided with the SAME oriented-box maths the placement engine
   uses, so the red ring can never contradict where the packer chose to put a
   piece. The old version bounded each object's whole Three.js group with an
   axis-aligned Box3 — which swallowed the decorative drei <Shadow>, a SQUARE
   plane scaled 2.2x the largest dimension. For a 220x78cm sofa that produced a
   2.4m square box, about 3x its real depth, and flagged pieces that were plainly
   far apart. */
function CollisionChecker({
  items,
  aspect,
  calib,
  depth,
  onUpdate,
}: {
  items: PlacedItemDTO[];
  aspect: number;
  calib: Calibration;
  depth: DepthField | null;
  onUpdate: (ids: Set<string>) => void;
}) {
  const prevKey = useRef("");

  useEffect(() => {
    const floor = items.filter((it) => it.product.mount !== "ceiling");
    const boxes = floor.map((it) => [it.id, itemOBB(it, aspect, calib, depth)] as const);

    const colliding = new Set<string>();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (obbOverlap(boxes[i][1], boxes[j][1])) {
          colliding.add(boxes[i][0]);
          colliding.add(boxes[j][0]);
        }
      }
    }

    const key = [...colliding].sort().join(",");
    if (key !== prevKey.current) {
      prevKey.current = key;
      onUpdate(colliding);
    }
  }, [items, aspect, calib, depth, onUpdate]);

  return null;
}

/* ── Scene content ───────────────────────────────────────────────────── */

/* Catches a model that fails to load (e.g. a huge/corrupt GLB) so one bad piece
   can't crash the whole studio. */
class ModelErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/* Selectable/draggable stand-in shown while a model loads ("loading") or if it
   fails ("error"). Registers in the same registry so it behaves like a piece. */
function PlaceholderItem({
  item,
  selected,
  aspect,
  calib,
  depth,
  registry,
  kind,
}: {
  item: PlacedItemDTO;
  selected: boolean;
  aspect: number;
  calib: Calibration;
  depth: DepthField | null;
  registry: Registry;
  kind: "loading" | "error";
}) {
  const { ax, ay } = itemAnchor(item);
  const pos = itemWorldPos(item, aspect, calib, depth);
  const wm = ((item.product.widthCm || 80) / 100) * item.scale * calib.scale;
  const hm = ((item.product.heightCm || 80) / 100) * item.scale * calib.scale;
  const dm = ((item.product.depthCm || 80) / 100) * item.scale * calib.scale;
  const fp = Math.max(wm, dm) / 2;
  const yaw =
    ((item.product.frontYaw + (depth?.roomYawDeg ?? 0) + item.rotationY) *
      Math.PI) /
    180;
  const isErr = kind === "error";
  const ceilingMounted = item.product.mount === "ceiling";

  return (
    <group
      ref={(o) => {
        if (o) registry.current.set(item.id, o);
        else registry.current.delete(item.id);
      }}
      position={pos}
      userData={{ anchor: { ax, ay }, mount: item.product.mount }}
    >
      <group rotation={[0, yaw, 0]}>
        {selected && !ceilingMounted && (
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]}>
            <ringGeometry args={[Math.max(0.2, fp * 0.95), Math.max(0.3, fp * 1.18), 48]} />
            <meshBasicMaterial color="#6366f1" transparent opacity={0.9} />
          </mesh>
        )}
        {!ceilingMounted && (
          <Shadow position={[0, 0.008, 0]} scale={Math.max(0.4, fp * 2.2)} color="#000000" opacity={0.4} />
        )}
        {/* A pending ceiling model grows DOWN from the attachment point. This
            keeps its temporary loading shape flush with the ceiling just like
            the final GLB, rather than floating as a floor placeholder. */}
        <mesh position={[0, ceilingMounted ? -hm / 2 : hm / 2, 0]}>
          <boxGeometry args={[Math.max(0.1, wm), Math.max(0.1, hm), Math.max(0.1, dm)]} />
          <meshStandardMaterial
            color={isErr ? "#ef4444" : "#cbd5e1"}
            transparent
            opacity={isErr ? 0.5 : 0.35}
          />
        </mesh>
      </group>
    </group>
  );
}

function SceneContent({
  items,
  calib,
  depth,
  selectedId,
  onSelect,
  onMove,
  onDrop,
}: {
  items: PlacedItemDTO[];
  calib: Calibration;
  depth: DepthField | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, ax: number, ay: number) => void;
  onDrop: (id: string) => void;
}) {
  const size = useThree((s) => s.size);
  const aspect = size.width / size.height;
  const registry = useRef<Map<string, THREE.Object3D>>(new Map());
  const [collidingIds, setCollidingIds] = useState<Set<string>>(new Set());
  const collidingIdsRef = useRef<Set<string>>(new Set());

  const handleCollisionUpdate = useCallback((ids: Set<string>) => {
    collidingIdsRef.current = ids;
    setCollidingIds(ids);
  }, []);

  return (
    <>
      <FovRig fov={calib.fov} />
      <PointerLayer
        registry={registry}
        getCollidingIds={() => collidingIdsRef.current}
        onSelect={onSelect}
        onMove={onMove}
        onDrop={onDrop}
      />
      <CollisionChecker
        items={items}
        aspect={aspect}
        calib={calib}
        depth={depth}
        onUpdate={handleCollisionUpdate}
      />
      <ambientLight intensity={0.8} />
      <directionalLight position={[3, 8, 4]} intensity={1.2} />

      {items.map((it) => {
        const placeholder = (kind: "loading" | "error") => (
          <PlaceholderItem
            item={it}
            selected={it.id === selectedId}
            aspect={aspect}
            calib={calib}
            depth={depth}
            registry={registry}
            kind={kind}
          />
        );
        return (
          <ModelErrorBoundary key={it.id} fallback={placeholder("error")}>
            <Suspense fallback={placeholder("loading")}>
              <Furniture
                item={it}
                selected={it.id === selectedId}
                colliding={collidingIds.has(it.id)}
                aspect={aspect}
                calib={calib}
                depth={depth}
                registry={registry}
              />
            </Suspense>
          </ModelErrorBoundary>
        );
      })}

      {/* Env HDR loads from a CDN — isolate it so a slow/blocked fetch can't
          blank the whole scene. */}
      <Suspense fallback={null}>
        <Environment preset="apartment" />
      </Suspense>
    </>
  );
}

export function RoomScene(props: {
  items: PlacedItemDTO[];
  calib: Calibration;
  depth: DepthField | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, ax: number, ay: number) => void;
  onDrop: (id: string) => void;
}) {
  return (
    <Canvas
      gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true }}
      style={{ background: "transparent" }}
      camera={{ position: [0, 0, 0], fov: props.calib.fov, near: 0.01, far: 100 }}
    >
      <Suspense fallback={null}>
        <SceneContent {...props} />
      </Suspense>
    </Canvas>
  );
}
