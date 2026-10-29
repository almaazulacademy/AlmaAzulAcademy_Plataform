import type { MetadataRoute } from "next";

import { listPublicBases } from "@/lib/bases/data";
import { listPublishedExperiences } from "@/lib/editorial/data";
import { listPublicEvents } from "@/lib/events/data";
import { isEventsPublicEnabled } from "@/lib/events/flags";
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
    { url: absoluteUrl("/experiencias"), lastModified, changeFrequency: "weekly", priority: 0.9 },
    { url: absoluteUrl("/bases"), lastModified, changeFrequency: "weekly", priority: 0.8 },
    { url: absoluteUrl("/quem-somos"), lastModified, changeFrequency: "monthly", priority: 0.6 },
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

  let baseRoutes: MetadataRoute.Sitemap = [];
  try {
    const bases = await listPublicBases();
    baseRoutes = bases.map((base) => ({
      url: absoluteUrl(`/bases/${base.slug}`),
      lastModified,
      changeFrequency: "weekly" as const,
      priority: base.status === "ACTIVE" ? 0.8 : 0.6,
    }));
  } catch (error) {
    console.error("Erro ao montar as bases do sitemap:", error instanceof Error ? error.message : "erro desconhecido");
  }

  // Eventos especiais: só com a seção ligada. A prévia de demonstração nunca entra.
  let eventRoutes: MetadataRoute.Sitemap = [];
  if (isEventsPublicEnabled()) {
    const events = await listPublicEvents();
    eventRoutes = [
      { url: absoluteUrl("/eventos"), lastModified, changeFrequency: "weekly" as const, priority: 0.8 },
      ...events.map((event) => ({ url: absoluteUrl(`/eventos/${event.slug}`), lastModified, changeFrequency: "weekly" as const, priority: 0.8 })),
    ];
  }

  return [...staticRoutes, ...baseRoutes, ...experienceRoutes, ...eventRoutes];
}
