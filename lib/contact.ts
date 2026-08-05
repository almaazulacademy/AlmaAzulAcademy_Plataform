export const WHATSAPP_NUMBER = "5561992682522";

function buildWhatsappLink(message: string) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export const WHATSAPP_MESSAGE =
  "Olá! Encontrei a Alma Azul pelo site e gostaria de mais informações sobre as experiências.";

export const WHATSAPP_LINK = buildWhatsappLink(WHATSAPP_MESSAGE);

export const WHATSAPP_RESERVATION_CODE_MESSAGE =
  "Olá! Esqueci meu código de reserva. Poderia me enviar novamente, por favor?";

export const WHATSAPP_RESERVATION_CODE_LINK = buildWhatsappLink(WHATSAPP_RESERVATION_CODE_MESSAGE);

export const WHATSAPP_UPCOMING_ACTIVITIES_MESSAGE =
  "Olá! Gostaria de saber mais sobre as atividades que estarão disponíveis em breve na Alma Azul.";

export const WHATSAPP_UPCOMING_ACTIVITIES_LINK = buildWhatsappLink(WHATSAPP_UPCOMING_ACTIVITIES_MESSAGE);

export const WHATSAPP_AGENDA_MESSAGE =
  "Olá! Gostaria de saber quando serão as próximas datas das experiências da Alma Azul.";

export const WHATSAPP_AGENDA_LINK = buildWhatsappLink(WHATSAPP_AGENDA_MESSAGE);

/** Espaço a ser preenchido pelo próprio cliente dentro da mensagem pronta. */
export const WHATSAPP_BLANK_FIELD = "____________________";

/**
 * Mensagem de dúvida após a confirmação da reserva.
 *
 * O nome da experiência é preenchido quando a página conhece a reserva. O nome do
 * cliente permanece em branco de propósito: na página de retorno o único
 * identificador é o order_nsu da URL, e preencher o nome a partir dele exporia
 * dado pessoal a quem tivesse o link.
 */
export function buildWhatsappReservationHelpLink(experienceTitle?: string) {
  const experience = experienceTitle?.trim() || WHATSAPP_BLANK_FIELD;
  return buildWhatsappLink(
    [
      "Olá! Acabei de confirmar minha reserva na Alma Azul Academy.",
      "",
      `Meu nome é: ${WHATSAPP_BLANK_FIELD}`,
      "",
      `Experiência: ${experience}`,
      "",
      "Gostaria de tirar uma dúvida sobre minha reserva.",
    ].join("\n"),
  );
}

export const CONTACT_EMAIL = "almaazulacademy@gmail.com";

export const EMAIL_LINK = `mailto:${CONTACT_EMAIL}`;

export const INSTAGRAM_HANDLE = "@almaazulacademy";

export const INSTAGRAM_LINK = "https://www.instagram.com/almaazulacademy/";
