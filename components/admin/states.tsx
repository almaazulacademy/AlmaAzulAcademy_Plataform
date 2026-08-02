import { CircleAlert, Inbox } from "lucide-react";

export function AdminEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid min-h-64 place-items-center rounded-3xl border border-dashed border-ink/15 bg-white p-8 text-center">
      <div>
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-mist text-forest"><Inbox className="size-5" /></div>
        <h2 className="mt-5 text-lg font-semibold text-ink">{title}</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink/55">{description}</p>
      </div>
    </div>
  );
}

export function AdminErrorState({ title = "Não foi possível carregar os dados.", description = "Confira a configuração do Supabase e tente novamente." }: { title?: string; description?: string }) {
  return (
    <div className="rounded-3xl border border-red-200 bg-red-50 p-6 text-red-900" role="alert">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0" />
        <div><h2 className="font-semibold">{title}</h2><p className="mt-1 text-sm leading-6 text-red-800/75">{description}</p></div>
      </div>
    </div>
  );
}
