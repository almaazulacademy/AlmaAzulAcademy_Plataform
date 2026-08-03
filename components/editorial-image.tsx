"use client";

import Image from "next/image";
import { Waves } from "lucide-react";
import { useState } from "react";

type Props = {
  src: string | null;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
};

export function EditorialImage({ src, alt, className, sizes = "100vw", priority = false }: Props) {
  const supported = Boolean(src && (src.startsWith("/images/") || /^https:\/\//i.test(src)));
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = !supported || failedSource === src;
  const imageClassName = `${className ?? ""} text-transparent`;

  return (
    <>
      <div
        aria-hidden={!failed}
        aria-label={failed ? alt : undefined}
        role={failed ? "img" : undefined}
        className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_30%_20%,rgba(110,173,160,0.42),transparent_38%),linear-gradient(145deg,#1d4b43_0%,#102f2a_100%)]"
      >
        <Waves className="size-16 text-white/15" />
      </div>
      {!failed && src ? (
        /^https:\/\//i.test(src) ? (
          // HTTPS editorial URLs are validated server-side. Native img avoids widening next/image hosts globally.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={alt} className={imageClassName} loading={priority ? "eager" : "lazy"} onError={() => setFailedSource(src)} />
        ) : (
          <Image src={src} alt={alt} fill priority={priority} sizes={sizes} className={imageClassName} onError={() => setFailedSource(src)} />
        )
      ) : null}
    </>
  );
}
