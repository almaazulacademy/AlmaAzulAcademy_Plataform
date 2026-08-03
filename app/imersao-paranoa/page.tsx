import type { Metadata } from "next";

import { ExperienceLanding } from "@/components/experience-landing";
import { getPublishedExperience } from "@/lib/editorial/data";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const experience = await getPublishedExperience("imersao-paranoa", true);
  return {
    title: experience?.editorial.seo.title ?? "Imersão Paranoá",
    description: experience?.editorial.seo.description,
    openGraph: experience ? { title: experience.editorial.seo.title, description: experience.editorial.seo.description, images: [experience.editorial.hero.image.src] } : undefined,
  };
}

export default async function ImersaoParanoaPage() {
  const experience = await getPublishedExperience("imersao-paranoa", true);
  return <ExperienceLanding experience={experience!} />;
}
