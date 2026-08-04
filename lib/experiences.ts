export type ExperienceStatus = "available" | "coming-soon";

export type Experience = {
  slug: string;
  title: string;
  eyebrow: string;
  summary: string;
  location: string;
  duration: string;
  image: string;
  href: string;
  status: ExperienceStatus;
};

export const experiences: Experience[] = [
  {
    slug: "imersao-paranoa",
    title: "Imersão Paranoá",
    eyebrow: "Experiência inaugural",
    summary: "Uma travessia de canoa entre mata, água e presença no coração de Brasília.",
    location: "Lago Paranoá · Brasília",
    duration: "Uma manhã para desacelerar",
    image: "/images/backgrounds/corredor-corrego-do-torto.webp",
    href: "/imersao-paranoa",
    status: "available",
  },
  {
    slug: "remada-lua-cheia",
    title: "Remada da Lua Cheia",
    eyebrow: "Em breve",
    summary: "Uma experiência noturna guiada pelo ritmo da água e da lua.",
    location: "Lago Paranoá · Brasília",
    duration: "Novas datas em breve",
    image: "/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp",
    href: "#proximas-experiencias",
    status: "coming-soon",
  },
  {
    slug: "sunset",
    title: "Sunset",
    eyebrow: "Em breve",
    summary: "O fim do dia visto do melhor lugar possível: de dentro do lago.",
    location: "Lago Paranoá · Brasília",
    duration: "Novas datas em breve",
    image: "/images/experiences/remada-sunset/remada-sunset-hero.webp",
    href: "#proximas-experiencias",
    status: "coming-soon",
  },
];
