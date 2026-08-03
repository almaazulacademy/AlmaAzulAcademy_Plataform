"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Eye, EyeOff, ImageIcon, Pencil, Plus, Save, X } from "lucide-react";

import { fieldErrorClass, inputClass, labelClass, textareaClass } from "@/components/admin/form-styles";
import { AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { AdminEmptyState } from "@/components/admin/states";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";
import type { AdminExperience, ExperienceStatus } from "@/lib/admin/types";

type FormState = {
  title: string;
  summary: string;
  description: string;
  durationMinutes: string;
  price: string;
  defaultCapacity: string;
  imageUrl: string;
  displayOrder: string;
  status: ExperienceStatus;
};

type ApiPayload = { message?: string; errors?: Record<string, string> };

const emptyForm: FormState = { title: "", summary: "", description: "", durationMinutes: "90", price: "", defaultCapacity: "15", imageUrl: "", displayOrder: "0", status: "DRAFT" };

function fromExperience(experience: AdminExperience): FormState {
  return {
    title: experience.title,
    summary: experience.summary,
    description: experience.description,
    durationMinutes: String(experience.durationMinutes),
    price: (experience.priceCents / 100).toFixed(2),
    defaultCapacity: String(experience.defaultCapacity),
    imageUrl: experience.imageUrl ?? "",
    displayOrder: String(experience.displayOrder),
    status: experience.status,
  };
}

export function ExperiencesManager({ experiences }: { experiences: AdminExperience[] }) {
  const router = useRouter();
  const { notify } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const openNew = () => {
    setEditingId(null);
    setForm({ ...emptyForm, displayOrder: String(experiences.length) });
    setErrors({});
    setFormOpen(true);
  };

  const openEdit = (experience: AdminExperience) => {
    setEditingId(experience.id);
    setForm(fromExperience(experience));
    setErrors({});
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const apiInput = (state: FormState, status = state.status) => ({
    title: state.title,
    summary: state.summary,
    description: state.description,
    durationMinutes: Number(state.durationMinutes),
    priceCents: Math.round(Number(state.price.replace(",", ".")) * 100),
    defaultCapacity: Number(state.defaultCapacity),
    imageUrl: state.imageUrl,
    displayOrder: Number(state.displayOrder),
    status,
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrors({});
    const url = editingId ? `/api/admin/experiences/${editingId}` : "/api/admin/experiences";
    try {
      const response = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(apiInput(form)),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok) {
        setErrors(payload.errors ?? { form: payload.message ?? "Não foi possível salvar a experiência." });
        throw new Error(payload.message ?? "Revise os campos informados.");
      }
      notify({ title: editingId ? "Experiência atualizada" : "Experiência criada", description: "O cadastro transacional foi salvo." });
      setFormOpen(false);
      setEditingId(null);
      router.refresh();
    } catch (error) {
      notify({ title: "Experiência não salva", description: error instanceof Error ? error.message : "Tente novamente.", variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  const toggleStatus = async (experience: AdminExperience) => {
    const status: ExperienceStatus = experience.status === "PUBLISHED" ? "ARCHIVED" : "PUBLISHED";
    try {
      const response = await fetch(`/api/admin/experiences/${experience.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(apiInput(fromExperience(experience), status)),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok) throw new Error(payload.message ?? "Não foi possível alterar o status.");
      notify({ title: status === "PUBLISHED" ? "Experiência ativada" : "Experiência desativada" });
      router.refresh();
    } catch (error) {
      notify({ title: "Status não alterado", description: error instanceof Error ? error.message : "Tente novamente.", variant: "error" });
    }
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Catálogo"
        title="Experiências"
        description="Gerencie o cadastro comum usado por sessões e reservas. A landing pública continua separada deste painel."
        action={<Button type="button" onClick={openNew}><Plus className="size-4" /> Nova experiência</Button>}
      />

      {formOpen ? (
        <section className="mt-8 rounded-3xl border border-lake/20 bg-white p-5 shadow-sm sm:p-7" aria-labelledby="experience-form-title">
          <div className="flex items-center justify-between gap-4">
            <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-lake">Cadastro</p><h2 id="experience-form-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{editingId ? "Editar experiência" : "Nova experiência"}</h2></div>
            <button type="button" onClick={() => setFormOpen(false)} disabled={loading} className="grid size-10 place-items-center rounded-full text-ink/50 hover:bg-ink/5" aria-label="Fechar formulário"><X className="size-5" /></button>
          </div>
          <form className="mt-7 grid gap-5 md:grid-cols-2" onSubmit={submit} noValidate>
            <label className="block"><span className={labelClass}>Nome</span><input className={inputClass} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={120} disabled={loading} placeholder="Remada Sunset" />{errors.title ? <span className={fieldErrorClass}>{errors.title}</span> : null}</label>
            <label className="block"><span className={labelClass}>Imagem oficial</span><input className={inputClass} value={form.imageUrl} onChange={(event) => setForm({ ...form, imageUrl: event.target.value })} maxLength={500} disabled={loading} placeholder="/images/experiences/..." />{errors.imageUrl ? <span className={fieldErrorClass}>{errors.imageUrl}</span> : null}</label>
            <label className="block md:col-span-2"><span className={labelClass}>Descrição curta</span><textarea className={textareaClass} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} maxLength={300} disabled={loading} />{errors.summary ? <span className={fieldErrorClass}>{errors.summary}</span> : null}</label>
            <label className="block md:col-span-2"><span className={labelClass}>Descrição completa</span><textarea className={textareaClass} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={5000} rows={6} disabled={loading} />{errors.description ? <span className={fieldErrorClass}>{errors.description}</span> : null}</label>
            <label className="block"><span className={labelClass}>Duração padrão (min)</span><input type="number" min="15" max="1440" className={inputClass} value={form.durationMinutes} onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })} disabled={loading} />{errors.durationMinutes ? <span className={fieldErrorClass}>{errors.durationMinutes}</span> : null}</label>
            <label className="block"><span className={labelClass}>Preço padrão (R$)</span><input type="number" min="0" step="0.01" className={inputClass} value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} disabled={loading} />{errors.priceCents ? <span className={fieldErrorClass}>{errors.priceCents}</span> : null}</label>
            <label className="block"><span className={labelClass}>Capacidade padrão</span><input type="number" min="1" max="500" className={inputClass} value={form.defaultCapacity} onChange={(event) => setForm({ ...form, defaultCapacity: event.target.value })} disabled={loading} />{errors.defaultCapacity ? <span className={fieldErrorClass}>{errors.defaultCapacity}</span> : null}</label>
            <label className="block"><span className={labelClass}>Ordem de exibição</span><input type="number" min="0" max="10000" className={inputClass} value={form.displayOrder} onChange={(event) => setForm({ ...form, displayOrder: event.target.value })} disabled={loading} />{errors.displayOrder ? <span className={fieldErrorClass}>{errors.displayOrder}</span> : null}</label>
            <label className="block"><span className={labelClass}>Status</span><select className={inputClass} value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as ExperienceStatus })} disabled={loading}><option value="DRAFT">Rascunho</option><option value="PUBLISHED">Ativa</option><option value="ARCHIVED">Inativa</option></select>{errors.status ? <span className={fieldErrorClass}>{errors.status}</span> : null}</label>
            {errors.form ? <p className="md:col-span-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{errors.form}</p> : null}
            <div className="flex flex-col-reverse gap-3 md:col-span-2 md:flex-row md:justify-end"><Button type="button" variant="ghost" onClick={() => setFormOpen(false)} disabled={loading}>Cancelar</Button><Button type="submit" disabled={loading}><Save className="size-4" /> {loading ? "Salvando..." : "Salvar experiência"}</Button></div>
          </form>
        </section>
      ) : null}

      <section className="mt-8 grid gap-4 lg:grid-cols-2" aria-label="Lista de experiências">
        {experiences.length === 0 ? <div className="lg:col-span-2"><AdminEmptyState title="Nenhuma experiência cadastrada" description="Crie o primeiro cadastro para associar sessões e reservas." action={<Button type="button" size="sm" onClick={openNew}><Plus className="size-4" /> Criar experiência</Button>} /></div> : experiences.map((experience) => (
          <article key={experience.id} className="rounded-3xl border border-ink/10 bg-white p-6">
            <div className="flex items-start justify-between gap-4"><div className="grid size-11 place-items-center rounded-2xl bg-mist text-forest"><ImageIcon className="size-5" /></div><StatusBadge status={experience.status} /></div>
            <h2 className="mt-6 text-xl font-semibold tracking-[-0.025em]">{experience.title}</h2>
            <p className="mt-2 text-xs font-medium text-lake">/{experience.slug}</p>
            <p className="mt-4 min-h-12 text-sm leading-6 text-ink/55">{experience.summary}</p>
            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-ink/10 pt-4 text-xs text-ink/50"><span>Ordem {experience.displayOrder}</span><span>{experience.sessionsCount} sessões</span><span>{experience.durationMinutes} min</span><span>{experience.defaultCapacity} vagas</span><span>{experience.imageUrl ? "Imagem definida" : "Sem imagem"}</span></div>
            <div className="mt-5 flex flex-wrap gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => openEdit(experience)}><Pencil className="size-4" /> Editar</Button><Button type="button" size="sm" variant="ghost" onClick={() => toggleStatus(experience)}>{experience.status === "PUBLISHED" ? <EyeOff className="size-4" /> : <Eye className="size-4" />}{experience.status === "PUBLISHED" ? "Desativar" : "Ativar"}</Button></div>
          </article>
        ))}
      </section>
    </div>
  );
}
