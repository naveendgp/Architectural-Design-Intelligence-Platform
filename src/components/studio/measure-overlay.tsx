"use client";

import * as THREE from "three";
import type { PlacedItemDTO } from "@/lib/types";
import type { DepthField } from "@/lib/depth";
import { type Calibration, itemAnchor, itemDistance, itemWorldPos, anchorToPoint, pointToAnchor } from "@/lib/placement";

/* IKEA-style measurement overlay.
   Drawn as plain DOM/SVG on top of the canvas — no projection needed, because a
   piece's anchor (ax, ay) IS its normalized screen position. */

export type MeasureConfig = {
  productDims: boolean;
  productSpacing: boolean;
  roomDims: boolean;
  unit: "cm" | "ft";
};

const fmtDist = (m: number, unit: "cm" | "ft") => {
  if (unit === "ft") {
    const totalInches = Math.round(m * 39.3701);
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    return `${feet}' ${inches}"`;
  }
  return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(1)} m`;
};

const formatDim = (cm: number, unit: "cm" | "ft") => {
  if (unit === "ft") {
    const totalInches = Math.round(cm / 2.54);
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    return `${feet}' ${inches}"`;
  }
  return `${cm} cm`;
};

export function MeasureOverlay({
  items,
  selectedId,
  aspect,
  calib,
  depth,
  config,
}: {
  items: PlacedItemDTO[];
  selectedId: string | null;
  aspect: number;
  calib: Calibration;
  depth: DepthField | null;
  config: MeasureConfig;
}) {
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const others = selected ? items.filter((i) => i.id !== selected.id) : [];

  const wallLines: { id: string; x1: number; y1: number; x2: number; y2: number; dist: number }[] = [];

  if (selected && config.roomDims) {
    const a = itemAnchor(selected);
    const pCenter = itemWorldPos(selected, aspect, calib, depth);

    const w = ((selected.product.widthCm || 100) / 100) * selected.scale * calib.scale;
    const d = ((selected.product.depthCm || 100) / 100) * selected.scale * calib.scale;
    const rot = ((selected.product.frontYaw + (depth?.roomYawDeg ?? 0) + selected.rotationY) * Math.PI) / 180;

    const dx = w / 2;
    const dz = d / 2;
    const cornersLocal = [
      new THREE.Vector3(-dx, 0, -dz),
      new THREE.Vector3(dx, 0, -dz),
      new THREE.Vector3(dx, 0, dz),
      new THREE.Vector3(-dx, 0, dz),
    ];

    const cornersWorld = cornersLocal.map(c => {
      const cw = c.clone();
      cw.applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      cw.add(pCenter);
      return cw;
    });

    const footprint = cornersWorld.map(c => pointToAnchor(c, aspect, calib));

    const minAx = Math.min(...footprint.map(f => f.ax));
    const maxAx = Math.max(...footprint.map(f => f.ax));
    const minAy = Math.min(...footprint.map(f => f.ay));
    const maxAy = Math.max(...footprint.map(f => f.ay));

    const leftEdgeCenterAy = a.ay;
    const pLeftScreen = anchorToPoint(0, leftEdgeCenterAy, aspect, calib, "floor");
    const pLeftEdge = anchorToPoint(minAx, leftEdgeCenterAy, aspect, calib, "floor");
    wallLines.push({ id: "left", x1: minAx, y1: leftEdgeCenterAy, x2: 0, y2: leftEdgeCenterAy, dist: pLeftEdge.distanceTo(pLeftScreen) });

    const pRightScreen = anchorToPoint(1, leftEdgeCenterAy, aspect, calib, "floor");
    const pRightEdge = anchorToPoint(maxAx, leftEdgeCenterAy, aspect, calib, "floor");
    wallLines.push({ id: "right", x1: maxAx, y1: leftEdgeCenterAy, x2: 1, y2: leftEdgeCenterAy, dist: pRightEdge.distanceTo(pRightScreen) });

    const backEdgeCenterAx = a.ax;
    const pBackScreen = anchorToPoint(backEdgeCenterAx, 0.45, aspect, calib, "floor");
    const pBackEdge = anchorToPoint(backEdgeCenterAx, minAy, aspect, calib, "floor");
    wallLines.push({ id: "back", x1: backEdgeCenterAx, y1: minAy, x2: backEdgeCenterAx, y2: 0.45, dist: pBackEdge.distanceTo(pBackScreen) });

    const pFrontScreen = anchorToPoint(backEdgeCenterAx, 1, aspect, calib, "floor");
    const pFrontEdge = anchorToPoint(backEdgeCenterAx, maxAy, aspect, calib, "floor");
    wallLines.push({ id: "front", x1: backEdgeCenterAx, y1: maxAy, x2: backEdgeCenterAx, y2: 1, dist: pFrontEdge.distanceTo(pFrontScreen) });
  }

  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      {selected && (config.productSpacing || config.roomDims) ? (
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          {config.productSpacing && others.length > 0 ? others.map((it) => {
            const a = itemAnchor(selected);
            const b = itemAnchor(it);
            return (
              <line
                key={`l-${it.id}`}
                x1={`${a.ax * 100}%`}
                y1={`${a.ay * 100}%`}
                x2={`${b.ax * 100}%`}
                y2={`${b.ay * 100}%`}
                stroke="#3b82f6"
                strokeWidth={2}
                strokeLinecap="round"
              />
            );
          }) : null}
          {config.roomDims ? wallLines.map((wl) => {
            return (
              <line
                key={`wl-${wl.id}`}
                x1={`${wl.x1 * 100}%`}
                y1={`${wl.y1 * 100}%`}
                x2={`${wl.x2 * 100}%`}
                y2={`${wl.y2 * 100}%`}
                stroke="#0ea5e9"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray="4 4"
              />
            );
          }) : null}
        </svg>
      ) : null}

      {/* Each piece's real size, in standard Length × Width × Height order.
          Product depth is the length dimension in the room. */}
      {config.productDims ? items.map((it) => {
        const { ax, ay } = itemAnchor(it);
        const w = it.product.widthCm;
        const d = it.product.depthCm;
        const h = it.product.heightCm;
        if (!w && !d && !h) return null;
        return (
          <span
            key={`s-${it.id}`}
            style={{ left: `${ax * 100}%`, top: `${ay * 100}%` }}
            className="absolute -translate-x-1/2 translate-y-2 rounded-md bg-gray-900/90 px-1.5 py-0.5 text-[11px] font-semibold text-white shadow-md whitespace-nowrap"
          >
            {d ? formatDim(d, config.unit) : "?"} × {w ? formatDim(w, config.unit) : "?"} × {h ? formatDim(h, config.unit) : "?"}
          </span>
        );
      }) : null}

      {/* spacing labels at each line's midpoint */}
      {config.productSpacing && selected ?
        others.map((it) => {
          const a = itemAnchor(selected);
          const b = itemAnchor(it);
          const mx = (a.ax + b.ax) / 2;
          const my = (a.ay + b.ay) / 2;
          const dist = itemDistance(selected, it, aspect, calib, depth);
          return (
            <span
              key={`d-${it.id}`}
              style={{ left: `${mx * 100}%`, top: `${my * 100}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md bg-blue-600 px-1.5 py-0.5 text-[11px] font-semibold text-white shadow-md whitespace-nowrap"
            >
              {fmtDist(dist, config.unit)}
            </span>
          );
        }) : null}

      {/* wall distance labels */}
      {config.roomDims && selected ?
        wallLines.map((wl) => {
          const mx = (wl.x1 + wl.x2) / 2;
          const my = (wl.y1 + wl.y2) / 2;
          return (
            <span
              key={`wd-${wl.id}`}
              style={{ left: `${mx * 100}%`, top: `${my * 100}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md bg-sky-500 px-1.5 py-0.5 text-[11px] font-semibold text-white shadow-md whitespace-nowrap"
            >
              {fmtDist(wl.dist, config.unit)}
            </span>
          );
        }) : null}
    </div>
  );
}
