import { Gallery } from "@/components/gallery";
import { cn } from "@/lib/utils";
import { isLocalBaseMedia, TEMPORARY_MEDIA_LABEL, type BaseMediaItem } from "@/lib/bases/media";

/** Selo discreto sobre fotos temporárias (acervo de outra base usado provisoriamente). */
export function TemporaryMediaLabel({ position = "bottom" }: { position?: "top" | "bottom" }) {
  return (
    <span className={cn("pointer-events-none absolute right-3 z-10 max-w-[calc(100%-1.5rem)] rounded-full bg-ink/55 px-2.5 py-1 text-[11px] font-medium leading-tight text-white/85 backdrop-blur-sm", position === "top" ? "top-4 sm:top-6" : "bottom-3")}>
      {TEMPORARY_MEDIA_LABEL}
    </span>
  );
}

/**
 * Galeria do espaço de uma base: fotos pela Gallery existente e vídeos com o
 * player nativo. Só aceita mídia local do acervo; qualquer outra origem é ignorada.
 */
export function BaseSpaceMedia({ items }: { items: BaseMediaItem[] }) {
  const local = items.filter((item) => isLocalBaseMedia(item.src));
  const images = local.filter((item) => item.kind === "image").map((item) => ({ src: item.src, alt: item.alt }));
  const videos = local.filter((item): item is Extract<BaseMediaItem, { kind: "video" }> => item.kind === "video");
  return (
    <div className="space-y-5">
      {videos.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {videos.map((video) => (
            <video
              key={video.src}
              src={video.src}
              poster={video.poster && isLocalBaseMedia(video.poster) ? video.poster : undefined}
              aria-label={video.alt}
              controls
              playsInline
              preload="metadata"
              className="aspect-video w-full max-w-full rounded-3xl bg-ink object-cover"
            />
          ))}
        </div>
      ) : null}
      {images.length ? <Gallery images={images} /> : null}
    </div>
  );
}
