import { ADMIN_ROLES, STAFF_ROLES, type AdminRole, type StaffRole } from "@/lib/admin/types";

// Regras de papel em um lugar só. O banco aplica as mesmas regras
// (`is_active_admin`, `is_active_checkin_staff`, `is_active_owner_admin`);
// aqui elas decidem só navegação e respostas HTTP.

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

/** Painel administrativo completo. */
export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Convidar, listar, desativar e reativar instrutores. */
export function canManageTeam(role: StaffRole) {
  return role === "ADMIN";
}

/** Envio de QR por e-mail ao cliente (individual e em lote). */
export function canSendCheckinQr(role: StaffRole) {
  return role === "ADMIN";
}

export const INSTRUCTOR_HOME = "/instrutor";

export function homeForRole(role: StaffRole) {
  return isAdminRole(role) ? "/admin" : INSTRUCTOR_HOME;
}

/** Destino pós-login: só aceita caminhos internos permitidos para o papel. */
export function loginDestination(role: StaffRole, requested: string | null | undefined) {
  const next = typeof requested === "string" && requested.startsWith("/") && !requested.startsWith("//") ? requested : "";
  if (isAdminRole(role) && next.startsWith("/admin")) return next;
  if (role === "INSTRUCTOR" && (next === INSTRUCTOR_HOME || next.startsWith(`${INSTRUCTOR_HOME}/`)) && !next.startsWith(`${INSTRUCTOR_HOME}/cadastro`)) return next;
  return homeForRole(role);
}
