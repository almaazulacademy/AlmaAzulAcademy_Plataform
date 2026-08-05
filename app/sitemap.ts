import type { MetadataRoute } from "next";

import { listPublishedExperiences } from "@/lib/editorial/data";
import { absoluteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * Sitemap público. Só entram páginas indexáveis.
 * Ficam de fora: /admin, /login, /preview, /api, /pagamento/retorno e /reservar/[sessionId].
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), lastModified, changeFrequency: "weekly", priority: 1 },
    { url: absoluteUrl("/agenda"), lastModified, changeFrequency: "daily", priority: 0.9 },
    { url: absoluteUrl("/acompanhar-reserva"), lastModified, changeFrequency: "monthly", priority: 0.3 },
  ];

  let experienceRoutes: MetadataRoute.Sitemap = [];
  try {
    const experiences = await listPublishedExperiences();
    experienceRoutes = experiences.map((experience) => ({
      url: absoluteUrl(`/experiencias/${experience.slug}`),
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }));
  } catch (error) {
    console.error("Erro ao montar o sitemap:", error instanceof Error ? error.message : "erro desconhecido");
  }

  return [...staticRoutes, ...experienceRoutes];
}
