"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X, Download, Sparkles, CreditCard, RefreshCw, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { captureComposite } from "@/lib/capture";

type Phase = "capturing" | "rendering" | "done" | "error";

export function RenderDialog({
  open,
  onClose,
  stageRef,
  photoUrl,
  projectId,
  ceilingLights,
  pieces,
}: {
  open: boolean;
  onClose: () => void;
  stageRef: React.RefObject<HTMLDivElement | null>;
  photoUrl: string;
  projectId?: string;
  ceilingLights?: number;
  /** Names of the placed pieces, so the render can't quietly drop one. */
  pieces?: string[];
}) {
  const [phase, setPhase] = useState<Phase>("capturing");
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; billing: boolean } | null>(null);
  const runId = useRef(0);
  // The gallery record for THIS session — re-render replaces it instead of adding a
  // duplicate. Reset when the dialog closes.
  const renderIdRef = useRef<string | undefined>(undefined);

  const run = useCallback(async () => {
    const id = ++runId.current;
    setPhase("capturing");
    setError(null);
    setAfter(null);
    try {
      const el = stageRef.current;
      if (!el) throw new Error("Scene not ready");
      const shot = await captureComposite(el, photoUrl);
      if (id !== runId.current) return;
      setBefore(shot);
      setPhase("rendering");
      const res = await api.render(shot, {
        projectId,
        ceilingLights,
        pieces,
        renderId: renderIdRef.current,
      });
      if (id !== runId.current) return;
      renderIdRef.current = res.id ?? renderIdRef.current;
      setAfter(res.url);
      setPhase("done");
    } catch (e) {
      if (id !== runId.current) return;
      const err = e as Error & { code?: string };
      setError({ message: err.message, billing: err.code === "billing" });
      setPhase("error");
    }
  }, [photoUrl, stageRef, projectId, ceilingLights, pieces]);

  useEffect(() => {
    if (open) run();
    // Reset when closed so the next open starts a fresh gallery record.
    if (!open) {
      runId.current++;
      renderIdRef.current = undefined;
      setBefore(null);
      setAfter(null);
      setError(null);
    }
  }, [open, run]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="w-full max-w-5xl rounded-3xl bg-surface border border-border shadow-2xl overflow-hidden"
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 h-14 border-b border-border">
              <div className="flex items-center gap-2 font-semibold">
                <Sparkles className="h-4 w-4 text-primary" /> Photorealistic Render
              </div>
              <button
                onClick={onClose}
                className="grid place-items-center h-8 w-8 rounded-lg hover:bg-surface-muted transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5">
              {phase === "error" && error ? (
                <div className="grid place-items-center text-center py-14 gap-3">
                  <div className="grid place-items-center h-14 w-14 rounded-2xl bg-surface-muted">
                    <CreditCard className="h-6 w-6 text-subtle" />
                  </div>
                  <h3 className="text-lg font-semibold">
                    {error.billing ? "Billing required for rendering" : "Render failed"}
                  </h3>
                  <p className="text-muted max-w-md text-sm">
                    {error.billing
                      ? "The Gemini API key authenticates, but image generation is not on the free tier (quota is 0). Enable billing on the key's Google Cloud project to render. Ceiling-light AI placement keeps working for free."
                      : error.message}
                  </p>
                  <div className="flex gap-2 mt-2">
                    {error.billing && (
                      <a
                        href="https://ai.google.dev/gemini-api/docs/billing"
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Button variant="outline" size="sm">Billing docs</Button>
                      </a>
                    )}
                    <Button size="sm" onClick={run}>
                      <RefreshCw className="h-4 w-4" /> Retry
                    </Button>
                  </div>
                </div>
              ) : phase === "done" && after ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <figure className="space-y-1.5">
                      <figcaption className="text-xs font-medium text-muted px-1">Before</figcaption>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={before ?? ""} alt="Before" className="w-full rounded-xl border border-border" />
                    </figure>
                    <figure className="space-y-1.5">
                      <figcaption className="text-xs font-medium text-primary px-1">After — AI render</figcaption>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={after} alt="After" className="w-full rounded-xl border border-border" />
                    </figure>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-4">
                    <p className="text-xs text-muted flex items-center gap-1.5">
                      {projectId ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                          Saved to your Render Gallery. Your 3D layout is untouched.
                        </>
                      ) : (
                        "Your 3D layout is untouched — this is a snapshot."
                      )}
                    </p>
                    <div className="flex gap-2 shrink-0">
                      <Button variant="outline" size="sm" onClick={run}>
                        <RefreshCw className="h-4 w-4" /> Re-render
                      </Button>
                      <a href={after} download="studio-render.png">
                        <Button size="sm">
                          <Download className="h-4 w-4" /> Download
                        </Button>
                      </a>
                    </div>
                  </div>
                </>
              ) : (
                <div className="grid place-items-center text-center py-16 gap-3">
                  <Loader2 className="h-7 w-7 text-primary animate-spin" />
                  <p className="text-muted text-sm">
                    {phase === "capturing" ? "Capturing your scene…" : "Rendering a photorealistic image…"}
                  </p>
                  {phase === "rendering" && (
                    <p className="text-xs text-subtle">This can take 10–20 seconds.</p>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
