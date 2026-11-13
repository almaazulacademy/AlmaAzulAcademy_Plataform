"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Lock, Save } from "lucide-react";

import { fieldErrorClass, inputClass, labelClass, textareaClass } from "@/components/admin/form-styles";
import { useToast } from "@/components/admin/toast-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatCurrency } from "@/lib/admin/format";
import {
  validateCouponCreate,
  validateCouponUpdate,
  type AdminCoupon,
  type CouponExperienceOption,
} from "@/lib/admin/coupons";
import {
  COUPON_CODE_MAX_LENGTH,
  COUPON_PERCENT_MAX,
  COUPON_PERCENT_MIN,
  discountedUnitPriceCents,
  type CouponScope,
  type CouponStatus,
} from "@/lib/coupons/rules";
import { cn } from "@/lib/utils";

const EXPERIENCE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Rascunho",
  COMING_SOON: "Em breve",
  ARCHIVED: "Arquivada",
};

type Errors = Record<string, string>;

function FieldError({ message }: { message?: string }) {
  return message ? <p className={fieldErrorClass} role="alert">{message}</p> : null;
}

/**
 * Formulário de criação e edição de cupom.
 *
 * Valida no navegador com as mesmas regras do servidor (`lib/coupons/rules.ts`)
 * só para dar a mensagem por campo; quem decide é a rota e, depois dela, o
 * banco. Num cupom já utilizado, código, percentual e aplicabilidade aparecem
 * bloqueados com a explicação; datas, limite e descrição seguem editáveis. O
 * status não muda por aqui: é o botão Ativar/Desativar, com auditoria própria.
 */
export function CouponForm({ mode, experiences, coupon }: { mode: "create" | "edit"; experiences: CouponExperienceOption[]; coupon?: AdminCoupon }) {
  const router = useRouter();
  const { notify } = useToast();
  const locked = mode === "edit" && Boolean(coupon?.locked);
  const countedUses = coupon?.uses.counted ?? 0;

  const [code, setCode] = useState(coupon?.code ?? "");
  const [percentOff, setPercentOff] = useState(coupon ? String(coupon.percentOff) : "");
  const [validFrom, setValidFrom] = useState(coupon?.validFrom ?? "");
  const [validUntil, setValidUntil] = useState(coupon?.validUntil ?? "");
  const [limitMode, setLimitMode] = useState<"UNLIMITED" | "CUSTOM">(coupon?.maxUses ? "CUSTOM" : "UNLIMITED");
  const [maxUses, setMaxUses] = useState(coupon?.maxUses ? String(coupon.maxUses) : "");
  const [scope, setScope] = useState<CouponScope>(coupon?.scope ?? "ALL_REGULAR");
  const [selected, setSelected] = useState<Set<string>>(new Set(coupon?.experiences.map((item) => item.id) ?? []));
  const [status, setStatus] = useState<CouponStatus>("INACTIVE");
  const [description, setDescription] = useState(coupon?.description ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  // Arquivadas só aparecem se já estiverem no cupom: tirá-las mudaria a aplicabilidade.
  const visible = useMemo(() => experiences.filter((item) => item.status !== "ARCHIVED" || selected.has(item.id)), [experiences, selected]);
  const regular = visible.filter((item) => item.kind === "REGULAR");
  const events = visible.filter((item) => item.kind === "EVENT");

  const percentNumber = Number(percentOff);
  const example = Number.isInteger(percentNumber) && percentNumber >= COUPON_PERCENT_MIN && percentNumber <= COUPON_PERCENT_MAX
    ? `Ex.: uma experiência de ${formatCurrency(10_000)} sai por ${formatCurrency(discountedUnitPriceCents(10_000, percentNumber))} por participante.`
    : null;

  const toggleExperience = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      code,
      percentOff: percentOff.trim() === "" ? Number.NaN : Number(percentOff),
      validFrom: validFrom || null,
      validUntil: validUntil || null,
      maxUses: limitMode === "CUSTOM" ? (maxUses.trim() === "" ? Number.NaN : Number(maxUses)) : null,
      scope,
      experienceIds: scope === "SELECTED" ? [...selected] : [],
      description: description || null,
      ...(mode === "create" ? { status } : { expectedUpdatedAt: coupon?.updatedAt ?? "" }),
    };
    const check = mode === "create" ? validateCouponCreate(payload) : validateCouponUpdate(payload);
    if (!check.success) {
      setErrors(check.errors);
      setFormError("Revise os campos destacados.");
      return;
    }
    if (mode === "edit" && limitMode === "CUSTOM" && coupon && Number(maxUses) < countedUses && (coupon.maxUses === null || Number(maxUses) < coupon.maxUses)) {
      setErrors({ maxUses: `O limite não pode ficar abaixo das ${countedUses} utilizações já contabilizadas.` });
      setFormError("Revise os campos destacados.");
      return;
    }

    setSaving(true);
    setErrors({});
    setFormError("");
    try {
      const response = await fetch(mode === "create" ? "/api/admin/coupons" : `/api/admin/coupons/${coupon?.id}`, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const answer = (await response.json().catch(() => ({}))) as { message?: string; errors?: Errors; coupon?: { id?: string } };
      if (!response.ok) {
        setErrors(answer.errors ?? {});
        setFormError(answer.message ?? "Não foi possível salvar o cupom.");
        setSaving(false);
        return;
      }
      notify({ title: mode === "create" ? "Cupom criado" : "Cupom atualizado", description: answer.message });
      router.push(`/admin/marketing/cupons/${answer.coupon?.id ?? coupon?.id ?? ""}`);
      router.refresh();
    } catch {
      setFormError("Sem conexão com o servidor. Confira o cupom na lista antes de tentar de novo.");
      setSaving(false);
    }
  };

  const lockedNote = locked ? <span className="mt-1.5 flex items-center gap-1.5 text-xs text-ink/50"><Lock className="size-3.5" aria-hidden /> Bloqueado depois da primeira utilização.</span> : null;

  return (
    <form onSubmit={submit} className="mt-8 space-y-6" noValidate aria-label={mode === "create" ? "Novo cupom" : "Editar cupom"}>
      {locked ? (
        <section className="flex items-start gap-3 rounded-3xl border border-sky-200 bg-sky-50 p-5" aria-label="Campos bloqueados">
          <Lock className="mt-0.5 size-5 shrink-0 text-sky-800" aria-hidden />
          <div className="text-sm leading-6 text-sky-950">
            <p className="font-semibold">Este cupom já foi utilizado.</p>
            <p className="mt-1 text-sky-900/80">
              Código, percentual e experiências elegíveis ficam bloqueados para preservar o que foi cobrado e o histórico financeiro.
              Datas, limite e descrição continuam editáveis{countedUses > 0 ? `; o limite não pode ficar abaixo das ${countedUses} ${countedUses === 1 ? "utilização contabilizada" : "utilizações contabilizadas"}` : ""}.
            </p>
          </div>
        </section>
      ) : null}

      <section className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
        <h2 className="text-sm font-semibold">Campanha</h2>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <label>
            <span className={labelClass}>Código promocional</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().replace(/\s+/g, ""))}
              className={cn(inputClass, "font-mono tracking-wide")}
              maxLength={COUPON_CODE_MAX_LENGTH}
              placeholder="ALMAAZUL10"
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
              aria-invalid={Boolean(errors.code)}
            />
            {lockedNote ?? <span className="mt-1.5 block text-xs text-ink/45">3 a 32 caracteres: letras, números e hífen. Salvo em maiúsculas.</span>}
            <FieldError message={errors.code} />
          </label>
          <label>
            <span className={labelClass}>Desconto (%)</span>
            <input
              type="number"
              inputMode="numeric"
              min={COUPON_PERCENT_MIN}
              max={COUPON_PERCENT_MAX}
              step={1}
              value={percentOff}
              onChange={(event) => setPercentOff(event.target.value)}
              className={inputClass}
              placeholder="10"
              disabled={locked}
              aria-invalid={Boolean(errors.percentOff)}
            />
            {lockedNote ?? <span className="mt-1.5 block text-xs text-ink/45">{example ?? `De ${COUPON_PERCENT_MIN}% a ${COUPON_PERCENT_MAX}%, aplicado por participante.`}</span>}
            <FieldError message={errors.percentOff} />
          </label>
          <label className="sm:col-span-2">
            <span className={labelClass}>Descrição interna (opcional)</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className={textareaClass}
              maxLength={500}
              placeholder="Campanha de boas-vindas para clientes da Comunidade Alma Azul"
            />
            <span className="mt-1.5 block text-xs text-ink/45">Só a equipe vê. Até 500 caracteres.</span>
            <FieldError message={errors.description} />
          </label>
        </div>
      </section>

      <section className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
        <h2 className="text-sm font-semibold">Validade e limite</h2>
        <p className="mt-1 text-xs text-ink/50">A validade é conferida pela data da compra, no horário de Brasília. Sem datas, o cupom não tem prazo.</p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <label>
            <span className={labelClass}>Início (opcional)</span>
            <input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} className={inputClass} aria-invalid={Boolean(errors.validFrom)} />
            <FieldError message={errors.validFrom} />
          </label>
          <label>
            <span className={labelClass}>Término (opcional)</span>
            <input type="date" value={validUntil} min={validFrom || undefined} onChange={(event) => setValidUntil(event.target.value)} className={inputClass} aria-invalid={Boolean(errors.validUntil)} />
            <FieldError message={errors.validUntil} />
          </label>
          <fieldset className="sm:col-span-2">
            <legend className={labelClass}>Limite de utilizações</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="limit" checked={limitMode === "UNLIMITED"} onChange={() => setLimitMode("UNLIMITED")} className="size-4 accent-lake" /> Ilimitado</label>
              <label className="flex items-center gap-2"><input type="radio" name="limit" checked={limitMode === "CUSTOM"} onChange={() => setLimitMode("CUSTOM")} className="size-4 accent-lake" /> Quantidade máxima</label>
            </div>
            {limitMode === "CUSTOM" ? (
              <div className="mt-3 max-w-xs">
                <input
                  type="number"
                  inputMode="numeric"
                  min={Math.max(1, countedUses)}
                  step={1}
                  value={maxUses}
                  onChange={(event) => setMaxUses(event.target.value)}
                  className={inputClass}
                  placeholder="100"
                  aria-label="Quantidade máxima de utilizações"
                  aria-invalid={Boolean(errors.maxUses)}
                />
              </div>
            ) : null}
            <span className="mt-1.5 block text-xs text-ink/45">
              Uma utilização é uma reserva, qualquer que seja o número de participantes.
              {countedUses > 0 ? ` Já ${countedUses === 1 ? "há 1 utilização contabilizada" : `há ${countedUses} utilizações contabilizadas`}.` : ""}
            </span>
            <FieldError message={errors.maxUses} />
          </fieldset>
        </div>
      </section>

      <section className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
        <h2 className="text-sm font-semibold">Experiências elegíveis</h2>
        {locked ? <p className="mt-1 flex items-center gap-1.5 text-xs text-ink/50"><Lock className="size-3.5" aria-hidden /> Bloqueadas depois da primeira utilização.</p> : null}
        <fieldset className="mt-4" disabled={locked}>
          <legend className="sr-only">Aplicabilidade</legend>
          <div className="space-y-3 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" name="scope" checked={scope === "ALL_REGULAR"} onChange={() => setScope("ALL_REGULAR")} className="mt-0.5 size-4 accent-lake" />
              <span><span className="font-medium">Todas as experiências regulares</span><span className="block text-xs text-ink/50">Não vale para eventos especiais.</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="scope" checked={scope === "SELECTED"} onChange={() => setScope("SELECTED")} className="mt-0.5 size-4 accent-lake" />
              <span><span className="font-medium">Experiências específicas</span><span className="block text-xs text-ink/50">Eventos especiais só recebem o cupom quando marcados aqui.</span></span>
            </label>
          </div>
          {scope === "SELECTED" ? (
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              {[{ title: "Experiências regulares", items: regular }, { title: "Eventos especiais", items: events }].map((group) => (
                <div key={group.title} className="rounded-2xl border border-ink/10 bg-mist/30 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/55">{group.title}</p>
                  {group.items.length === 0 ? (
                    <p className="mt-3 text-sm text-ink/45">Nenhuma cadastrada.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleExperience(item.id)} className="size-4 accent-lake" />
                            <span className="min-w-0 flex-1 truncate">{item.title || "Sem título"}</span>
                            {EXPERIENCE_STATUS_LABELS[item.status] ? <span className="rounded-full bg-ink/5 px-2 py-0.5 text-[11px] font-medium text-ink/55">{EXPERIENCE_STATUS_LABELS[item.status]}</span> : null}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </fieldset>
        <FieldError message={errors.experienceIds ?? errors.scope} />
      </section>

      {mode === "create" ? (
        <section className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
          <h2 className="text-sm font-semibold">Status inicial</h2>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="status" checked={status === "INACTIVE"} onChange={() => setStatus("INACTIVE")} className="size-4 accent-lake" /> Inativo (nasce sem aceitar utilizações)</label>
            <label className="flex items-center gap-2"><input type="radio" name="status" checked={status === "ACTIVE"} onChange={() => setStatus("ACTIVE")} className="size-4 accent-lake" /> Ativo</label>
          </div>
          <FieldError message={errors.status} />
        </section>
      ) : (
        <p className="rounded-2xl bg-mist/60 p-4 text-xs leading-5 text-ink/60">Para ativar ou desativar o cupom, use o botão no detalhe. A mudança de status fica registrada na auditoria.</p>
      )}

      {formError ? <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">{formError}</p> : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href={mode === "edit" && coupon ? `/admin/marketing/cupons/${coupon.id}` : "/admin/marketing/cupons"} className={buttonVariants({ variant: "ghost" })}>Cancelar</Link>
        <Button type="submit" disabled={saving}><Save className="size-4" /> {saving ? "Salvando..." : mode === "create" ? "Criar cupom" : "Salvar alterações"}</Button>
      </div>
    </form>
  );
}
