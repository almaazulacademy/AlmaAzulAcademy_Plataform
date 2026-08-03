"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { EditorialImage } from "@/components/editorial-image";

export type GalleryImage = {
  src: string;
  alt: string;
  credit?: string;
  className?: string;
};

export function Gallery({ images }: { images: GalleryImage[] }) {
  const [selected, setSelected] = useState<GalleryImage | null>(null);

  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", close);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", close);
      document.body.style.overflow = "";
    };
  }, [selected]);

  return (
    <>
      <div className="grid auto-rows-[230px] grid-cols-2 gap-3 sm:auto-rows-[320px] sm:gap-4 lg:grid-cols-4">
        {images.map((image, index) => (
          <button
            type="button"
            key={image.src}
            onClick={() => setSelected(image)}
            className={cn(
              "group relative overflow-hidden rounded-2xl bg-mist text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lake focus-visible:ring-offset-2 sm:rounded-3xl",
              index === 0 && "col-span-2 row-span-2",
              image.className,
            )}
            aria-label={`Ampliar foto: ${image.alt}`}
          >
            <EditorialImage
              src={image.src}
              alt={image.alt}
              sizes="(min-width: 1024px) 50vw, 100vw"
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
            />
            <span className="absolute inset-0 bg-ink/0 transition-colors group-hover:bg-ink/10" />
          </button>
        ))}
      </div>

      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={selected.alt}
          className="fixed inset-0 z-[100] grid place-items-center bg-ink/95 p-4 sm:p-10"
          onClick={() => setSelected(null)}
        >
          <button
            type="button"
            className="absolute right-5 top-5 z-10 grid size-12 place-items-center rounded-full bg-white text-ink"
            onClick={() => setSelected(null)}
            aria-label="Fechar imagem"
          >
            <X className="size-5" />
          </button>
          {/* Native image keeps the lightbox intrinsic ratio stable across mixed photo orientations. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={selected.src}
            alt={selected.alt}
            className="max-h-[86vh] max-w-[94vw] rounded-2xl object-contain shadow-2xl"
          />
          {selected.credit ? <p className="absolute bottom-5 text-xs text-white/65">{selected.credit}</p> : null}
        </div>
      )}
    </>
  );
}
