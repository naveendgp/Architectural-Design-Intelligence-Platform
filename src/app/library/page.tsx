"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Plus, SlidersHorizontal, Sofa, Trash2, AlertTriangle } from "lucide-react";
import { Page } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import type { Style, ProductDTO } from "@/lib/types";
import { cn, formatINR } from "@/lib/utils";

const filters: ("All" | Style | "Wooden")[] = [
  "All",
  "Modern",
  "Classical",
  "Wooden",
  "Luxury",
  "Minimal",
];

export default function LibraryPage() {
  const [active, setActive] = useState<string>("All");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ProductDTO | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .products()
      .then((p) => active && setProducts(p))
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const items = useMemo(() => {
    return products.filter((f) => {
      const matchesQuery =
        !query ||
        f.name.toLowerCase().includes(query.toLowerCase()) ||
        f.category.toLowerCase().includes(query.toLowerCase());
      const matchesFilter =
        active === "All" ||
        active === "Wooden" ||
        f.styleTags.includes(active as Style);
      return matchesQuery && matchesFilter;
    });
  }, [active, query, products]);

  const doDelete = useCallback(async () => {
    if (!confirm) return;
    const id = confirm.id;
    setDeleting(true);
    try {
      await api.deleteProduct(id);
      setProducts((prev) => prev.filter((p) => p.id !== id));
      setConfirm(null);
    } catch {
      // keep dialog open on failure
    } finally {
      setDeleting(false);
    }
  }, [confirm]);

  return (
    <Page>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight">Furniture Library</h1>
        <p className="text-muted mt-1.5">
          Browse your marketplace pieces — ready to drop into your designs
        </p>
      </div>

      {/* Search */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sofas, lamps, tables…"
            aria-label="Search furniture"
            className="w-full h-13 pl-12 pr-4 rounded-2xl bg-surface border border-border focus:border-primary text-[15px] placeholder:text-subtle outline-none transition-colors shadow-[var(--shadow-sm)]"
          />
        </div>
        <button className="inline-flex items-center justify-center gap-2 h-13 px-5 rounded-2xl bg-surface border border-border text-[15px] font-medium hover:bg-surface-muted transition-colors">
          <SlidersHorizontal className="h-[18px] w-[18px]" /> Filters
        </button>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2 mb-7">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setActive(f)}
            className={cn(
              "h-9 px-4 rounded-full text-sm font-medium border transition-all",
              active === f
                ? "brand-gradient text-white border-transparent shadow-[var(--shadow-glow)]"
                : "bg-surface text-muted border-border hover:text-foreground hover:bg-surface-muted",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Masonry grid */}
      {loading ? (
        <div className="columns-2 md:columns-3 lg:columns-4 gap-5 [&>*]:mb-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton
              key={i}
              className={cn(
                "w-full rounded-2xl",
                i % 3 === 0 ? "aspect-[3/4]" : i % 2 === 0 ? "aspect-square" : "aspect-[4/5]",
              )}
            />
          ))}
        </div>
      ) : items.length > 0 ? (
        <div className="columns-2 md:columns-3 lg:columns-4 gap-5 [&>*]:mb-5">
          {items.map((f, i) => (
            <motion.div
              key={f.id}
              layout
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ delay: (i % 8) * 0.04 }}
              className="break-inside-avoid group relative overflow-hidden rounded-2xl border border-border bg-surface"
            >
              <div className="relative overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={f.thumbnailUrl}
                  alt={f.name}
                  className={cn(
                    "w-full object-cover transition-transform duration-500 group-hover:scale-105",
                    i % 3 === 0 ? "aspect-[3/4]" : i % 2 === 0 ? "aspect-square" : "aspect-[4/5]",
                  )}
                />
                <button
                  aria-label={`Delete ${f.name}`}
                  onClick={() => setConfirm(f)}
                  className="absolute top-3 right-3 grid place-items-center h-10 w-10 rounded-xl glass !border-white/20 text-white opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0 transition-all hover:!bg-rose-500/80"
                >
                  <Trash2 className="h-[18px] w-[18px]" />
                </button>
                {f.modelUrl && (
                  <span className="absolute bottom-3 left-3 inline-flex items-center gap-1 glass !border-white/20 text-white text-[11px] font-medium px-2 py-1 rounded-full">
                    3D
                  </span>
                )}
              </div>
              <div className="p-4">
                <p className="text-xs text-subtle">{f.category}</p>
                <p className="font-medium tracking-tight truncate">{f.name}</p>
                <div className="flex items-center justify-between mt-2">
                  <span className="font-semibold text-primary">{formatINR(f.priceInr)}</span>
                  <div className="flex gap-1">
                    {f.styleTags.slice(0, 1).map((s) => (
                      <Badge key={s} className="!text-[11px] !py-0.5">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="grid place-items-center py-20 text-center">
          <Sofa className="h-10 w-10 text-subtle mb-4" />
          <p className="font-medium text-lg">No furniture yet</p>
          <p className="text-muted mt-1 max-w-sm">
            Upload 3D models from Settings → Upload 3D Model to start filling
            your marketplace.
          </p>
          <Link href="/settings" className="mt-5">
            <Button>
              <Plus className="h-4 w-4" /> Upload a model
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid place-items-center py-20 text-center">
          <Search className="h-10 w-10 text-subtle mb-4" />
          <p className="font-medium text-lg">No matches found</p>
          <p className="text-muted mt-1">Try a different search or filter.</p>
        </div>
      )}

      {/* Delete confirmation */}
      <AnimatePresence>
        {confirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm grid place-items-center p-5"
            onClick={() => !deleting && setConfirm(null)}
          >
            <motion.div
              initial={{ scale: 0.96, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-3xl bg-surface border border-border shadow-[var(--shadow-lg)] p-6 text-center"
            >
              <div className="grid place-items-center h-14 w-14 rounded-2xl bg-rose-500/10 text-rose-500 mx-auto mb-4">
                <AlertTriangle className="h-7 w-7" />
              </div>
              <h3 className="text-lg font-semibold tracking-tight">Delete this furniture?</h3>
              <p className="text-muted text-sm mt-1.5">
                &ldquo;{confirm.name}&rdquo; will be removed from the marketplace and
                from any rooms it&apos;s placed in. This can&apos;t be undone.
              </p>
              <div className="flex gap-3 mt-6">
                <Button variant="secondary" className="flex-1" onClick={() => setConfirm(null)} disabled={deleting}>
                  Cancel
                </Button>
                <Button
                  className="flex-1 !bg-rose-500 !shadow-none hover:!brightness-110"
                  onClick={doDelete}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : <><Trash2 className="h-4 w-4" /> Delete</>}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Page>
  );
}
