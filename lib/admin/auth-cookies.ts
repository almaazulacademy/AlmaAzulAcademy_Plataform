export const ADMIN_ACCESS_COOKIE = "alma_azul_admin_access";
export const ADMIN_REFRESH_COOKIE = "alma_azul_admin_refresh";

export const ADMIN_COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
