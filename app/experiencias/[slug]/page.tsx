import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ExperienceLanding } from "@/components/experience-landing";
import { getPublishedExperience } from "@/lib/editorial/data";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const experience = await getPublishedExperience(slug);
  if (!experience) return { title: "Experiência não encontrada", robots: { index: false, follow: false } };
  return {
    title: experience.editorial.seo.title,
    description: experience.editorial.seo.description,
    openGraph: {
      title: experience.editorial.seo.title,
      description: experience.editorial.seo.description,
      images: [experience.editorial.hero.image.src],
      type: "website",
    },
  };
}

export default async function DynamicExperiencePage({ params }: Props) {
  const { slug } = await params;
  const experience = await getPublishedExperience(slug);
  if (!experience) notFound();
  return <ExperienceLanding experience={experience} />;
}
