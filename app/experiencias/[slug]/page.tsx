import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ComingSoonExperience } from "@/components/bases/coming-soon-experience";
import { ExperienceLanding } from "@/components/experience-landing";
import { getExperiencePlacement } from "@/lib/bases/data";
import { getPublishedExperience } from "@/lib/editorial/data";
import { DATE_FILTER_PARAM, parseDateFilter } from "@/lib/sessions/date-filter";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const experience = await getPublishedExperience(slug);
  if (!experience) {
    const upcoming = await getExperiencePlacement(slug);
    if (upcoming?.experience.status === "COMING_SOON") {
      return {
        title: `${upcoming.experience.title} · Base ${upcoming.base.name} · Em breve`,
        description: upcoming.experience.summary,
        robots: { index: false, follow: true },
      };
    }
    return { title: "Experiência não encontrada", robots: { index: false, follow: false } };
  }
  const seoTitle = experience.editorial.seo.title;
  return {
    title: seoTitle.includes("Alma Azul Academy") ? { absolute: seoTitle } : seoTitle,
    description: experience.editorial.seo.description,
    alternates: { canonical: `/experiencias/${experience.slug}` },
    openGraph: {
      title: seoTitle,
      description: experience.editorial.seo.description,
      images: [experience.editorial.hero.image.src],
      type: "website",
    },
  };
}

export default async function DynamicExperiencePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const experience = await getPublishedExperience(slug);
  // Experiência "em breve" acessada pela URL: explica em vez de 404 e nunca
  // mostra agenda, preço ou botão de reserva.
  if (!experience) {
    const upcoming = await getExperiencePlacement(slug);
    if (upcoming?.experience.status === "COMING_SOON") return <ComingSoonExperience experience={upcoming.experience} base={upcoming.base} />;
  }
  if (!experience) notFound();
  const placement = await getExperiencePlacement(experience.slug);
  // Só a grade de datas usa o filtro; o destaque de turmas continua mostrando
  // todos os horários da experiência.
  const date = parseDateFilter((await searchParams)[DATE_FILTER_PARAM]);
  return (
    <ExperienceLanding
      experience={experience}
      date={date}
      placement={placement ? { base: placement.base, isExclusive: placement.experience.isExclusive } : null}
    />
  );
}
