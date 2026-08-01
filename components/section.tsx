import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type SectionProps = {
  id?: string;
  eyebrow?: string;
  title?: string;
  description?: string;
  align?: "left" | "center";
  tone?: "paper" | "white" | "mist" | "ink";
  className?: string;
  children: ReactNode;
};

const tones = {
  paper: "bg-paper text-ink",
  white: "bg-white text-ink",
  mist: "bg-mist text-ink",
  ink: "bg-ink text-white",
};

export function Section({
  id,
  eyebrow,
  title,
  description,
  align = "left",
  tone = "paper",
  className,
  children,
}: SectionProps) {
  return (
    <section id={id} className={cn("scroll-mt-20 py-20 sm:py-28 lg:py-36", tones[tone], className)}>
      <div className="container">
        {(eyebrow || title || description) && (
          <div
            className={cn(
              "mb-12 max-w-3xl sm:mb-16",
              align === "center" && "mx-auto text-center",
            )}
          >
            {eyebrow && (
              <p
                className={cn(
                  "mb-5 text-xs font-semibold uppercase tracking-[0.2em]",
                  tone === "ink" ? "text-white/55" : "text-lake",
                )}
              >
                {eyebrow}
              </p>
            )}
            {title && (
              <h2 className="text-balance text-4xl font-medium leading-[1.03] tracking-[-0.045em] sm:text-5xl lg:text-6xl">
                {title}
              </h2>
            )}
            {description && (
              <p
                className={cn(
                  "mt-6 max-w-2xl text-lg leading-8",
                  align === "center" && "mx-auto",
                  tone === "ink" ? "text-white/65" : "text-ink/65",
                )}
              >
                {description}
              </p>
            )}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
