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

export const CONTACT_EMAIL = "almaazulacademy@gmail.com";

export const EMAIL_LINK = `mailto:${CONTACT_EMAIL}`;
