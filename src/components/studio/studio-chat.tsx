"use client";

import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, ArrowUp, Plus, Wand2, RotateCcw, ChevronDown } from "lucide-react";
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
  /** Restyle directions the user can pick between, tailored to their brief. */
  surfaceOptions?: { label: string; instruction: string; reason: string }[] | null;
  /** Removing the room's existing dated furniture — asked separately. */
  clearInstruction?: string | null;
};

/** A yes/no (or pick-one) prompt rendered as buttons, so the user never has to
    guess the wording. Used to confirm changes that replace the room photo. */
type Action = { label: string; primary?: boolean; run: () => void };

type Msg = {
  id: number;
  role: "user" | "ai";
  text: string;
  product?: ProductDTO;
  image?: string;
  plan?: Plan;
  actions?: Action[];
  /** Once chosen, the buttons collapse to the label that was picked. */
  chose?: string;
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
  tools,
  roomEmpty,
  pendingPrompt,
  onPendingPromptHandled,
  analysisNonce,
}: {
  products: ProductDTO[];
  /** Places one piece. Resolves false when the room has no space for it. */
  onAdd: (productId: string) => void | Promise<{ ok: boolean } | void>;
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
  /** Manual tools, rendered inside the bar behind a "+" so they don't take a row. */
  tools?: React.ReactNode;
  /** Openers are only worth screen space while the room is still empty. */
  roomEmpty?: boolean;
  /** A prompt pushed in from the tool menu (e.g. a flooring preset). */
  pendingPrompt?: string | null;
  onPendingPromptHandled?: () => void;
  /** Increments when the studio finishes measuring the room. */
  analysisNonce?: number;
}) {
  // The bar is always docked; `expanded` only controls the conversation above it.
  const [expanded, setExpanded] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | undefined>();
  const endRef = useRef<HTMLDivElement>(null);
  // Message ids must be unique: Date.now()+N collided when two messages were
  // pushed within the same millisecond, duplicating React keys.
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  // Mirror of the analysis counter so an async flow can await the next one.
  const analysisRef = useRef(analysisNonce ?? 0);
  useEffect(() => {
    analysisRef.current = analysisNonce ?? 0;
  }, [analysisNonce]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typing, expanded]);

  // The "+" menu can hand us a prompt (a flooring or wall preset); run it once.
  const sendRef = useRef<(t: string) => void>(() => {});
  useEffect(() => {
    if (!pendingPrompt) return;
    sendRef.current(pendingPrompt);
    onPendingPromptHandled?.();
  }, [pendingPrompt, onPendingPromptHandled]);

  const reply = (msg: Omit<Msg, "id" | "role">) => {
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      setMessages((m) => [...m, { id: nextId(), role: "ai", ...msg }]);
    }, 750);
  };

  const send = async (text: string) => {
    const raw = text.trim();
    if (!raw || busy) return;
    const t = raw.toLowerCase();
    setMessages((m) => [...m, { id: nextId(), role: "user", text: raw }]);
    setInput("");
    setExpanded(true); // any new exchange pulls the conversation back into view

    // Revert the room to its original photo.
    if (onRevert && /\b(revert|undo|reset|original)\b/.test(t) && /\b(room|wall|change|photo|edit|it)\b/.test(t)) {
      setBusy(true);
      setTyping(true);
      try {
        await onRevert();
        setTyping(false);
        setMessages((m) => [...m, { id: nextId(), role: "ai", text: "Reverted the room to its original photo." }]);
      } finally {
        setBusy(false);
        setTyping(false);
      }
      return;
    }

    // Room edit (wallpaper, curtains, paint, flooring…) — Gemini image editing.
    // This repaints the base photo, so confirm before spending ~20s on it.
    if (isRoomEdit(t)) {
      if (!projectId || !photoUrl || !onRoomEdited) {
        reply({ text: "I can edit the room once it's fully loaded — give it a moment and try again." });
        return;
      }
      const id = nextId();
      setTyping(true);
      setTimeout(() => {
        setTyping(false);
        setMessages((m) => [
          ...m,
          {
            id,
            role: "ai",
            text: `I'll repaint the room for that — “${raw}”. It becomes the new base photo (your furniture stays put, and you can revert any time).`,
            actions: [
              { label: "Make the change", primary: true, run: () => runRoomEdit(id, raw) },
              {
                label: "Cancel",
                run: () =>
                  setMessages((m) =>
                    m.map((msg) => (msg.id === id ? { ...msg, chose: "Cancelled", actions: undefined } : msg)),
                  ),
              },
            ],
          },
        ]);
      }, 400);
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

    await runDesign(raw);
  };

  sendRef.current = send;

  /** Actually perform a confirmed room edit. Resolves true when the photo changed. */
  const runRoomEdit = async (msgId: number, instruction: string): Promise<boolean> => {
    if (!projectId || !photoUrl || !onRoomEdited || busy) return false;
    setMessages((m) =>
      m.map((msg) => (msg.id === msgId ? { ...msg, chose: "Making the change", actions: undefined } : msg)),
    );
    setBusy(true);
    setBusyLabel("Repainting the room… (~15–25s)");
    setTyping(true);
    let ok = false;
    {
      try {
        const newUrl = await api.editRoom(projectId, photoUrl, instruction);
        onRoomEdited(newUrl);
        ok = true;
        setTyping(false);
        setMessages((m) => [
          ...m,
          {
            id: nextId(),
            role: "ai",
            text: `Done — the room is repainted. This is now your base photo, so anything you add or render sits on the new look.`,
            image: newUrl,
          },
        ]);
      } catch (e) {
        setTyping(false);
        const err = e as { code?: string };
        setMessages((m) => [
          ...m,
          {
            id: nextId(),
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
    }
    return ok;
  };

  /* "Make it modern" often carries an unspoken "and get rid of the old stuff" —
     but their sofa might be staying, so ask rather than assume. Answering merges
     the two instructions into ONE edit, so it still costs a single image call. */
  const askAboutClearing = (plan: Plan, styleInstruction: string) => {
    const clear = plan.clearInstruction;
    if (!clear) {
      restyleThenFurnish(nextId(), plan, styleInstruction);
      return;
    }
    const id = nextId();
    setMessages((m) => [
      ...m,
      {
        id,
        role: "ai",
        text: `One thing before I start — ${clear.replace(/^remove /i, "should I also clear out ").replace(/\.$/, "")}? I can do it in the same pass.`,
        actions: [
          {
            label: "Yes, clear them out",
            primary: true,
            run: () => {
              setMessages((mm) =>
                mm.map((x) => (x.id === id ? { ...x, chose: "Clearing them out", actions: undefined } : x)),
              );
              restyleThenFurnish(id, plan, `${styleInstruction.replace(/\.$/, "")}, and ${clear}`);
            },
          },
          {
            label: "No, keep them",
            run: () => {
              setMessages((mm) =>
                mm.map((x) => (x.id === id ? { ...x, chose: "Keeping the existing furniture", actions: undefined } : x)),
              );
              restyleThenFurnish(id, plan, styleInstruction);
            },
          },
        ],
      },
    ]);
  };

  /* Room first, furniture second. After the repaint the photo is new, so the
     studio re-runs its room analysis — wait for that before placing, otherwise
     the layout is packed against the floor of a room that no longer exists. */
  const restyleThenFurnish = async (msgId: number, plan: Plan, instruction: string) => {
    const ok = await runRoomEdit(msgId, instruction);
    if (!ok) return;

    /* Wait for the room to actually be re-measured. A fixed delay was not enough:
       placement then ran with no floor calibration and no known obstacles, and
       dropped a sofa straight on top of the wheelchair. */
    setBusy(true);
    setBusyLabel("Re-reading the new room…");
    setTyping(true);
    const before = analysisRef.current;
    const deadline = Date.now() + 30000;
    while (analysisRef.current === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 400)); // let the state settle into props
    setTyping(false);
    setBusy(false);
    setBusyLabel(undefined);

    const nextMsgId = nextId();
    setMessages((m) => [
      ...m,
      {
        id: nextMsgId,
        role: "ai",
        text: "Room's done. Ready to place the furniture into it?",
        plan,
        actions: [
          {
            label: "Add the furniture",
            primary: true,
            run: () => {
              setMessages((mm) =>
                mm.map((x) => (x.id === nextMsgId ? { ...x, chose: "Placing", actions: undefined } : x)),
              );
              applyPlan(nextMsgId, plan);
            },
          },
          {
            label: "Not now",
            run: () =>
              setMessages((mm) =>
                mm.map((x) => (x.id === nextMsgId ? { ...x, chose: "Left the room empty", actions: undefined } : x)),
              ),
          },
        ],
      },
    ]);
  };

  /** Place a single named piece, or ask Gemini to design the whole space. */
  const runDesign = async (raw: string) => {
    const t = raw.toLowerCase();

    // Unambiguous single add — place it straight away, no AI round-trip.
    const direct = directAdd(t, products);
    if (direct) {
      setTyping(true);
      const res = await onAdd(direct.id);
      setTyping(false);
      // Don't claim success when the room actually refused the piece.
      if (res && res.ok === false) {
        setMessages((m) => [
          ...m,
          {
            id: nextId(),
            role: "ai",
            text: `There isn't clear floor space left for a ${direct.name}. Remove something first, or tell me the look you're after and I'll plan a set that fits.`,
          },
        ]);
        return;
      }
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          role: "ai",
          text: `Done — I've placed a ${direct.name} in your room and selected it. Drag to reposition, or tell me what you're going for and I'll design the whole space.`,
          product: direct,
        },
      ]);
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
            id: nextId(),
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
            id: nextId(),
            role: "ai",
            text: "This room doesn't have clear floor space left for anything more. Remove a piece or two and ask me again, and I'll design around what's left.",
          },
        ]);
        return;
      }

      const totalInr = items.reduce((n, l) => n + l.subtotalInr, 0);
      const options = plan.surfaceOptions ?? [];
      const canEdit = !!(projectId && photoUrl && onRoomEdited && options.length);
      const msgId = nextId();
      const planData: Plan = {
        intent: plan.intent,
        budgetInr: plan.budgetInr,
        totalInr,
        trimmed: plan.trimmed,
        droppedForSpace,
        items,
        surfaceOptions: plan.surfaceOptions,
        clearInstruction: plan.clearInstruction,
      };

      /* Order matters: finish the room, THEN furnish it. Placing first meant the
         layout was computed against the old room and the user watched furniture
         appear before the walls and floor caught up. */
      setMessages((m) => [
        ...m,
        {
          id: msgId,
          role: "ai",
          text: canEdit
            ? `${plan.reply}\n\nI'd finish the room first, then place these pieces into it. Which direction do you want?\n\n${options
                .map((o) => `· ${o.label} — ${o.reason || o.instruction}`)
                .join("\n")}`
            : plan.reply,
          plan: planData,
          /* A style choice, not a yes/no: each button is a different direction on
             the brief, so the user steers the look without having to describe it. */
          actions: canEdit
            ? [
                ...options.map((o, i) => ({
                  label: o.label,
                  primary: i === 0,
                  run: () => {
                    setMessages((mm) =>
                      mm.map((x) => (x.id === msgId ? { ...x, chose: o.label, actions: undefined } : x)),
                    );
                    askAboutClearing(planData, o.instruction);
                  },
                })),
                {
                  label: "Keep the room as it is",
                  run: () => {
                    setMessages((mm) =>
                      mm.map((x) =>
                        x.id === msgId ? { ...x, chose: "Keeping the room as it is", actions: undefined } : x,
                      ),
                    );
                    applyPlan(msgId, planData);
                  },
                },
              ]
            : undefined,
        },
      ]);
    } catch (e) {
      setTyping(false);
      const err = e as { code?: string };
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
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
      const placedText = skipped.length
        ? `Placed ${added} of ${total} pieces, spaced around the room. There wasn't clear floor left for: ${skipped.join(", ")}. Drag things around, or ask me to swap something smaller in.`
        : `Placed all ${added} pieces, spaced around the room. Drag anything to fine-tune, or hit Render Scene to see it photoreal.`;

      setMessages((m) => [...m, { id: nextId(), role: "ai", text: placedText }]);
    } finally {
      setBusy(false);
      setBusyLabel(undefined);
    }
  };

  /* A short, mixed set of openers: design first (the headline capability), then a
     restyle, so the bar advertises both without becoming a menu. Labels stay
     chip-sized; the prompt actually sent is the fuller sentence. */
  const suggestions: { label: string; prompt: string }[] = [
    ...(capture && onApplyPlan
      ? [
          { label: "Office waiting area", prompt: "Turn this into a modern office waiting area" },
          { label: "Under ₹2 lakh", prompt: "Furnish this room well, keeping everything under ₹2 lakh" },
        ]
      : []),
    ...(onRoomEdited
      ? [{ label: "Warm beige walls", prompt: "Change the wallpaper to warm beige" }]
      : []),
  ];
  const empty = messages.length === 0;

  return (
    /* The studio's primary control. Positioning is owned by the page's bottom
       cluster so the manual tool dock stacks above this instead of overlapping
       it; here we only lay out conversation → suggestions → prompt bar. */
    <div className="w-full flex flex-col items-center gap-2 pointer-events-none">
      {/* Conversation — only once there is something to show */}
      <AnimatePresence>
        {expanded && !empty && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto w-[min(780px,100%)] rounded-[22px] bg-surface/95 backdrop-blur-2xl border border-border shadow-2xl overflow-hidden"
          >
            <div className="flex items-center gap-2.5 px-4 h-12 border-b border-border/70 shrink-0">
              <span className="grid place-items-center h-7 w-7 rounded-full brand-gradient text-white shrink-0">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <p className="font-semibold tracking-tight text-sm flex-1 min-w-0">AI Designer</p>
              {edited && onRevert && (
                <button
                  onClick={async () => {
                    if (busy) return;
                    setBusy(true);
                    setTyping(true);
                    try {
                      await onRevert();
                      setMessages((m) => [...m, { id: nextId(), role: "ai", text: "Reverted the room to its original photo." }]);
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
              )}
              <button
                onClick={() => setExpanded(false)}
                aria-label="Collapse conversation"
                className="grid place-items-center h-7 w-7 rounded-full text-muted hover:bg-surface-muted transition-colors shrink-0"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[min(46vh,440px)] overflow-y-auto px-4 py-4 space-y-4">
              {messages.map((m) => (
                <Bubble
                  key={m.id}
                  msg={m}
                  busy={busy}
                  /* Hide the card's own Add button while a choice is pending — it
                     would skip the room step — and also once one has been made,
                     since clearing `actions` would otherwise re-expose it and let
                     the same plan be added twice. */
                  onApply={
                    m.plan && !m.actions && !m.chose ? () => applyPlan(m.id, m.plan!) : undefined
                  }
                />
              ))}
              {typing && <Typing label={busyLabel} />}
              <div ref={endRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Openers — only while the room is still empty and nothing has been asked,
          so they stop competing with the room once work is under way. */}
      {empty && roomEmpty && suggestions.length > 0 && (
        <div className="pointer-events-auto w-[min(780px,100%)] flex flex-wrap justify-center gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s.label}
              onClick={() => send(s.prompt)}
              disabled={busy}
              className="px-3 h-8 rounded-full bg-surface/90 backdrop-blur-xl border border-border text-xs font-medium hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* The prompt bar itself — the widest, most prominent control on screen */}
      <div className="pointer-events-auto w-[min(780px,100%)]">
        <div className="flex items-end gap-2 pl-3 pr-2 py-2 rounded-[20px] bg-surface/95 backdrop-blur-2xl border border-border shadow-[var(--shadow-lg)] focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
          <span className="grid place-items-center h-8 w-8 rounded-full brand-gradient text-white shrink-0">
            <Sparkles className="h-4 w-4" />  
          </span>

          {tools}

          <textarea
            rows={1}
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => !empty && setExpanded(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder={
              busy
                ? busyLabel ?? "Working…"
                : "Describe the space you want - I'll design it from the marketplace"
            }
            aria-label="Message"
            className="flex-1 resize-none bg-transparent py-2 outline-none text-sm placeholder:text-subtle max-h-28 disabled:opacity-60"
          />

          {!empty && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="h-9 px-3 rounded-xl text-xs font-medium text-muted hover:bg-surface-muted transition-colors shrink-0"
            >
              {messages.length} message{messages.length === 1 ? "" : "s"}
            </button>
          )}

          <button
            aria-label="Send"
            onClick={() => send(input)}
            disabled={!input.trim() || busy}
            className="grid place-items-center h-10 w-10 rounded-2xl brand-gradient text-white shadow-[var(--shadow-glow)] disabled:opacity-40 disabled:shadow-none transition-all shrink-0 active:scale-95"
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
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

        {/* Confirmations answer with a click, never by typing the right words. */}
        {msg.actions && msg.actions.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {msg.actions.map((a) => (
              <button
                key={a.label}
                onClick={a.run}
                disabled={busy}
                className={cn(
                  "h-9 px-4 rounded-xl text-[13px] font-semibold transition-all active:scale-[0.98] disabled:opacity-50",
                  a.primary
                    ? "brand-gradient text-white shadow-[var(--shadow-glow)]"
                    : "border border-border bg-surface hover:bg-surface-muted",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        {msg.chose && (
          <p className="mt-2 text-[12px] font-medium text-muted">✓ {msg.chose}</p>
        )}

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
