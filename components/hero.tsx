import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { EditorialImage } from "@/components/editorial-image";
import { cn } from "@/lib/utils";

type HeroProps = {
  eyebrow: string;
  title: string;
  description: string;
  image: string;
  imageAlt?: string;
  imageCredit?: string;
  primaryLabel: string;
  primaryHref: string;
  secondaryLabel?: string;
  secondaryHref?: string;
  details?: string[];
  immersive?: boolean;
};

export function Hero({
  eyebrow,
  title,
  description,
  image,
  imageAlt = "",
  imageCredit,
  primaryLabel,
  primaryHref,
  secondaryLabel,
  secondaryHref,
  details,
  immersive = false,
}: HeroProps) {
  return (
    <section
      id="top"
      className={cn(
        "relative isolate flex min-h-[780px] overflow-hidden text-white",
        immersive ? "h-[100svh] min-h-[700px]" : "h-[92svh]",
      )}
    >
      <EditorialImage
        src={image}
        alt={imageAlt}
        priority
        sizes="100vw"
        className="absolute inset-0 h-full w-full animate-drift object-cover"
      />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,28,25,0.82)_0%,rgba(8,28,25,0.45)_50%,rgba(8,28,25,0.12)_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,28,25,0.52)_0%,transparent_45%)]" />

      <div className="container relative z-10 flex flex-1 items-end pb-16 pt-36 sm:pb-20 lg:items-center lg:pb-0 lg:pt-24">
        <div className="max-w-4xl animate-fade-up">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
            {eyebrow}
          </p>
          <h1 className="max-w-4xl text-balance text-[clamp(3.6rem,8vw,7.8rem)] font-medium leading-[0.88] tracking-[-0.065em]">
            {title}
          </h1>
          <p className="mt-7 max-w-xl text-balance text-lg leading-8 text-white/78 sm:text-xl">
            {description}
          </p>

          {details && (
            <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/70">
              {details.map((detail) => (
                <span key={detail} className="after:ml-6 after:text-white/30 after:content-['·'] last:after:hidden">
                  {detail}
                </span>
              ))}
            </div>
          )}

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link href={primaryHref} className={buttonVariants({ variant: "light", size: "lg" })}>
              {primaryLabel}
              <ArrowRight className="size-4" />
            </Link>
            {secondaryLabel && secondaryHref && (
              <Link
                href={secondaryHref}
                className="inline-flex h-14 items-center justify-center gap-2 rounded-full border border-white/35 px-7 text-base font-semibold text-white transition-colors hover:bg-white/10"
              >
                {secondaryLabel}
              </Link>
            )}
          </div>
        </div>
      </div>

      <Link
        href="#conteudo"
        aria-label="Ir para o conteúdo"
        className="absolute bottom-8 right-5 z-10 hidden size-12 place-items-center rounded-full border border-white/30 text-white transition-colors hover:bg-white/10 sm:grid lg:right-10"
      >
        <ArrowDown className="size-4" />
      </Link>
      {imageCredit ? <p className="absolute bottom-3 left-5 z-10 text-xs text-white/55">{imageCredit}</p> : null}
    </section>
  );
}
