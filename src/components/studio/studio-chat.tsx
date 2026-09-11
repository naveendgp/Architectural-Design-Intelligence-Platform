"use client";

import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, X, ArrowUp, Plus, Wand2, RotateCcw } from "lucide-react";
import { cn, formatINR } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ProductDTO } from "@/lib/types";

/* In-studio AI design chat.
   - Design requests ("make this lobby a modern waiting area under ₹5 lakh") go to
     the Gemini planner, which reads the room photo + the real catalog and proposes
     a set of pieces. The proposal renders as a card the user can Apply.
   - A plain "add <product>" skips the AI and places that piece immediately.
   - Room-edit requests (wallpaper, curtains, paint, flooring) are sent to Gemini
     image editing; the edited photo becomes the project's new base image. */

export type PlanLine = { product: ProductDTO; qty: number; reason: string; subtotalInr: number };
export type Plan = {
  intent: string;
  budgetInr: number;
  totalInr: number;
  trimmed: boolean;
  /** Pieces the packing engine couldn't seat, so they never reach the card. */
  droppedForSpace?: string[];
  items: PlanLine[];
  applied?: boolean;
};

type Msg = {
  id: number;
  role: "user" | "ai";
  text: string;
  product?: ProductDTO;
  image?: string;
  plan?: Plan;
};

/** Detect a request to modify the room itself (surfaces), not add furniture. */
function isRoomEdit(t: string): boolean {
  if (/\b(wallpaper|curtains?|blinds?|drapes?|repaint|flooring)\b/.test(t)) return true;
  const feature = /\b(wall|walls|floor|ceiling|tiles?)\b/.test(t);
  const verb = /\b(paint|colou?r|change|make|remove|replace|new|swap)\b/.test(t);
  return feature && verb;
}

/* Fast path for an unambiguous single add ("add Arc Floor Lamp") so the suggestion
   chips stay instant and don't spend a Gemini call. Anything with a goal, a budget,
   a quantity or more than one item falls through to the planner — the old matcher
   used to collapse "sofa, table, lights and lamps under 5 lakhs" into one product
   and read the 5 as a quantity. */
function directAdd(t: string, products: ProductDTO[]): ProductDTO | null {
  if (!/^\s*(add|place|put|insert)\b/.test(t)) return null;
  // Budget / goal / multi-item language means the planner should handle it.
  if (/\b(and|also|plus|budget|under|below|within|lakhs?|crores?|₹|rs\.?|convert|turn|design|style|make)\b/.test(t)) {
    return null;
  }
  if (/\b([2-9]|\d{2,})\b|\b(two|three|four|five|six|couple|few|pair|some|several)\b/.test(t)) return null;
  const hits = products.filter((p) => t.includes(p.name.toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

export function StudioChat({
  products,
  onAdd,
  projectId,
  photoUrl,
  onRoomEdited,
  onRevert,
  edited,
  capture,
  placed,
  capacity,
  onFitPlan,
  onApplyPlan,
}: {
  products: ProductDTO[];
  onAdd: (productId: string) => void;
  projectId?: string;
  photoUrl?: string;
  onRoomEdited?: (newPhotoUrl: string) => void;
  onRevert?: () => Promise<void> | void;
  edited?: boolean;
  /** Screenshot of the room as it looks now — the planner's view of the space. */
  capture?: () => Promise<string>;
  /** What's already in the room, so the planner doesn't duplicate it. */
  placed?: { name: string; qty: number }[];
  /** Measured floor area, so the planner sizes the set to the actual space. */
  capacity?: { floorAreaM2: number; freeFloorM2: number };
  /** Dry-run a plan through the packing engine; returns what genuinely seats. */
  onFitPlan?: (entries: { productId: string; qty: number }[]) => { productId: string; qty: number }[];
  /** Place a whole plan at once, spaced apart. Returns what actually fit. */
  onApplyPlan?: (
    entries: { productId: string; qty: number }[],
  ) => Promise<{ added: number; skipped: string[] }>;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | undefined>();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typing, open]);

  const reply = (msg: Omit<Msg, "id" | "role">) => {
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      setMessages((m) => [...m, { id: Date.now() + 1, role: "ai", ...msg }]);
    }, 750);
  };

  const send = async (text: string) => {
    const raw = text.trim();
    if (!raw || busy) return;
    const t = raw.toLowerCase();
    setMessages((m) => [...m, { id: Date.now(), role: "user", text: raw }]);
    setInput("");

    // Revert the room to its original photo.
    if (onRevert && /\b(revert|undo|reset|original)\b/.test(t) && /\b(room|wall|change|photo|edit|it)\b/.test(t)) {
      setBusy(true);
      setTyping(true);
      try {
        await onRevert();
        setTyping(false);
        setMessages((m) => [...m, { id: Date.now() + 1, role: "ai", text: "Reverted the room to its original photo." }]);
      } finally {
        setBusy(false);
        setTyping(false);
      }
      return;
    }

    // Room edit (wallpaper, curtains, paint, flooring…) — Gemini image editing.
    if (isRoomEdit(t)) {
      if (!projectId || !photoUrl || !onRoomEdited) {
        reply({ text: "I can edit the room once it's fully loaded — give it a moment and try again." });
        return;
      }
      setBusy(true);
      setBusyLabel("Editing the room… (~15–25s)");
      setTyping(true);
      try {
        const newUrl = await api.editRoom(projectId, photoUrl, raw);
        onRoomEdited(newUrl);
        setTyping(false);
        setMessages((m) => [
          ...m,
          {
            id: Date.now() + 1,
            role: "ai",
            text: `Done — I've updated the room (“${raw}”). This is now your base image, so any furniture you add or render sits on the new look. Ask for another change, or start adding furniture.`,
            image: newUrl,
          },
        ]);
      } catch (e) {
        setTyping(false);
        const err = e as { code?: string };
        setMessages((m) => [
          ...m,
          {
            id: Date.now() + 1,
            role: "ai",
            text:
              err.code === "billing"
                ? "Room editing needs billing enabled on the Gemini API key."
                : "I couldn't edit the room just now — the AI image service may be busy. Please try that again.",
          },
        ]);
      } finally {
        setBusy(false);
        setBusyLabel(undefined);
      }
      return;
    }

    // Ambient lighting change (not adding a lamp) — not built yet.
    if (/\b(warmer|dimmer|brighter|cozier|cozy|mood|ambient)\b/.test(t) && /\blight/.test(t)) {
      reply({
        text: "Ambient lighting adjustments are coming soon. I can place a lamp if you have one — try “add a lamp”.",
      });
      return;
    }

    if (products.length === 0) {
      reply({
        text: "Your marketplace is empty. Upload a 3D model in Settings → Upload 3D Model, then I can place it for you.",
      });
      return;
    }

    // Unambiguous single add — place it straight away, no AI round-trip.
    const direct = directAdd(t, products);
    if (direct) {
      onAdd(direct.id);
      reply({
        text: `Done — I've placed a ${direct.name} in your room and selected it. Drag to reposition, or tell me what you're going for and I'll design the whole space.`,
        product: direct,
      });
      return;
    }

    // Everything else is a design request: let Gemini read the room and the
    // catalog and propose a set of pieces.
    if (!capture || !onApplyPlan) {
      reply({ text: "I can design this room once it's fully loaded — give it a moment and try again." });
      return;
    }

    setBusy(true);
    setBusyLabel("Designing your room… (~5–10s)");
    setTyping(true);
    try {
      // Hard ceiling on the whole round-trip so a stalled capture or a slow model
      // can never leave the panel spinning.
      const plan = await Promise.race([
        (async () => {
          const shot = await capture();
          return api.design({ image: shot, request: raw, placed: placed ?? [], capacity });
        })(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 45000)),
      ]);
      setTyping(false);

      if (plan.offTopic || plan.items.length === 0) {
        setMessages((m) => [
          ...m,
          {
            id: Date.now() + 1,
            role: "ai",
            text:
              plan.reply ||
              `Tell me what you'd like this space to become — e.g. “turn this into a modern office waiting area” — and I'll pick the pieces from your marketplace.`,
          },
        ]);
        return;
      }

      // Pack the proposal for real before showing it, so the card never promises
      // pieces the room can't take.
      let items = plan.items;
      let droppedForSpace: string[] = [];
      if (onFitPlan) {
        const fitted = onFitPlan(items.map((l) => ({ productId: l.product.id, qty: l.qty })));
        const qtyById = new Map(fitted.map((f) => [f.productId, f.qty]));
        const next: PlanLine[] = [];
        for (const line of items) {
          const qty = qtyById.get(line.product.id) ?? 0;
          if (qty <= 0) {
            droppedForSpace.push(line.product.name);
            continue;
          }
          if (qty < line.qty) droppedForSpace.push(`${line.qty - qty} × ${line.product.name}`);
          next.push({ ...line, qty, subtotalInr: line.product.priceInr * qty });
        }
        items = next;
      }

      if (items.length === 0) {
        setMessages((m) => [
          ...m,
          {
            id: Date.now() + 1,
            role: "ai",
            text: "This room doesn't have clear floor space left for anything more. Remove a piece or two and ask me again, and I'll design around what's left.",
          },
        ]);
        return;
      }

      const totalInr = items.reduce((n, l) => n + l.subtotalInr, 0);
      setMessages((m) => [
        ...m,
        {
          id: Date.now() + 1,
          role: "ai",
          text: plan.reply,
          plan: {
            intent: plan.intent,
            budgetInr: plan.budgetInr,
            totalInr,
            trimmed: plan.trimmed,
            droppedForSpace,
            items,
          },
        },
      ]);
    } catch (e) {
      setTyping(false);
      const err = e as { code?: string };
      setMessages((m) => [
        ...m,
        {
          id: Date.now() + 1,
          role: "ai",
          text:
            err.code === "quota"
              ? "I've hit the Gemini rate limit. Wait a moment and ask again."
              : err.code === "empty"
                ? "Your marketplace is empty. Upload a 3D model in Settings → Upload 3D Model and I'll design with it."
                : "I couldn't put a design together just now — the AI service may be busy. Please try again.",
        },
      ]);
    } finally {
      setBusy(false);
      setBusyLabel(undefined);
    }
  };

  /** Place every piece in a proposal, then report what actually fit. */
  const applyPlan = async (msgId: number, plan: Plan) => {
    if (!onApplyPlan || busy) return;
    setBusy(true);
    setBusyLabel("Placing your furniture…");
    try {
      const entries = plan.items.map((l) => ({ productId: l.product.id, qty: l.qty }));
      const { added, skipped } = await onApplyPlan(entries);
      setMessages((m) =>
        m.map((msg) => (msg.id === msgId ? { ...msg, plan: { ...plan, applied: true } } : msg)),
      );
      const total = plan.items.reduce((n, l) => n + l.qty, 0);
      setMessages((m) => [
        ...m,
        {
          id: Date.now() + 1,
          role: "ai",
          text: skipped.length
            ? `Placed ${added} of ${total} pieces, spaced around the room. There wasn't clear floor left for: ${skipped.join(", ")}. Drag things around, or ask me to swap something smaller in.`
            : `Placed all ${added} pieces, spaced around the room. Drag anything to fine-tune, or hit Render Scene to see it photoreal.`,
        },
      ]);
    } finally {
      setBusy(false);
      setBusyLabel(undefined);
    }
  };

  const designActions =
    capture && onApplyPlan
      ? [
          "Turn this into a modern office waiting area",
          "Furnish this as a cosy living room under ₹2 lakh",
          "Add enough seating and lighting for this space",
        ]
      : [];
  const restyleActions = onRoomEdited
    ? ["Change the wallpaper to warm beige", "Remove the curtains", "Change the flooring to wood"]
    : [];
  const furnitureActions = products.slice(0, 3);
  const empty = messages.length === 0;

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={() => setOpen(true)}
            className="absolute bottom-6 right-6 z-30 flex items-center gap-2.5 h-12 pl-2 pr-4 rounded-full bg-surface/90 backdrop-blur-xl border border-border shadow-[var(--shadow-lg)] hover:border-primary/40 transition-all"
          >
            <span className="grid place-items-center h-8 w-8 rounded-full brand-gradient text-white shrink-0">
              <Sparkles className="h-[18px] w-[18px]" />
            </span>
            <span className="font-medium text-sm hidden sm:block">Design with AI</span>
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-6 right-6 z-30 flex flex-col w-[min(400px,calc(100%-2rem))] h-[min(600px,calc(100%-6.5rem))] rounded-[26px] bg-surface/95 backdrop-blur-2xl border border-border shadow-2xl overflow-hidden"
          >
            <div className="flex items-center gap-3 px-5 h-14 border-b border-border/70 shrink-0">
              <span className="grid place-items-center h-8 w-8 rounded-full brand-gradient text-white shrink-0">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold tracking-tight leading-tight text-[15px]">AI Designer</p>
                <p className="text-[11px] text-subtle leading-tight tracking-wide">Restyle · Furniture · Render</p>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="grid place-items-center h-8 w-8 rounded-full text-muted hover:bg-surface-muted transition-colors"
              >
                <X className="h-[18px] w-[18px]" />
              </button>
            </div>

            {/* Edited-room banner with one-tap revert */}
            {edited && onRevert && (
              <div className="flex items-center gap-2 px-4 py-2 bg-primary/5 border-b border-border shrink-0">
                <Wand2 className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="text-xs text-muted flex-1 min-w-0 truncate">Room has AI edits applied</span>
                <button
                  onClick={async () => {
                    if (busy) return;
                    setBusy(true);
                    setTyping(true);
                    try {
                      await onRevert();
                      setMessages((m) => [...m, { id: Date.now(), role: "ai", text: "Reverted the room to its original photo." }]);
                    } finally {
                      setBusy(false);
                      setTyping(false);
                    }
                  }}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50 shrink-0"
                >
                  <RotateCcw className="h-3 w-3" /> Revert
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {empty ? (
                <div className="h-full flex flex-col">
                  <div className="grid place-items-center h-11 w-11 rounded-2xl brand-gradient text-white mx-auto mb-3 mt-2">
                    <Sparkles className="h-[22px] w-[22px]" />
                  </div>
                  <p className="text-center font-semibold">How should we design this room?</p>
                  <p className="text-center text-[13px] text-muted mt-1 mb-4">
                    Describe the space you want — I'll pick the furniture.
                  </p>

                  {designActions.length > 0 && (
                    <div className="mb-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle mb-2 flex items-center gap-1.5">
                        <Sparkles className="h-3 w-3" /> Design the space
                      </p>
                      <div className="space-y-1.5">
                        {designActions.map((label) => (
                          <button
                            key={label}
                            onClick={() => send(label)}
                            className="w-full text-left px-3 py-2 rounded-xl border border-border bg-surface text-[13px] hover:border-primary/50 hover:bg-primary/5 transition-colors"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {restyleActions.length > 0 && (
                    <div className="mb-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle mb-2 flex items-center gap-1.5">
                        <Wand2 className="h-3 w-3" /> Restyle the room
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {restyleActions.map((label) => (
                          <button
                            key={label}
                            onClick={() => send(label)}
                            className="px-2.5 h-8 rounded-full border border-border bg-surface text-xs font-medium hover:border-primary/50 hover:bg-primary/5 transition-colors"
                          >
                            {label.replace(/^(Change the |Remove the )/, "")}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {furnitureActions.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle mb-2 flex items-center gap-1.5">
                        <Plus className="h-3 w-3" /> Add furniture
                      </p>
                      <div className="space-y-1.5">
                        {furnitureActions.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => send(`Add ${p.name}`)}
                            className="w-full flex items-center gap-2.5 p-1.5 rounded-xl border border-border bg-surface text-left hover:bg-surface-muted transition-colors"
                          >
                            <span className="relative h-8 w-8 rounded-lg overflow-hidden shrink-0 bg-surface-muted">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={p.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                            </span>
                            <span className="text-sm font-medium flex-1 truncate">{p.name}</span>
                            <span className="text-xs text-primary font-semibold shrink-0 pr-1">{formatINR(p.priceInr)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.map((m) => (
                    <Bubble
                      key={m.id}
                      msg={m}
                      busy={busy}
                      onApply={m.plan ? () => applyPlan(m.id, m.plan!) : undefined}
                    />
                  ))}
                  {typing && <Typing label={busyLabel} />}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            <div className="px-4 pb-4 pt-2 shrink-0">
              <div className="flex items-end gap-2 pl-4 pr-1.5 py-1.5 rounded-2xl bg-surface-muted border border-border focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
                <textarea
                  rows={1}
                  value={input}
                  disabled={busy}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  placeholder={busy ? "Working…" : "Describe a change or a piece to add…"}
                  aria-label="Message"
                  className="flex-1 resize-none bg-transparent py-2 outline-none text-sm placeholder:text-subtle max-h-24 disabled:opacity-60"
                />
                <button
                  aria-label="Send"
                  onClick={() => send(input)}
                  disabled={!input.trim() || busy}
                  className="grid place-items-center h-9 w-9 rounded-xl brand-gradient text-white shadow-[var(--shadow-glow)] disabled:opacity-40 disabled:shadow-none transition-all shrink-0 active:scale-95"
                >
                  <ArrowUp className="h-[18px] w-[18px]" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/* An AI proposal: what it understood, the pieces it picked, the cost against any
   budget the user named, and a single action to place the lot. */
function PlanCard({
  plan,
  busy,
  onApply,
}: {
  plan: Plan;
  busy: boolean;
  onApply?: () => void;
}) {
  const pieces = plan.items.reduce((n, l) => n + l.qty, 0);
  const overBudget = plan.budgetInr > 0 && plan.totalInr > plan.budgetInr;
  return (
    <div className="mt-2.5 rounded-2xl border border-border bg-surface overflow-hidden">
      {plan.intent && (
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
          <Wand2 className="h-3 w-3 text-primary shrink-0" />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle truncate">
            {plan.intent}
          </p>
        </div>
      )}

      <div className="px-1.5 pb-1.5 space-y-0.5">
        {plan.items.map((line) => (
          <div key={line.product.id} className="flex items-center gap-2.5 p-1.5 rounded-xl">
            <span className="relative h-9 w-9 rounded-lg overflow-hidden shrink-0 bg-surface-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={line.product.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="text-[13px] font-medium truncate">{line.product.name}</span>
                {line.qty > 1 && (
                  <span className="text-[11px] text-muted shrink-0">× {line.qty}</span>
                )}
              </span>
              {line.reason && (
                <span className="block text-[11px] text-subtle truncate">{line.reason}</span>
              )}
            </span>
            <span className="text-[11px] font-semibold text-muted shrink-0 pr-1">
              {formatINR(line.subtotalInr)}
            </span>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-border/70 bg-surface-muted/40">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] text-subtle">
            {pieces} piece{pieces === 1 ? "" : "s"}
            {plan.budgetInr > 0 && ` · budget ${formatINR(plan.budgetInr)}`}
          </span>
          <span
            className={cn(
              "text-sm font-semibold",
              overBudget ? "text-amber-500" : "text-foreground",
            )}
          >
            {formatINR(plan.totalInr)}
          </span>
        </div>
        {plan.trimmed && (
          <p className="text-[11px] text-subtle mt-1">Trimmed to stay within your budget.</p>
        )}
        {plan.droppedForSpace && plan.droppedForSpace.length > 0 && (
          <p className="text-[11px] text-subtle mt-1">
            Sized to the room — left out {plan.droppedForSpace.join(", ")} for want of floor space.
          </p>
        )}

        {plan.applied ? (
          <p className="mt-2 text-[12px] font-medium text-emerald-500">✓ Added to your room</p>
        ) : (
          onApply && (
            <button
              onClick={onApply}
              disabled={busy}
              className="mt-2 w-full h-9 rounded-xl brand-gradient text-white text-[13px] font-semibold shadow-[var(--shadow-glow)] disabled:opacity-50 disabled:shadow-none transition-all active:scale-[0.98]"
            >
              {busy ? "Placing…" : "Add all to room"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function Bubble({
  msg,
  busy = false,
  onApply,
}: {
  msg: Msg;
  busy?: boolean;
  onApply?: () => void;
}) {
  const isUser = msg.role === "user";
  // User prompts sit right as subtle chips; the AI replies as clean editorial blocks
  // with a small gradient mark — no bright "chat app" bubbles.
  if (isUser) {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
        <div className="max-w-[85%] px-3.5 py-2 rounded-2xl rounded-tr-md bg-surface-muted text-foreground text-sm leading-relaxed">
          {msg.text}
        </div>
      </motion.div>
    );
  }
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5">
      <span className="grid place-items-center h-6 w-6 rounded-full brand-gradient text-white shrink-0 mt-0.5">
        <Sparkles className="h-3 w-3" />
      </span>
      <div className="max-w-[85%] min-w-0">
        <div className="text-sm leading-relaxed text-foreground">{msg.text}</div>
        {msg.plan && <PlanCard plan={msg.plan} busy={busy} onApply={onApply} />}
        {msg.image && (
          <div className="mt-2 rounded-xl overflow-hidden border border-border w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={msg.image} alt="Updated room" className="w-full aspect-[4/3] object-cover" />
          </div>
        )}
        {msg.product && (
          <div className="mt-2 flex items-center gap-2.5 p-2 rounded-xl border border-border bg-surface w-full">
            <span className="relative h-10 w-10 rounded-lg overflow-hidden shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={msg.product.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">{msg.product.name}</span>
              <span className="block text-xs text-primary font-semibold">
                {formatINR(msg.product.priceInr)}
              </span>
            </span>
            <span className="grid place-items-center h-6 w-6 rounded-full bg-emerald-500 text-white shrink-0">
              <Plus className="h-3.5 w-3.5" />
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Typing({ label }: { label?: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="grid place-items-center h-6 w-6 rounded-full brand-gradient text-white shrink-0 mt-0.5">
        <Sparkles className="h-3 w-3" />
      </span>
      <div className="flex items-center gap-2 py-1">
        <span className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-muted"
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </span>
        {label && <span className="text-xs text-muted">{label}</span>}
      </div>
    </div>
  );
}
