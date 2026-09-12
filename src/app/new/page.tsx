"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  UploadCloud,
  Check,
  ArrowRight,
  ArrowLeft,
  Image as ImageIcon,
  Sparkles,
  Wand2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { STYLES, styleMeta, type Style } from "@/lib/data";

const steps = [
  { id: 1, label: "Room Photo" },
  { id: 2, label: "Style" },
  { id: 3, label: "Review" },
  { id: 4, label: "Generate" },
];

const ROOM_TYPES = [
  "Living Room",
  "Bedroom",
  "Dining",
  "Kitchen",
  "Home Office",
  "Outdoor",
];

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

const inputCls =
  "w-full h-12 px-4 rounded-xl bg-surface border border-border focus:border-primary outline-none text-[15px] transition-colors";

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [roomType, setRoomType] = useState(ROOM_TYPES[0]);
  const [style, setStyle] = useState<Style | null>("Scandinavian");

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // Nested elements fire dragleave as the pointer crosses them, so count
  // enter/leave instead of toggling on the first leave.
  const dragDepth = useRef(0);

  const onPickPhoto = (f: File | null) => {
    if (f) {
      if (!f.type.startsWith("image/")) {
        setPhotoError(`${f.name} isn't an image. Drop a JPG or PNG.`);
        return;
      }
      if (f.size > MAX_PHOTO_BYTES) {
        setPhotoError(
          `That photo is ${(f.size / 1024 / 1024).toFixed(1)}MB — the limit is 20MB.`,
        );
        return;
      }
    }
    setPhotoError(null);
    setPhotoFile(f);
    setPhotoPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return f ? URL.createObjectURL(f) : null;
    });
  };

  /* Without this, a photo dropped just outside the zone makes the browser
     navigate away to the file and the user loses everything typed so far. */
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const items = Array.from(e.dataTransfer.files);
    if (!items.length) {
      // Dragging an image straight off a web page gives a URL, not a file.
      setPhotoError("Drop an image file from your computer.");
      return;
    }
    onPickPhoto(items.find((f) => f.type.startsWith("image/")) ?? items[0]);
  };

  const dragProps = {
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy" as const;
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragging(false);
      }
    },
    onDrop,
  };

  // Actually upload the photo + create the project record in the database.
  const createProject = useCallback(async () => {
    if (!photoFile || !name.trim() || !style) return;
    setStep(4);
    setGenerating(true);
    setError(null);
    try {
      const { url } = await api.uploadFile(photoFile, "rooms");
      const project = await api.createProject({
        name: name.trim(),
        roomType,
        style,
        photoUrl: url,
      });
      // Hand off to the studio with the real project id.
      router.push(`/studio?project=${project.id}`);
    } catch (e) {
      setGenerating(false);
      setError(e instanceof Error ? e.message : "Failed to create project");
    }
  }, [photoFile, name, roomType, style, router]);

  const next = useCallback(() => {
    if (step === 3) {
      createProject();
      return;
    }
    setStep((s) => Math.min(s + 1, 4));
  }, [step, createProject]);

  const back = () => setStep((s) => Math.max(s - 1, 1));

  const canAdvance =
    (step === 1 && !!photoFile && !!name.trim()) ||
    (step === 2 && !!style) ||
    step === 3;

  return (
    <div className="px-5 lg:px-8 py-7 max-w-3xl mx-auto">
      {/* Progress */}
      <div className="flex items-center justify-between mb-10">
        {steps.map((s, i) => (
          <div key={s.id} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-2">
              <div
                className={cn(
                  "grid place-items-center h-10 w-10 rounded-full text-sm font-semibold transition-all duration-300",
                  step > s.id && "brand-gradient text-white",
                  step === s.id &&
                    "bg-surface text-primary border-2 border-primary shadow-[var(--shadow-glow)]",
                  step < s.id && "bg-surface-muted text-subtle border border-border",
                )}
              >
                {step > s.id ? <Check className="h-5 w-5" /> : s.id}
              </div>
              <span
                className={cn(
                  "text-xs font-medium hidden sm:block",
                  step >= s.id ? "text-foreground" : "text-subtle",
                )}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className="flex-1 h-0.5 mx-2 rounded-full bg-border relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 brand-gradient transition-all duration-500"
                  style={{ width: step > s.id ? "100%" : "0%" }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          {step === 1 && (
            <StepShell
              title="Upload your room photo"
              subtitle="A clear, well-lit photo gives the best results. You'll place furniture on it in the studio."
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onPickPhoto(e.target.files?.[0] ?? null)}
              />
              <div {...dragProps}>
                {photoPreview ? (
                  <div
                    className={cn(
                      "relative rounded-3xl overflow-hidden border transition-colors duration-200",
                      dragging ? "border-primary border-2" : "border-border",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoPreview} alt="Room" className="w-full max-h-[340px] object-cover" />
                    <button
                      onClick={() => fileRef.current?.click()}
                      className="absolute top-3 right-3 inline-flex items-center gap-1.5 h-9 px-3 rounded-xl glass !border-white/20 text-white text-sm font-medium"
                    >
                      <UploadCloud className="h-4 w-4" /> Replace
                    </button>
                    <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 glass !border-white/20 text-white text-sm px-3 py-1.5 rounded-full">
                      <Check className="h-4 w-4 text-emerald-400" /> {photoFile?.name}
                    </span>
                    {dragging && (
                      <div className="absolute inset-0 grid place-items-center gap-2 bg-surface/80 backdrop-blur-sm pointer-events-none">
                        <div className="grid place-items-center h-14 w-14 rounded-2xl bg-primary/10 text-primary">
                          <UploadCloud className="h-6 w-6" />
                        </div>
                        <p className="font-medium">Drop to replace this photo</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => fileRef.current?.click()}
                    className={cn(
                      "w-full grid place-items-center text-center gap-3 py-16 rounded-3xl border-2 border-dashed transition-all duration-300",
                      dragging
                        ? "border-primary bg-primary/5 scale-[1.01]"
                        : "border-border-strong hover:border-primary hover:bg-surface-muted/50",
                    )}
                  >
                    <div
                      className={cn(
                        "grid place-items-center h-16 w-16 rounded-2xl transition-colors duration-200",
                        dragging ? "bg-primary/10 text-primary" : "bg-surface-muted text-muted",
                      )}
                    >
                      {dragging ? <UploadCloud className="h-7 w-7" /> : <ImageIcon className="h-7 w-7" />}
                    </div>
                    <div>
                      <p className="font-medium text-lg">
                        {dragging ? "Drop your photo here" : "Drag & drop your room photo"}
                      </p>
                      <p className="text-subtle text-sm mt-1">JPG or PNG · up to 20MB</p>
                    </div>
                    {!dragging && (
                      <span className="inline-flex items-center gap-2 mt-2 text-primary font-medium text-sm">
                        <UploadCloud className="h-4 w-4" /> Browse files
                      </span>
                    )}
                  </button>
                )}
              </div>

              {photoError && (
                <p className="flex items-center gap-2 mt-3 text-sm text-rose-500">
                  <AlertCircle className="h-4 w-4 shrink-0" /> {photoError}
                </p>
              )}

              <div className="grid sm:grid-cols-2 gap-3 mt-5">
                <label className="block">
                  <span className="text-sm font-medium text-muted mb-1.5 block">Project name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. My Living Room"
                    className={inputCls}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-muted mb-1.5 block">Room type</span>
                  <select value={roomType} onChange={(e) => setRoomType(e.target.value)} className={inputCls}>
                    {ROOM_TYPES.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
              </div>
            </StepShell>
          )}

          {step === 2 && (
            <StepShell
              title="Choose your style"
              subtitle="Pick the aesthetic you love. You can always change it later in the studio."
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {STYLES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStyle(s)}
                    className={cn(
                      "relative aspect-[4/5] rounded-2xl overflow-hidden border-2 transition-all duration-300 text-left",
                      style === s
                        ? "border-primary shadow-[var(--shadow-glow)] scale-[1.02]"
                        : "border-transparent hover:border-border-strong",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={styleMeta[s].image}
                      alt={s}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
                    {style === s && (
                      <div className="absolute top-2.5 right-2.5 grid place-items-center h-6 w-6 rounded-full bg-primary text-white">
                        <Check className="h-3.5 w-3.5" />
                      </div>
                    )}
                    <span className="absolute bottom-3 left-3 text-white font-semibold">
                      {s}
                      <span className="block text-white/80 text-xs font-normal">
                        {styleMeta[s].blurb}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </StepShell>
          )}

          {step === 3 && (
            <StepShell
              title="Review your project"
              subtitle="Everything looks good? Create your project."
            >
              <div className="space-y-3">
                <ReviewRow label="Project name" value={name || "—"} ok={!!name.trim()} />
                <ReviewRow label="Room type" value={roomType} ok />
                <ReviewRow label="Room photo" value={photoFile ? photoFile.name : "None"} ok={!!photoFile} />
                <ReviewRow label="Style" value={style ?? "—"} ok={!!style} />
              </div>
            </StepShell>
          )}

          {step === 4 && (
            <Generating error={error} onRetry={() => { setError(null); setStep(3); }} />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Footer nav */}
      {step < 4 && (
        <div className="flex items-center justify-between mt-10">
          <Button variant="ghost" onClick={back} disabled={step === 1}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button onClick={next} disabled={!canAdvance}>
            {step === 3 ? (
              <>
                <Sparkles className="h-4 w-4" /> Create Project
              </>
            ) : (
              <>
                Continue <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function StepShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-center">{title}</h1>
      <p className="text-muted text-center mt-2.5 max-w-lg mx-auto">{subtitle}</p>
      <div className="mt-8">{children}</div>
    </div>
  );
}

function ReviewRow({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <div className="flex items-center justify-between p-4 rounded-2xl border border-border bg-surface">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2 font-medium">
        <span className="truncate max-w-[180px]">{value}</span>
        <span
          className={cn(
            "grid place-items-center h-5 w-5 rounded-full text-white shrink-0",
            ok ? "bg-emerald-500" : "bg-subtle",
          )}
        >
          <Check className="h-3 w-3" />
        </span>
      </span>
    </div>
  );
}

function Generating({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="grid place-items-center py-16 text-center">
        <div className="grid place-items-center h-16 w-16 rounded-2xl bg-rose-500/10 text-rose-500 mb-5">
          <AlertCircle className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Couldn&apos;t create project</h1>
        <p className="text-muted mt-2 max-w-md">{error}</p>
        <Button className="mt-6" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="grid place-items-center py-16 text-center">
      <div className="relative grid place-items-center h-28 w-28 mb-8">
        <div className="absolute inset-0 rounded-full brand-gradient opacity-20 animate-ping" />
        <div className="absolute inset-2 rounded-full brand-gradient opacity-30 animate-pulse" />
        <div className="relative grid place-items-center h-20 w-20 rounded-full brand-gradient text-white shadow-[var(--shadow-glow)]">
          <Wand2 className="h-9 w-9" />
        </div>
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">Setting up your room…</h1>
      <p className="text-muted mt-2.5 max-w-md">
        Uploading your photo and creating the project. You&apos;ll land in the
        studio in a moment.
      </p>
    </div>
  );
}
