import { BRAND, emailLayout, escapeHtml, type ConfirmationEmail } from "../reservations/confirmation-email.ts";
import { SITE_NAME } from "../site.ts";

export const RESET_EMAIL_SUBJECT = "Redefinir sua senha | Alma Azul Academy";

export function buildPasswordResetEmail({ to, displayName, url }: { to: string; displayName: string; url: string }): ConfirmationEmail {
  const name = displayName.trim().split(/\s+/)[0] || "";
  const greeting = name ? `Olá, ${name}!` : "Olá!";
  const intro = "Recebemos um pedido para criar uma nova senha para o seu acesso à equipe Alma Azul.";
  const expiry = "O link vale por pouco tempo e só pode ser usado uma vez.";
  const ignore = "Se não foi você, ignore este e-mail: sua senha atual continua valendo.";

  const text = [greeting, "", intro, "", `Criar nova senha: ${url}`, "", expiry, ignore, "", SITE_NAME].join("\n");
  const html = emailLayout({
    title: RESET_EMAIL_SUBJECT,
    preheader: "Link para criar uma nova senha.",
    heading: "Redefinir senha",
    body: `
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(intro)}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
                <tr><td style="border-radius:999px;background-color:${BRAND.forest};">
                  <a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Criar nova senha</a>
                </td></tr>
              </table>
              <p style="margin:0 0 8px;font-size:14px;line-height:22px;color:${BRAND.ink};opacity:0.65;">${escapeHtml(expiry)}</p>
              <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND.ink};opacity:0.65;">${escapeHtml(ignore)}</p>
`,
  });
  return { to, subject: RESET_EMAIL_SUBJECT, html, text };
}
