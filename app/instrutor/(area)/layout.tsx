import type { Metadata } from "next";
import type { ReactNode } from "react";

import { InstructorShell } from "@/components/instructor/instructor-shell";
import { requireCheckinStaff } from "@/lib/admin/auth";

export const metadata: Metadata = {
  title: { default: "Lista de Presença", template: "%s | Alma Azul" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function InstructorLayout({ children }: { children: ReactNode }) {
  const context = await requireCheckinStaff();
  return <InstructorShell profile={context.profile}>{children}</InstructorShell>;
}
