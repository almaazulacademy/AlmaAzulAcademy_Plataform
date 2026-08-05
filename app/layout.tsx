import type { Metadata, Viewport } from "next";

import { SITE_NAME, SITE_OG_IMAGE, SITE_URL } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Alma Azul Academy | Experiências na água",
    template: "%s | Alma Azul Academy",
  },
  description:
    "Experiências autênticas na água para mover o corpo, respirar fundo e reencontrar presença em Brasília.",
  openGraph: {
    title: "Alma Azul Academy",
    description: "Experiências autênticas na água, em Brasília.",
    siteName: SITE_NAME,
    images: [SITE_OG_IMAGE],
    locale: "pt_BR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Alma Azul Academy",
    description: "Experiências autênticas na água, em Brasília.",
    images: [SITE_OG_IMAGE],
  },
};

export const viewport: Viewport = {
  themeColor: "#14312c",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
