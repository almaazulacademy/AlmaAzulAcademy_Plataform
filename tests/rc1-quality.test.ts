import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("login não envia diagnóstico para o console do cliente", () => {
  const login = source("components/admin/login-form.tsx");
  assert.doesNotMatch(login, /console\.(log|info|debug)/);
});

test("menu e confirmação bloqueiam o scroll de fundo", () => {
  const shell = source("components/admin/admin-shell.tsx");
  const dialog = source("components/admin/confirmation-dialog.tsx");
  assert.match(shell, /document\.body\.style\.overflow = "hidden"/);
  assert.match(dialog, /document\.body\.style\.overflow = "hidden"/);
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /max-h-\[calc\(100dvh-2rem\)\]/);
});

test("estados vazios administrativos oferecem próxima ação", () => {
  assert.match(source("components/admin/experiences-manager.tsx"), /Criar experiência/);
  assert.match(source("components/admin/sessions-manager.tsx"), /Criar sessão/);
  const reservations = source("components/admin/reservations-list.tsx");
  assert.match(reservations, /Limpar filtros/);
  assert.match(reservations, /Ver sessões/);
});
