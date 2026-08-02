import { Building2, CreditCard, Globe2, Mail, MessageCircle, QrCode } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { requireAdmin } from "@/lib/admin/auth";
import { getPlatformSettings } from "@/lib/admin/data";
import { formatAdminDateTime } from "@/lib/admin/format";

export const metadata = { title: "Configurações" };

export default async function AdminSettingsPage() {
  await requireAdmin();
  try {
    const settings = await getPlatformSettings();
    const items = [
      { label: "Nome da empresa", value: settings.companyName, icon: Building2 },
      { label: "WhatsApp", value: settings.whatsapp ?? "Não configurado", icon: MessageCircle },
      { label: "Email", value: settings.email ?? "Não configurado", icon: Mail },
      { label: "PIX", value: settings.pixKey ?? "Não configurado", icon: QrCode },
      { label: "InfinitePay", value: settings.infinitePayConfigured ? "Configurada no servidor" : "Não configurada", icon: CreditCard },
      { label: "Domínio", value: settings.domain ?? "Não configurado", icon: Globe2 },
    ];

    return (
      <div>
        <AdminPageHeader eyebrow="Plataforma" title="Configurações" description="Consulte os dados operacionais e o estado das integrações. A edição de informações sensíveis ainda não está habilitada." />
        <div className="mt-8 rounded-3xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900">Esta tela é somente leitura. Chaves privadas e credenciais nunca são exibidas no painel.</div>
        <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Configurações da plataforma">
          {items.map((item) => {
            const Icon = item.icon;
            return <article key={item.label} className="rounded-3xl border border-ink/10 bg-white p-6"><div className="grid size-11 place-items-center rounded-2xl bg-mist text-forest"><Icon className="size-5" /></div><p className="mt-6 text-xs font-medium text-ink/45">{item.label}</p><p className="mt-2 break-words text-base font-semibold text-ink">{item.value}</p></article>;
          })}
        </section>
        <p className="mt-6 text-xs text-ink/40">Última atualização dos dados institucionais: {formatAdminDateTime(settings.updatedAt)}.</p>
      </div>
    );
  } catch {
    return <div><AdminPageHeader eyebrow="Plataforma" title="Configurações" description="Consulte o estado operacional da plataforma." /><div className="mt-8"><AdminErrorState description="A tabela de configurações administrativas ainda não está disponível neste ambiente." /></div></div>;
  }
}
