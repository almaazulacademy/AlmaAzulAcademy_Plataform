"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, CalendarPlus, Copy, Lock, Pencil, Plus, Trash2, Unlock, X } from "lucide-react";

import { ConfirmationDialog } from "@/components/admin/confirmation-dialog";
import { fieldErrorClass, inputClass, labelClass, textareaClass } from "@/components/admin/form-styles";
import { AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { AdminEmptyState } from "@/components/admin/states";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AdminExperience, AdminSession, SessionFilter, SessionStatus } from "@/lib/admin/types";
import { formatCurrency } from "@/lib/admin/format";
import { formatSessionDateTime, sessionLocalToIso, toSessionDateTimeLocal } from "@/lib/sessions/date-time";

const FILTER_TABS: Array<{ value: SessionFilter; param: string; label: string }> = [
  { value: "ACTIVE", param: "ativas", label: "Ativas" },
  { value: "ARCHIVED", param: "arquivadas", label: "Arquivadas" },
  { value: "ALL", param: "todas", label: "Todas" },
];

type FormState = {
  experienceId: string;
  startsAt: string;
  durationMinutes: string;
  price: string;
  capacity: string;
  status: SessionStatus;
  internalNotes: string;
};

type ApiPayload = { message?: string; errors?: Record<string, string> };

const emptyForm = (experienceId = ""): FormState => ({
  experienceId,
  startsAt: "",
  durationMinutes: "90",
  price: "",
  capacity: "",
  status: "OPEN",
  internalNotes: "",
});

function fromSession(session: AdminSession): FormState {
  return {
    experienceId: session.experienceId,
    startsAt: toSessionDateTimeLocal(session.startsAt),
    durationMinutes: String(session.durationMinutes),
    price: (session.priceCents / 100).toFixed(2),
    capacity: String(session.capacity),
    // ARCHIVED não é uma opção do formulário: arquivar e restaurar têm
    // ações e regras próprias, então uma sessão arquivada duplicada nasce
    // como Aberta.
    status: session.status === "ARCHIVED" ? "OPEN" : session.status,
    internalNotes: session.internalNotes ?? "",
  };
}

export function SessionsManager({ sessions, experiences, initiallyOpen, filter }: {
  sessions: AdminSession[];
  experiences: AdminExperience[];
  initiallyOpen: boolean;
  filter: SessionFilter;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [formOpen, setFormOpen] = useState(initiallyOpen);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState("Nova sessão");
  const [form, setForm] = useState<FormState>(() => emptyForm(experiences[0]?.id));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<AdminSession | null>(null);
  const [restoring, setRestoring] = useState<AdminSession | null>(null);

  const openNew = () => {
    setEditingId(null);
    setFormTitle("Nova sessão");
    setForm(emptyForm(experiences[0]?.id));
    setErrors({});
    setFormOpen(true);
  };

  const openEdit = (session: AdminSession) => {
    setEditingId(session.id);
    setFormTitle("Editar sessão");
    setForm(fromSession(session));
    setErrors({});
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openDuplicate = (session: AdminSession) => {
    setEditingId(null);
    setFormTitle("Duplicar sessão");
    setForm(fromSession(session));
    setErrors({ startsAt: "Confirme ou altere a data da nova sessão." });
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const payloadFrom = (state: FormState, status = state.status) => ({
    experienceId: state.experienceId,
    startsAt: sessionLocalToIso(state.startsAt),
    durationMinutes: Number(state.durationMinutes),
    priceCents: Math.round(Number(state.price.replace(",", ".")) * 100),
    capacity: Number(state.capacity),
    status,
    internalNotes: state.internalNotes,
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrors({});
    const url = editingId ? `/api/admin/sessions/${editingId}` : "/api/admin/sessions";
    try {
      const response = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payloadFrom(form)),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok) {
        setErrors(payload.errors ?? { form: payload.message ?? "Não foi possível salvar a sessão." });
        throw new Error(payload.message ?? "Revise os campos informados.");
      }
      notify({ title: editingId ? "Sessão atualizada" : "Sessão criada", description: "A agenda administrativa foi atualizada." });
      setFormOpen(false);
      setEditingId(null);
      router.replace("/admin/sessoes");
      router.refresh();
    } catch (error) {
      notify({ title: "Sessão não salva", description: error instanceof Error ? error.message : "Tente novamente.", variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  const changeStatus = async (session: AdminSession, status: SessionStatus) => {
    try {
      const response = await fetch(`/api/admin/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payloadFrom(fromSession(session), status)),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok) throw new Error(payload.message ?? "Não foi possível alterar o status.");
      notify({ title: status === "OPEN" ? "Reservas abertas" : "Reservas fechadas" });
      router.refresh();
    } catch (error) {
      notify({ title: "Status não alterado", description: error instanceof Error ? error.message : "Tente novamente.", variant: "error" });
    }
  };

  const willArchive = Boolean(deleting && deleting.reservationsCount > 0);

  const confirmDelete = async () => {
    if (!deleting) return;
    const archiving = deleting.reservationsCount > 0;
    const response = await fetch(`/api/admin/sessions/${deleting.id}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({})) as ApiPayload;
    if (!response.ok) throw new Error(payload.message ?? (archiving ? "Não foi possível arquivar a sessão." : "Não foi possível excluir a sessão."));
    notify(
      archiving
        ? { title: "Sessão arquivada", description: "Ela saiu das agendas e páginas públicas. O histórico de reservas e pagamentos foi preservado." }
        : { title: "Sessão excluída", description: "A sessão sem histórico foi removida." },
    );
    setDeleting(null);
    router.refresh();
  };

  const confirmRestore = async () => {
    if (!restoring) return;
    const response = await fetch(`/api/admin/sessions/${restoring.id}/restore`, { method: "POST" });
    const payload = await response.json().catch(() => ({})) as ApiPayload;
    if (!response.ok) throw new Error(payload.message ?? "Não foi possível restaurar a sessão.");
    notify({ title: "Sessão restaurada", description: "Ela voltou a aparecer nas agendas e páginas públicas." });
    setRestoring(null);
    router.refresh();
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Operação"
        title="Sessões"
        description="Crie e organize datas para qualquer experiência da Alma Azul. Horários são exibidos no fuso de Brasília."
        action={<Button type="button" onClick={openNew}><Plus className="size-4" /> Nova sessão</Button>}
      />

      <nav className="mt-6 flex flex-wrap gap-2" aria-label="Filtro de sessões">
        {FILTER_TABS.map((tab) => (
          <Link
            key={tab.value}
            href={`/admin/sessoes?filtro=${tab.param}`}
            className={cn(
              "rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              filter === tab.value ? "bg-ink text-white" : "bg-ink/5 text-ink/60 hover:bg-ink/10",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {formOpen ? (
        <section className="mt-8 rounded-3xl border border-lake/20 bg-white p-5 shadow-sm sm:p-7" aria-labelledby="session-form-title">
          <div className="flex items-center justify-between gap-4">
            <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-lake">Agenda</p><h2 id="session-form-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{formTitle}</h2></div>
            <button type="button" onClick={() => setFormOpen(false)} disabled={loading} className="grid size-10 place-items-center rounded-full text-ink/50 hover:bg-ink/5" aria-label="Fechar formulário"><X className="size-5" /></button>
          </div>
          <form className="mt-7 grid gap-5 md:grid-cols-2 xl:grid-cols-4" onSubmit={submit} noValidate>
            <label className="block md:col-span-2">
              <span className={labelClass}>Experiência</span>
              <select className={inputClass} value={form.experienceId} onChange={(event) => setForm({ ...form, experienceId: event.target.value })} disabled={loading}>
                <option value="">Selecione</option>
                {experiences.map((experience) => <option key={experience.id} value={experience.id}>{experience.title}</option>)}
              </select>
              {errors.experienceId ? <span className={fieldErrorClass}>{errors.experienceId}</span> : null}
            </label>
            <label className="block md:col-span-2">
              <span className={labelClass}>Data e horário</span>
              <input type="datetime-local" className={inputClass} value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} disabled={loading} />
              {errors.startsAt ? <span className={fieldErrorClass}>{errors.startsAt}</span> : null}
            </label>
            <label className="block"><span className={labelClass}>Duração (min)</span><input type="number" min="15" max="1440" className={inputClass} value={form.durationMinutes} onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })} disabled={loading} />{errors.durationMinutes ? <span className={fieldErrorClass}>{errors.durationMinutes}</span> : null}</label>
            <label className="block"><span className={labelClass}>Capacidade</span><input type="number" min="1" max="500" className={inputClass} value={form.capacity} onChange={(event) => setForm({ ...form, capacity: event.target.value })} disabled={loading} />{errors.capacity ? <span className={fieldErrorClass}>{errors.capacity}</span> : null}</label>
            <label className="block"><span className={labelClass}>Preço (R$)</span><input type="number" min="0" step="0.01" className={inputClass} value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} disabled={loading} />{errors.priceCents ? <span className={fieldErrorClass}>{errors.priceCents}</span> : null}</label>
            <label className="block"><span className={labelClass}>Status</span><select className={inputClass} value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as SessionStatus })} disabled={loading}><option value="OPEN">Aberta</option><option value="CLOSED">Fechada</option><option value="CANCELLED">Cancelada</option></select>{errors.status ? <span className={fieldErrorClass}>{errors.status}</span> : null}</label>
            <label className="block md:col-span-2 xl:col-span-4"><span className={labelClass}>Observações internas</span><textarea className={textareaClass} value={form.internalNotes} onChange={(event) => setForm({ ...form, internalNotes: event.target.value })} maxLength={1000} disabled={loading} placeholder="Informações operacionais que não aparecem no site." />{errors.internalNotes ? <span className={fieldErrorClass}>{errors.internalNotes}</span> : null}</label>
            {errors.form ? <p className="md:col-span-2 xl:col-span-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{errors.form}</p> : null}
            <div className="flex flex-col-reverse gap-3 md:col-span-2 md:flex-row md:justify-end xl:col-span-4"><Button type="button" variant="ghost" onClick={() => setFormOpen(false)} disabled={loading}>Cancelar</Button><Button type="submit" disabled={loading || experiences.length === 0}><CalendarPlus className="size-4" /> {loading ? "Salvando..." : "Salvar sessão"}</Button></div>
          </form>
        </section>
      ) : null}

      <section className="mt-8 space-y-4" aria-label="Lista de sessões">
        {sessions.length === 0 ? (
          filter === "ARCHIVED" ? (
            <AdminEmptyState title="Nenhuma sessão arquivada" description="Sessões com histórico de reservas aparecem aqui quando são arquivadas." />
          ) : (
            <AdminEmptyState title="Nenhuma sessão cadastrada" description="Crie a primeira data para começar a organizar a agenda." action={<Button type="button" size="sm" onClick={openNew}><Plus className="size-4" /> Criar sessão</Button>} />
          )
        ) : sessions.map((session) => {
          const occupied = session.capacity - session.remainingSpots;
          const occupancy = session.capacity ? Math.round((occupied / session.capacity) * 100) : 0;
          return (
          <article key={session.id} className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><StatusBadge status={session.status} /><span className="text-xs font-medium text-ink/40">{session.reservationsCount} reservas</span></div>
                <h2 className="mt-3 text-lg font-semibold text-ink">{session.experienceTitle}</h2>
                <p className="mt-1 text-sm text-ink/55">{formatSessionDateTime(session.startsAt)}</p>
              </div>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4 xl:min-w-[430px]">
                <div><dt className="text-xs text-ink/45">Preço</dt><dd className="mt-1 text-sm font-semibold">{formatCurrency(session.priceCents)}</dd></div>
                <div><dt className="text-xs text-ink/45">Capacidade</dt><dd className="mt-1 text-sm font-semibold">{session.capacity}</dd></div>
                <div><dt className="text-xs text-ink/45">Vagas</dt><dd className="mt-1 text-sm font-semibold">{session.remainingSpots}</dd></div>
                <div><dt className="text-xs text-ink/45">Duração</dt><dd className="mt-1 text-sm font-semibold">{session.durationMinutes} min</dd></div>
              </dl>
              <div className="flex flex-wrap gap-2 xl:justify-end">
                {session.status === "ARCHIVED" ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => openDuplicate(session)}><Copy className="size-4" /> Duplicar</Button>
                ) : (
                  <>
                    <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(session)}><Pencil className="size-4" /> Editar</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => openDuplicate(session)}><Copy className="size-4" /> Duplicar</Button>
                    {session.status === "OPEN" ? <Button type="button" size="sm" variant="ghost" onClick={() => changeStatus(session, "CLOSED")}><Lock className="size-4" /> Fechar</Button> : <Button type="button" size="sm" variant="ghost" onClick={() => changeStatus(session, "OPEN")}><Unlock className="size-4" /> Abrir</Button>}
                  </>
                )}
                {session.status === "ARCHIVED" ? (
                  <Button type="button" size="sm" variant="ghost" className="text-forest hover:bg-forest/10" onClick={() => setRestoring(session)}><ArchiveRestore className="size-4" /> Restaurar</Button>
                ) : session.reservationsCount > 0 ? (
                  <Button type="button" size="sm" variant="ghost" className="text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => setDeleting(session)}><Archive className="size-4" /> Arquivar</Button>
                ) : (
                  <Button type="button" size="sm" variant="ghost" className="text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => setDeleting(session)}><Trash2 className="size-4" /> Excluir</Button>
                )}
              </div>
            </div>
            <div className="mt-5 border-t border-ink/10 pt-5">
              <div className="flex items-center justify-between gap-4"><h3 className="text-sm font-semibold">Participantes</h3><span className="text-xs font-medium text-ink/45">{occupied}/{session.capacity} vagas · {occupancy}% ocupada</span></div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-mist"><div className="h-full rounded-full bg-lake" style={{ width: `${Math.min(100, occupancy)}%` }} /></div>
              {session.participants.length ? <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{session.participants.map((participant) => <li key={participant.id} className="flex items-center justify-between gap-3 rounded-2xl bg-paper px-4 py-3 text-sm"><span className="min-w-0 truncate font-medium">{participant.name} <span className="text-ink/40">· {participant.quantity}</span></span><StatusBadge status={participant.status} /></li>)}</ul> : <p className="mt-4 text-sm text-ink/45">Nenhum participante nesta sessão.</p>}
            </div>
            {session.internalNotes ? <p className="mt-4 border-t border-ink/10 pt-4 text-sm leading-6 text-ink/55"><span className="font-semibold text-ink/70">Nota interna:</span> {session.internalNotes}</p> : null}
          </article>
        );})}
      </section>

      <ConfirmationDialog
        open={Boolean(deleting)}
        title={willArchive ? "Arquivar esta sessão?" : "Excluir esta sessão?"}
        description={
          willArchive
            ? "Esta sessão possui reservas vinculadas. Ela será arquivada e deixará de aparecer nas agendas e páginas públicas, mas o histórico de reservas e pagamentos será preservado."
            : "Esta sessão não possui reservas vinculadas e será excluída definitivamente."
        }
        confirmLabel={willArchive ? "Arquivar sessão" : "Excluir sessão"}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />

      <ConfirmationDialog
        open={Boolean(restoring)}
        title="Restaurar esta sessão?"
        description="Ela volta a aparecer nas agendas e páginas públicas, desde que a data ainda esteja no futuro e não conflite com outra sessão ativa da mesma experiência."
        confirmLabel="Restaurar sessão"
        onClose={() => setRestoring(null)}
        onConfirm={confirmRestore}
      />
    </div>
  );
}
