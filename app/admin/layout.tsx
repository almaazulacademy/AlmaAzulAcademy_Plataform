import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";
import { requireAdmin } from "@/lib/admin/auth";

export const metadata: Metadata = {
  title: { default: "Painel", template: "%s | Painel Alma Azul" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const context = await requireAdmin();
  return <AdminShell profile={context.profile}>{children}</AdminShell>;
}
