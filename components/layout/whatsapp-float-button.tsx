import { MessageCircle } from "lucide-react";

import { WHATSAPP_LINK } from "@/lib/contact";

export function WhatsappFloatButton() {
  return (
    <a
      href={WHATSAPP_LINK}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Conversar no WhatsApp com a Alma Azul Academy"
      className="fixed bottom-5 right-5 z-30 grid size-14 place-items-center rounded-full bg-forest text-white shadow-soft transition-transform hover:-translate-y-0.5 hover:shadow-lg sm:bottom-7 sm:right-7"
    >
      <MessageCircle className="size-6" />
    </a>
  );
}
