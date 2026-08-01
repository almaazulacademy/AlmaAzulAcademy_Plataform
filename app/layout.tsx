import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://almaazul.academy"),
  title: {
    default: "Alma Azul Academy | Experiências na água",
    template: "%s | Alma Azul Academy",
  },
  description:
    "Experiências autênticas na água para mover o corpo, respirar fundo e reencontrar presença em Brasília.",
  openGraph: {
    title: "Alma Azul Academy",
    description: "Experiências autênticas na água, em Brasília.",
    images: ["/images/backgrounds/hero-alma-azul-lago.webp"],
    locale: "pt_BR",
    type: "website",
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
