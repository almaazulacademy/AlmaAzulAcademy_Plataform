import type { BaseMediaItem } from "./media.ts";
import type { PublicBase } from "./types.ts";

/**
 * Conteúdo editorial das páginas de base.
 *
 * O banco guarda a identidade da base (nome, status, descrição, localização,
 * parceiro e imagem). Seções ricas — estrutura, galeria, texto da parceria —
 * ficam aqui, por slug, como já acontece com o conteúdo institucional da Home.
 * Uma base nova sem entrada aqui continua tendo página, montada só com os
 * campos do banco.
 *
 * Só entram fatos já publicados pela Alma Azul. Nada de estrutura inventada.
 *
 * `heroImage` e `space` são mídia DA BASE (o espaço). Mídia de experiência fica
 * na própria experiência. Ver `lib/bases/media.ts`.
 */

export type BaseHighlight = { icon: "Compass" | "LifeBuoy" | "ShieldCheck" | "Sparkles" | "Droplets" | "Waves"; title: string; description: string };
export type BaseGalleryImage = { src: string; alt: string };

export type BasePageContent = {
  heroEyebrow: string;
  heroTitle: string;
  heroSubtitle: string;
  heroImage: BaseGalleryImage;
  aboutTitle: string;
  experiencesTitle: string;
  experiencesDescription: string;
  structure?: { title: string; description: string; items: BaseHighlight[] };
  gallery?: { title: string; description: string; images: BaseGalleryImage[] };
  /**
   * Mídia do espaço (fotos e vídeos do lugar, sem depender de canoa). A seção só
   * aparece quando há itens — é aqui que entra o acervo real da Concha/Cápsula,
   * a partir de `public/images/bases/<slug>/` e `public/videos/bases/<slug>/`.
   */
  space?: { title: string; description: string; items: BaseMediaItem[] };
  partnership?: { title: string; description: string };
};

const CONTENT: Record<string, BasePageContent> = {
  "lago-norte": {
    heroEyebrow: "Base Lago Norte · Brasília",
    heroTitle: "Lago Norte",
    heroSubtitle: "Nossa base de origem, entre a mata do Córrego do Torto e as águas abertas do Lago Paranoá.",
    heroImage: {
      src: "/images/experiences/imersao-paranoa/lago/vista-aerea-lago.webp",
      alt: "Vista aérea de canoas da Alma Azul em uma prainha no Lago Paranoá",
    },
    aboutTitle: "Onde a Alma Azul começou.",
    experiencesTitle: "Experiências da Base Lago Norte",
    experiencesDescription: "Todas com datas abertas e reserva online. Escolha a sua e siga direto para a agenda.",
    structure: {
      title: "Tudo preparado para você só remar.",
      description: "Você chega com disposição. A equipe da Alma Azul cuida do resto.",
      items: [
        { icon: "LifeBuoy", title: "Equipamentos", description: "Canoas havaianas, remos e coletes salva-vidas preparados para cada saída." },
        { icon: "Compass", title: "Instrutores em cada canoa", description: "Acompanhamento próximo da equipe Alma Azul durante todo o percurso." },
        { icon: "ShieldCheck", title: "Instrução para iniciantes", description: "Orientação de segurança e de remada antes da saída, mesmo para quem nunca remou." },
        { icon: "Droplets", title: "Banho no lago", description: "Pausas para entrar na água e aproveitar as prainhas do Lago Paranoá." },
      ],
    },
    gallery: {
      title: "O cenário da base.",
      description: "Registros reais das experiências que saem do Lago Norte.",
      images: [
        { src: "/images/experiences/imersao-paranoa/canoas/canoas-navegando.webp", alt: "Canoas navegando pelo Córrego do Torto, cercadas pela mata" },
        { src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2074.webp", alt: "Canoas navegando sob a mata do Córrego do Torto" },
        { src: "/images/experiences/remada-sunset/remada-sunset-galeria-01.webp", alt: "Canoa havaiana navegando no Lago Paranoá durante o pôr do sol" },
        { src: "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-01.webp", alt: "Canoa havaiana vista de frente nas águas do Lago Paranoá ao amanhecer" },
        { src: "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-01.webp", alt: "Lua cheia sobre canoas havaianas alinhadas na margem do Lago Paranoá" },
        { src: "/images/experiences/imersao-paranoa/natureza/paisagem-corrego-do-torto.webp", alt: "Paisagem do Córrego do Torto vista de dentro da canoa" },
      ],
    },
  },
  "concha-acustica": {
    heroEyebrow: "Nova base · Em breve",
    heroTitle: "Concha Acústica",
    heroSubtitle: "Nossa nova base está chegando. Uma nova forma de viver o Lago Paranoá, a partir do coração de Brasília.",
    heroImage: {
      src: "/images/experiences/remada-sunset/remada-sunset-sobre.webp",
      alt: "Participantes em uma canoa havaiana contemplando o pôr do sol sobre o Lago Paranoá",
    },
    aboutTitle: "Brasília vista a partir da água.",
    // Preparado para o acervo do espaço (Concha Acústica/Cápsula Bar). Vazio até a curadoria.
    space: {
      title: "O espaço.",
      description: "A Concha Acústica e o Cápsula Bar, onde a nova base vai receber você.",
      items: [],
    },
    experiencesTitle: "Experiências planejadas",
    experiencesDescription: "A programação da Concha Acústica ainda não está aberta. Estas são as experiências que vão sair da nova base.",
    partnership: {
      title: "Uma nova base, feita em parceria.",
      description:
        "A nova base nasce de uma parceria com o Cápsula Bar, na Concha Acústica. As experiências continuam sendo conduzidas pela equipe Alma Azul, com o mesmo cuidado de sempre.",
    },
  },
};

export function basePageContent(base: PublicBase): BasePageContent {
  const content = CONTENT[base.slug];
  if (content) return content;
  return {
    heroEyebrow: `Base ${base.name}`,
    heroTitle: base.name,
    heroSubtitle: base.shortDescription,
    heroImage: { src: base.imageUrl ?? "/images/backgrounds/hero-alma-azul-lago.webp", alt: `Base ${base.name} da Alma Azul` },
    aboutTitle: `Base ${base.name}`,
    experiencesTitle: `Experiências da Base ${base.name}`,
    experiencesDescription: base.status === "ACTIVE" ? "Escolha uma experiência para ver as próximas datas." : "A programação desta base ainda não está aberta.",
  };
}
