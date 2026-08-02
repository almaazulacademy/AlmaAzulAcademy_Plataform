"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";

import { cn } from "@/lib/utils";

type Toast = {
  id: string;
  title: string;
  description?: string;
  variant?: "success" | "error";
};

type ToastInput = Omit<Toast, "id">;
type ToastContextValue = { notify: (toast: ToastInput) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((input: ToastInput) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { ...input, id }]);
    window.setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 top-4 z-[100] flex flex-col items-end gap-3 sm:left-auto sm:w-96" aria-live="polite">
        {toasts.map((toast) => {
          const isError = toast.variant === "error";
          const Icon = isError ? CircleAlert : CheckCircle2;
          return (
            <div
              key={toast.id}
              className={cn(
                "pointer-events-auto flex w-full gap-3 rounded-2xl border bg-white p-4 shadow-soft",
                isError ? "border-red-200" : "border-forest/15",
              )}
              role={isError ? "alert" : "status"}
            >
              <Icon className={cn("mt-0.5 size-5 shrink-0", isError ? "text-red-700" : "text-forest")} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{toast.title}</p>
                {toast.description ? <p className="mt-1 text-sm leading-5 text-ink/60">{toast.description}</p> : null}
              </div>
              <button type="button" onClick={() => dismiss(toast.id)} className="grid size-7 shrink-0 place-items-center rounded-full text-ink/45 hover:bg-ink/5 hover:text-ink" aria-label="Fechar aviso">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast deve ser usado dentro de ToastProvider.");
  return context;
}
