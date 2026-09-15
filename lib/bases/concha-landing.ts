/**
 * Conteúdo da landing da Base Concha Acústica (em breve).
 *
 * Só copy e mídia. Nada aqui altera banco, sessões, valores ou status: a página
 * continua fechada enquanto `bases.status` não for ACTIVE.
 *
 * As fotos e o vídeo com canoas são registros reais da Alma Azul no Lago
 * Paranoá — ainda não foram produzidos na nova base. Por isso aparecem sempre
 * com `mediaCredit`, e nenhuma foto é associada a um roteiro específico.
 *
 * As fotos em `capsula` são do próprio lugar (Cápsula, às margens do Lago
 * Paranoá): levam legenda, não o selo de registro temporário.
 *
 * Originais: pasta "Capsula + Alma Azul" no Google Drive. Em `public/` ficam só
 * os derivados otimizados (WebP e MP4 H.264 sem áudio).
 */

const IMG = "/images/bases/concha-acustica";
const VID = "/videos/bases/concha-acustica";

export const CONCHA_LANDING = {
  mediaCredit: "Registros de experiências Alma Azul no Lago Paranoá",
  hero: {
    eyebrow: "Nova base · Em breve",
    title: "Alma Azul na Concha Acústica",
    description: "Uma nova forma de viver o Lago Paranoá, agora a partir de um dos lugares mais especiais de Brasília.",
    image: {
      desktop: `${IMG}/concha-hero-nascer-do-sol-desktop.webp`,
      mobile: `${IMG}/concha-hero-nascer-do-sol-mobile.webp`,
      alt: "Canoa havaiana da Alma Azul remando ao nascer do sol no Lago Paranoá",
    },
  },
  partner: {
    logo: `${IMG}/capsula-bar-logo.webp`,
    video: {
      desktop: `${VID}/capsula-logo-animada-960.mp4`,
      mobile: `${VID}/capsula-logo-animada-640.mp4`,
      poster: `${IMG}/capsula-logo-animada-poster.webp`,
    },
  },
  impact: {
    title: "Brasília vista da água",
    description: "A cidade muda quando o ponto de vista muda.",
    video: {
      desktop: `${VID}/brasilia-vista-da-agua-1280.mp4`,
      mobile: `${VID}/brasilia-vista-da-agua-854.mp4`,
      poster: `${IMG}/brasilia-vista-da-agua-poster.webp`,
    },
  },
  // Cápsula como nova base. Só fatos fornecidos pela Alma Azul: origem na
  // Chapada dos Veadeiros, chegada ao Lago Paranoá e Lia Braga como idealizadora.
  capsula: {
    eyebrow: "Nossa nova base",
    title: "Da Chapada ao Lago Paranoá.",
    paragraphs: [
      "O Cápsula nasceu do que foi construído na Chapada dos Veadeiros: natureza, música, arte e gente se encontrando sem pressa. Agora essa essência chega às margens do Lago Paranoá, como um refúgio para desacelerar o ritmo da cidade.",
      "É aqui que nasce a nova base da Alma Azul. A experiência começa antes da canoa — na chegada, no pé na areia, na luz que muda sobre a água.",
    ],
    image: {
      desktop: `${IMG}/capsula-lago-por-do-sol-desktop.webp`,
      mobile: `${IMG}/capsula-lago-por-do-sol-mobile.webp`,
      alt: "Cápsula às margens do Lago Paranoá ao pôr do sol, com palmeiras e o píer sobre a água",
      caption: "Cápsula, às margens do Lago Paranoá",
    },
    encounter: {
      title: "Um encontro natural.",
      text: "Dois projetos diferentes, movidos pela mesma vontade de aproximar pessoas, natureza e presença. O Cápsula pela arte, pela música e pela acolhida. A Alma Azul pela água e pelo movimento.",
    },
    details: [
      { src: `${IMG}/capsula-arte-lago.webp`, width: 1000, height: 1400, alt: "Escultura vazada de São Jorge no Cápsula, com o Lago Paranoá ao entardecer ao fundo", caption: "Arte e lago, no mesmo horizonte" },
      { src: `${IMG}/capsula-noite-encontro.webp`, width: 1600, height: 1070, alt: "Pessoas reunidas no pátio de areia do Cápsula à noite, entre árvores iluminadas", caption: "Noite de inauguração do Cápsula" },
    ],
    founder: { eyebrow: "Por trás do Cápsula", name: "Lia Braga", role: "Idealizadora do Cápsula." },
    cta: "Ver as experiências da nova base",
  },
  experiences: {
    title: "Experiências da Concha",
    description: "A programação ainda não está aberta. Estas são as experiências planejadas para a nova base.",
    items: [
      {
        title: "Caminhos do Paranoá",
        summary: "Uma remada para descobrir Brasília por outro ponto de vista.",
        routes: ["Rota Atalaia", "Rota Prainha"],
        image: { src: `${IMG}/experiencia-caminhos-do-paranoa.webp`, alt: "Canoa havaiana da Alma Azul no Lago Paranoá com a Ponte JK ao fundo", position: "50% 62%" },
      },
      {
        title: "Remada do Nascer do Sol",
        summary: "O dia começando devagar, com o sol nascendo sobre o Lago Paranoá.",
        image: { src: `${IMG}/experiencia-remada-do-nascer-do-sol.webp`, alt: "Silhueta de uma canoa havaiana ao nascer do sol no Lago Paranoá", position: "50% 50%" },
      },
      {
        title: "Remada Sunset",
        summary: "As últimas luzes do dia vistas de dentro de uma canoa havaiana.",
        image: { src: `${IMG}/experiencia-remada-sunset.webp`, alt: "Canoa havaiana sob nuvens alaranjadas do pôr do sol no Lago Paranoá", position: "50% 50%" },
      },
      {
        title: "Remada da Lua Cheia",
        summary: "Uma remada noturna guiada pelo ritmo da água e pela luz da lua.",
        image: { src: `${IMG}/experiencia-remada-da-lua-cheia.webp`, alt: "Canoas havaianas no Lago Paranoá com a lua cheia nascendo no horizonte", position: "50% 50%" },
      },
    ],
  },
  paths: {
    eyebrow: "Caminhos do Paranoá",
    title: "Brasília também se descobre pelo lago.",
    description:
      "Uma experiência diurna pensada para a nova base, com diferentes percursos saindo da Concha Acústica. Cada roteiro revela um trecho do Lago Paranoá e uma forma diferente de ver a cidade.",
    // Ambientação geral da experiência: nenhuma destas fotos é de um roteiro específico.
    images: [
      { src: `${IMG}/caminhos-do-paranoa-ambiente-01.webp`, alt: "Canoa havaiana da Alma Azul navegando em um dia de céu azul no Lago Paranoá" },
      { src: `${IMG}/caminhos-do-paranoa-ambiente-02.webp`, alt: "Grupo remando em canoa havaiana sob céu azul no Lago Paranoá" },
    ],
    routes: [
      { title: "Rota Atalaia", description: "Uma remada em direção ao trecho de onde podemos contemplar a região da Pontinha do Atalaia." },
      { title: "Rota Prainha", description: "Remada em direção à região da prainha do Clube do Congresso." },
    ],
    note: "Duração, distância e nível de cada roteiro serão divulgados junto com a programação.",
  },
  closing: {
    title: "Uma nova base está chegando.",
    description: "A programação da Alma Azul na Concha Acústica será anunciada em breve.",
    secondaryLabel: "Ver experiências do Lago Norte",
  },
} as const;
