import type { ExperienceEditorial, PublicExperience } from "./experience.ts";

export const imersaoParanoaEditorial: ExperienceEditorial = {
  version: 1,
  hero: {
    eyebrow: "Experiência inaugural · Alma Azul Academy",
    title: "Imersão Paranoá",
    subtitle: "Explore o lado mais preservado do Lago Paranoá.",
    image: { src: "/images/backgrounds/hero-alma-azul-lago.webp", alt: "Canoas da Alma Azul no Lago Paranoá vistas de cima" },
    primaryCta: { label: "Ver próximas datas", href: "#reservas" },
    secondaryCta: { label: "Conheça o percurso", href: "#sobre" },
    details: ["Brasília, DF", "1h30 de experiência", "Nível iniciante"],
  },
  quickFacts: [
    { label: "Onde", value: "Lago Paranoá" },
    { label: "Formato", value: "Em grupo" },
    { label: "Duração", value: "1h30" },
    { label: "Reservas", value: "Datas abertas" },
  ],
  about: {
    eyebrow: "Sobre a experiência",
    title: "Explore o lado mais preservado do Lago Paranoá.",
    paragraphs: [
      "Uma experiência de 1h30 navegando pelo Lago Paranoá por um dos lugares mais preservados e belos de Brasília: o Córrego do Torto.",
      "No caminho passamos por paisagens que poucas pessoas conhecem, fazemos uma pausa para banho em uma prainha no meio do lago e encerramos tudo com um lanche colaborativo na nossa base.",
    ],
    image: { src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp", alt: "Canoas saindo do corredor verde em direção ao lago" },
  },
  gallery: {
    eyebrow: "Galeria",
    title: "Água, mata e boas companhias.",
    description: "Registros reais da Alma Azul. Sem banco de imagens, sem cenário montado.",
    images: [
      { src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2074.webp", alt: "Canoas navegando sob a mata do Córrego do Torto" },
      { src: "/images/experiences/imersao-paranoa/lago/alma-azul-original.webp", alt: "Participantes tomando banho no Lago Paranoá" },
      { src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-1956.webp", alt: "Grupo remando no corredor natural" },
      { src: "/images/experiences/imersao-paranoa/grupos/img-3964.webp", alt: "Grupo reunido entre canoas" },
      { src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp", alt: "Paisagem aberta entre o córrego e a vegetação" },
      { src: "/images/experiences/imersao-paranoa/lago/img-4363.webp", alt: "Grupo celebrando a chegada ao lago com os remos erguidos" },
    ],
  },
  steps: {
    eyebrow: "Como funciona",
    title: "Do encontro ao mergulho.",
    description: "Uma jornada simples, bem conduzida e no ritmo do grupo.",
    items: [
      { title: "Encontro", description: "Recepção do grupo, preparação dos equipamentos e orientações de segurança." },
      { title: "Travessia", description: "Remada guiada pelo corredor do Córrego do Torto, cercado pela mata." },
      { title: "Banho", description: "Pausa para banho em uma prainha no meio do lago, cercada pela natureza exuberante do Lago Norte." },
    ],
  },
  included: {
    eyebrow: "Tudo preparado",
    title: "O que está incluso.",
    description: "Você chega com disposição. A Alma Azul cuida da estrutura da experiência.",
    items: [
      { icon: "LifeBuoy", title: "Equipamentos", description: "Coletes salva-vidas e remos preparados para a experiência." },
      { icon: "Compass", title: "Instrutores em cada canoa", description: "Acompanhamento próximo da equipe Alma Azul durante todo o percurso." },
      { icon: "ShieldCheck", title: "Instrução para iniciantes", description: "Orientação completa antes da saída, mesmo para quem nunca remou." },
      { icon: "Sparkles", title: "Lanche colaborativo", description: "Encontro na base ao final, com café preto por conta da casa." },
      { icon: "Droplets", title: "Banho no lago", description: "Uma pausa para entrar na água e aproveitar o Lago Paranoá." },
    ],
  },
  faq: {
    eyebrow: "Dúvidas frequentes",
    title: "Antes de entrar na água.",
    locationLabel: "Brasília · Distrito Federal",
    items: [
      { question: "Quanto tempo dura a experiência?", answer: "A experiência dura aproximadamente 1h30. O horário exato e as informações do encontro aparecem em cada sessão disponível." },
    ],
  },
  reservations: {
    eyebrow: "Escolha seu dia",
    title: "Próximas datas",
    description: "Confira as sessões futuras e abertas, escolha sua data e garanta suas vagas com pagamento seguro.",
    image: { src: "/images/experiences/imersao-paranoa/lago/img-1225.webp", alt: "Grupo observando o Lago Paranoá ao final da travessia" },
  },
  seo: { title: "Imersão Paranoá", description: "Uma travessia de canoa pelo corredor do Córrego do Torto até o Lago Paranoá, em Brasília." },
};

export const imersaoParanoaFallback: PublicExperience = {
  id: "fallback-imersao-paranoa",
  slug: "imersao-paranoa",
  title: "Imersão Paranoá",
  summary: "Uma travessia de canoa entre mata, água e presença no coração de Brasília.",
  imageUrl: "/images/backgrounds/corredor-corrego-do-torto.webp",
  displayOrder: 0,
  editorial: imersaoParanoaEditorial,
};
