import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import type { Experience } from "@/lib/experiences";
import { cn } from "@/lib/utils";

export function ExperienceCard({ experience, featured = false }: { experience: Experience; featured?: boolean }) {
  return (
    <Link
      href={experience.href}
      className={cn(
        "group relative isolate flex min-h-[500px] overflow-hidden rounded-4xl bg-ink text-white shadow-soft",
        featured && "min-h-[600px] lg:min-h-[680px]",
      )}
    >
      <Image
        src={experience.image}
        alt={experience.title}
        fill
        sizes={featured ? "(min-width: 1024px) 90vw, 100vw" : "(min-width: 768px) 50vw, 100vw"}
        className="object-cover transition-transform duration-700 ease-out group-hover:scale-[1.035]"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink/90 via-ink/20 to-transparent" />
      <div className="relative mt-auto flex w-full items-end justify-between gap-6 p-7 sm:p-9 lg:p-11">
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-white/65">
            {experience.eyebrow}
          </p>
          <h3 className={cn("text-4xl font-medium tracking-[-0.045em]", featured && "sm:text-6xl")}>{experience.title}</h3>
          <p className="mt-4 max-w-xl text-base leading-7 text-white/72 sm:text-lg">{experience.summary}</p>
          <p className="mt-5 text-sm text-white/55">{experience.location}</p>
        </div>
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-white text-ink transition-transform duration-300 group-hover:-translate-y-1 group-hover:translate-x-1 sm:size-14">
          <ArrowUpRight className="size-5" />
        </span>
      </div>
    </Link>
  );
}
