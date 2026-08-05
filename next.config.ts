import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    formats: ["image/avif", "image/webp"],
  },
  async redirects() {
    return [
      // Rota legada da Imersão Paranoá. A URL canônica passou a ser
      // /experiencias/imersao-paranoa para não manter duas páginas indexáveis
      // com o mesmo conteúdo. O 308 preserva o fragmento (#reservas).
      {
        source: "/imersao-paranoa",
        destination: "/experiencias/imersao-paranoa",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
