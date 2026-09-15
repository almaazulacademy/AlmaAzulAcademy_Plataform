import Link from "next/link";

import type { PublicBase } from "@/lib/bases/types";
import { cn } from "@/lib/utils";

/**
 * Filtro por base feito de links (`?base=`), sem JavaScript: o link
 * compartilhado já abre filtrado e cada recorte é uma URL indexável.
 */
export function BaseFilter({
  bases,
  selected,
  basePath,
  counts,
}: {
  bases: PublicBase[];
  selected: string | null;
  basePath: string;
  counts?: Record<string, number>;
}) {
  const options = [{ slug: null, label: "Todas" }, ...bases.map((base) => ({ slug: base.slug, label: base.name, comingSoon: base.status !== "ACTIVE" }))];

  return (
    <nav aria-label="Filtrar por base" className="-mx-5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-2">
        {options.map((option) => {
          const active = option.slug === selected;
          const count = option.slug ? counts?.[option.slug] : undefined;
          return (
            <li key={option.slug ?? "todas"}>
              <Link
                href={option.slug ? `${basePath}?base=${option.slug}` : basePath}
                aria-current={active ? "page" : undefined}
                scroll={false}
                className={cn(
                  "inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-full border px-5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lake focus-visible:ring-offset-2",
                  active ? "border-ink bg-ink text-white" : "border-ink/15 bg-white text-ink hover:border-ink/40",
                )}
              >
                {option.label}
                {"comingSoon" in option && option.comingSoon ? (
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]", active ? "bg-white/15 text-white" : "bg-sand/35 text-forest")}>
                    Em breve
                  </span>
                ) : typeof count === "number" ? (
                  <span className={cn("text-xs", active ? "text-white/60" : "text-ink/40")}>{count}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
