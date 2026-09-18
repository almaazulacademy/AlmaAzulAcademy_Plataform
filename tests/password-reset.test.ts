import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  completePasswordReset,
  requestPasswordReset,
  RESET_COOLDOWN_SECONDS,
  RESET_MAX_PER_HOUR,
  resetUrl,
  type ResetCompleteDeps,
  type ResetMembership,
  type ResetRequestDeps,
} from "../lib/auth/password-reset.ts";
import { isResetToken, normalizeEmail, RESET_REQUESTED_MESSAGE, validateResetCompletion } from "../lib/auth/password-reset-rules.ts";
import { buildPasswordResetEmail } from "../lib/auth/password-reset-email.ts";

const TOKEN = "a".repeat(56);
const USER = "00000000-0000-4000-8000-00000000000d";
const ORIGIN = "https://www.almaazulacademy.com.br";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const staff = (overrides: Partial<ResetMembership> = {}): ResetMembership => ({ role: "INSTRUCTOR", isActive: true, displayName: "Ana Lima", ...overrides });

function requestDeps(overrides: Partial<ResetRequestDeps> = {}) {
  const sent: Array<{ to: string; displayName: string; url: string }> = [];
  const recorded: string[] = [];
  const deps: ResetRequestDeps = {
    generateLink: async () => ({ userId: USER, tokenHash: TOKEN }),
    membership: async () => staff(),
    recentRequests: async () => ({ secondsSinceLast: null, lastHour: 0 }),
    send: async (message) => { sent.push(message); },
    record: async (userId) => { recorded.push(userId); },
    origin: ORIGIN,
    ...overrides,
  };
  return { deps, sent, recorded };
}

// --- Pedido -------------------------------------------------------------------

test("pedido: conta ativa da equipe recebe o link, e o pedido é auditado", async () => {
  const { deps, sent, recorded } = requestDeps();
  assert.equal(await requestPasswordReset("ana@exemplo.com", deps), "SENT");
  assert.deepEqual(sent, [{ to: "ana@exemplo.com", displayName: "Ana Lima", url: `${ORIGIN}/redefinir-senha?token=${TOKEN}` }]);
  assert.deepEqual(recorded, [USER]);
});

test("pedido: admin também pode recuperar a senha", async () => {
  const { deps, sent } = requestDeps({ membership: async () => staff({ role: "ADMIN" }) });
  assert.equal(await requestPasswordReset("admin@exemplo.com", deps), "SENT");
  assert.equal(sent.length, 1);
});

test("pedido: sem conta, fora da equipe ou desativado não recebe nada", async () => {
  for (const [overrides, outcome] of [
    [{ generateLink: async () => null }, "NO_ACCOUNT"],
    [{ membership: async () => null }, "NOT_STAFF"],
    [{ membership: async () => staff({ role: "customer" }) }, "NOT_STAFF"],
    [{ membership: async () => staff({ isActive: false }) }, "INACTIVE"],
  ] as const) {
    const { deps, sent, recorded } = requestDeps(overrides as Partial<ResetRequestDeps>);
    assert.equal(await requestPasswordReset("x@exemplo.com", deps), outcome);
    assert.equal(sent.length, 0, outcome);
    assert.equal(recorded.length, 0, outcome);
  }
});

test("pedido: limite por conta (intervalo mínimo e máximo por hora)", async () => {
  const cooldown = requestDeps({ recentRequests: async () => ({ secondsSinceLast: RESET_COOLDOWN_SECONDS - 1, lastHour: 1 }) });
  assert.equal(await requestPasswordReset("ana@exemplo.com", cooldown.deps), "THROTTLED");
  assert.equal(cooldown.sent.length, 0);

  const hourly = requestDeps({ recentRequests: async () => ({ secondsSinceLast: 3000, lastHour: RESET_MAX_PER_HOUR }) });
  assert.equal(await requestPasswordReset("ana@exemplo.com", hourly.deps), "THROTTLED");

  const ok = requestDeps({ recentRequests: async () => ({ secondsSinceLast: RESET_COOLDOWN_SECONDS + 1, lastHour: RESET_MAX_PER_HOUR - 1 }) });
  assert.equal(await requestPasswordReset("ana@exemplo.com", ok.deps), "SENT");
});

test("pedido: falha no envio não conta como pedido feito", async () => {
  const { deps, recorded } = requestDeps({ send: async () => { throw new Error("TIMEOUT"); } });
  assert.equal(await requestPasswordReset("ana@exemplo.com", deps), "SEND_FAILED");
  assert.equal(recorded.length, 0);
});

test("rota do pedido responde a mesma mensagem em qualquer caso (sem enumeração)", () => {
  const route = source("app/api/auth/password-reset/route.ts");
  assert.match(route, /await requestPasswordReset\(email, deps\)\.catch\(\(\) => undefined\);\n\s+return NextResponse\.json\(\{ message: RESET_REQUESTED_MESSAGE \}\);/);
  assert.doesNotMatch(route, /NO_ACCOUNT|NOT_STAFF|INACTIVE|THROTTLED/);
  assert.match(RESET_REQUESTED_MESSAGE, /Se este e-mail/);
});

// --- Redefinição ----------------------------------------------------------------

function completeDeps(overrides: Partial<ResetCompleteDeps> = {}) {
  const calls: string[] = [];
  const deps: ResetCompleteDeps = {
    verify: async () => ({ userId: USER, email: "ana@exemplo.com", accessToken: "jwt" }),
    membership: async () => staff(),
    updatePassword: async () => { calls.push("update"); return "OK"; },
    signOutEverywhere: async () => { calls.push("signout"); },
    record: async () => { calls.push("record"); },
    ...overrides,
  };
  return { deps, calls };
}

test("redefinição: troca a senha, encerra todas as sessões e audita", async () => {
  const { deps, calls } = completeDeps();
  const result = await completePasswordReset({ token: TOKEN, password: "remada2026" }, deps);
  assert.deepEqual(result, { ok: true, email: "ana@exemplo.com", role: "INSTRUCTOR" });
  assert.deepEqual(calls, ["update", "signout", "record"]);
});

test("redefinição: link inválido, usado ou expirado não troca nada", async () => {
  const { deps, calls } = completeDeps({ verify: async () => null });
  const result = await completePasswordReset({ token: TOKEN, password: "remada2026" }, deps);
  assert.equal(!result.ok && result.code, "LINK_INVALID");
  assert.deepEqual(calls, []);
});

test("redefinição: conta desativada ou fora da equipe não troca a senha", async () => {
  for (const membership of [async () => staff({ isActive: false }), async () => null, async () => staff({ role: "customer" })]) {
    const { deps, calls } = completeDeps({ membership });
    const result = await completePasswordReset({ token: TOKEN, password: "remada2026" }, deps);
    assert.equal(!result.ok && result.code, "NOT_ALLOWED");
    assert.deepEqual(calls, ["signout"]);
  }
});

test("redefinição: senha recusada pelo Supabase não deixa sessão aberta", async () => {
  const { deps, calls } = completeDeps({ updatePassword: async () => "WEAK_PASSWORD" });
  const result = await completePasswordReset({ token: TOKEN, password: "remada2026" }, deps);
  assert.equal(!result.ok && result.code, "WEAK_PASSWORD");
  assert.deepEqual(calls, ["signout"]);
});

// --- Regras, link e e-mail --------------------------------------------------------

test("validação: token, senha e confirmação", () => {
  assert.equal(isResetToken(TOKEN), true);
  for (const bad of ["", "abc", "z".repeat(56), `${TOKEN}<script>`, null]) assert.equal(isResetToken(bad), false);
  assert.equal(normalizeEmail(" ANA@Exemplo.com "), "ana@exemplo.com");
  assert.equal(normalizeEmail("nope"), null);

  const ok = validateResetCompletion({ token: TOKEN, password: "remada2026", passwordConfirmation: "remada2026" });
  assert.deepEqual(ok, { success: true, data: { token: TOKEN, password: "remada2026" } });
  const bad = validateResetCompletion({ token: "x", password: "curta", passwordConfirmation: "" });
  assert.equal(bad.success, false);
  if (!bad.success) assert.deepEqual(Object.keys(bad.errors).sort(), ["form", "password"]);
  const mismatch = validateResetCompletion({ token: TOKEN, password: "remada2026", passwordConfirmation: "remada2027" });
  assert.equal(!mismatch.success && mismatch.errors.passwordConfirmation, "As senhas não conferem.");
});

test("e-mail: link correto, nome escapado e sem o token fora do link", () => {
  const url = resetUrl(ORIGIN, TOKEN);
  const email = buildPasswordResetEmail({ to: "ana@exemplo.com", displayName: "<b>Ana</b> Lima", url });
  assert.equal(email.to, "ana@exemplo.com");
  assert.ok(email.html.includes(`href="${url}"`));
  assert.ok(email.text.includes(url));
  assert.ok(!email.html.includes("<b>Ana</b>"));
  assert.ok(email.html.includes("&lt;b&gt;Ana&lt;/b&gt;"));
  assert.equal(email.html.split(TOKEN).length - 1, 1);
});

test("abrir a página de redefinição não consome o link; token não vaza por Referer", () => {
  const page = source("app/redefinir-senha/page.tsx");
  assert.doesNotMatch(page, /verifyOtp|passwordResetCompleteDeps|completePasswordReset/);
  assert.match(page, /referrer: "no-referrer"/);
});

test("a recuperação usa service role só no servidor e nunca papel vindo do cliente", () => {
  const service = source("lib/auth/password-reset-service.ts");
  assert.match(service, /generateLink\(\{ type: "recovery", email \}\)/);
  assert.doesNotMatch(service, /redirectTo|user_metadata|app_metadata/);
  for (const client of ["components/auth/forgot-password-form.tsx", "components/auth/reset-password-form.tsx"]) {
    assert.doesNotMatch(source(client), /supabase|password-reset-service|SERVICE_ROLE/i, client);
  }
  assert.match(source("components/admin/login-form.tsx"), /href="\/esqueci-senha"/);
});
