import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ExperienceLanding } from "@/components/experience-landing";
import { requireAdmin } from "@/lib/admin/auth";
import { listAdminExperiences } from "@/lib/admin/data";
import { isUuid } from "@/lib/admin/validation";
import type { PublicExperience } from "@/lib/editorial/experience";
import { validateExperienceEditorial } from "@/lib/editorial/experience";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Preview de experiência", robots: { index: false, follow: false } };

export default async function ExperiencePreviewPage({ params }: { params: Promise<{ experienceId: string }> }) {
  const { experienceId } = await params;
  if (!isUuid(experienceId)) notFound();
  const context = await requireAdmin();
  const item = (await listAdminExperiences(context.profile.userId)).find((experience) => experience.id === experienceId);
  if (!item) notFound();
  const validation = validateExperienceEditorial(item.editorialContent, true);
  if (!validation.success) return <main className="min-h-screen bg-paper px-5 py-24"><div className="mx-auto max-w-2xl rounded-3xl bg-white p-8 shadow-soft"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-lake">Preview indisponível</p><h1 className="mt-4 text-3xl font-semibold">Complete o conteúdo editorial.</h1><ul className="mt-6 space-y-2 text-sm text-ink/65">{validation.errors.map((error) => <li key={error}>• {error}</li>)}</ul></div></main>;
  const experience: PublicExperience = { id: item.id, slug: item.slug, title: item.title, summary: item.summary, imageUrl: item.imageUrl, displayOrder: item.displayOrder, editorial: item.editorialContent };
  return <><div className="fixed inset-x-0 top-0 z-[200] bg-sand px-4 py-2 text-center text-xs font-semibold text-ink">PREVIEW ADMINISTRATIVO · {item.status}</div><ExperienceLanding experience={experience} /></>;
}
