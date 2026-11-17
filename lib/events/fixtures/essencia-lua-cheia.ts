/** Editorial da segunda edição do ESSÊNCIA e modelo dos dados da sessão. */
import type { EventEdition } from "../edition.ts";
import { CONCHA_ACUSTICA_LOCATION } from "./essencia.ts";

export const ESSENCIA_LUA_CHEIA_SLUG = "essencia-lua-cheia";

const TITLE = "ESSÊNCIA — Corpo, Mente e Natureza";
const SUBTITLE = "Celebração da Lua Cheia";
const CALL = "Especial de Confraternização de Fim de Ano!";

const IMG = "/images/eventos/essencia-lua-cheia";
const FIRST_EDITION = "Registro da 1ª edição do ESSÊNCIA · 07/11/2026";

const HERO = {
  src: `${IMG}/hero-lua-desktop.webp`,
  alt: "Lua cheia nascendo no céu rosado do entardecer sobre o Lago Paranoá, com remadores de colete preparando a canoa havaiana",
  credit: "Remada da Lua Cheia · Alma Azul Academy",
};

const RESERVA = {
  src: `${IMG}/reserva-capsula-noite.webp`,
  alt: "Cápsula Bar iluminado à noite, visto do Lago Paranoá, com as luzes refletidas na água e canoas no píer",
};

const INTRO_IMAGE = {
  src: `${IMG}/apresentacao-capsula-entardecer.webp`,
  alt: "Varal de luzes acesas no gramado do Cápsula Bar, com palmeiras e o pôr do sol sobre o Lago Paranoá",
};

export const ESSENCIA_LUA_CHEIA_EDITORIAL = {
  version: 1,
  hero: {
    eyebrow: CALL,
    title: TITLE,
    subtitle: "Que tal celebrar a vida, compartilhar boas energias e receber os novos ciclos?",
    image: HERO,
    primaryCta: { label: "Garantir minha vaga", href: "#reserva" },
    secondaryCta: { label: "Ver a programação", href: "#programacao" },
    details: ["23 de novembro de 2026", "17h15 às 20h30", "Cápsula Bar · Brasília"],
  },
  quickFacts: [
    { label: "Data", value: "23/11/2026" },
    { label: "Horário", value: "17h15 às 20h30" },
    { label: "Local", value: "Cápsula Bar" },
    { label: "Ingresso", value: "R$ 160 por pessoa" },
  ],
  about: {
    eyebrow: "Corpo, mente e natureza",
    title: "Lua Cheia, Movimento e Autocuidado",
    paragraphs: [
      "Um encontro especial de bem-estar, natureza, movimento, autocuidado, educação ambiental e conexão!",
    ],
    image: INTRO_IMAGE,
  },
  reservations: {
    eyebrow: "Ingresso único",
    title: "Garanta a sua vaga",
    description: "Remada, Superioga, lanche saudável, massagem ou reflexologia e educação ambiental em um único ingresso.",
    image: RESERVA,
  },
  seo: {
    title: TITLE,
    description: "Especial de Confraternização de Fim de Ano no Cápsula Bar, em Brasília: remada no Lago Paranoá, Superioga, lanche saudável, massagem ou reflexologia e educação ambiental sobre o Cerrado. 23 de novembro de 2026, das 17h15 às 20h30.",
  },
  event: {
    theme: "dusk",
    badge: CALL,
    subtitle: SUBTITLE,
    tagline: "Que tal celebrar a vida, compartilhar boas energias e receber os novos ciclos?",
    highlights: ["Remada no Lago Paranoá", "Superioga", "Lanche saudável", "Bem-estar e Cerrado"],
    heroImageMobile: {
      src: `${IMG}/hero-lua-mobile.webp`,
      alt: HERO.alt,
      credit: HERO.credit,
    },
    cardImage: { src: HERO.src, alt: HERO.alt },
    intro: {
      eyebrow: "Corpo, mente e natureza",
      title: "Lua Cheia, Movimento e Autocuidado",
      paragraphs: [
        "Um encontro especial de bem-estar, natureza, movimento, autocuidado, educação ambiental e conexão!",
        "Nesta edição especial do ESSÊNCIA, vamos celebrar nossas amizades, conquistas e experiências vividas ao longo do ano, compartilhando bons momentos e agradecendo por tudo que vivemos.",
        "Uma jornada pelas águas do Lago Paranoá, pelo movimento do corpo e pelos momentos de cuidado e conexão com a natureza.",
      ],
      image: INTRO_IMAGE,
    },
    program: {
      eyebrow: "Programação",
      title: "Do fim da tarde ao despertar da Lua.",
      imageShape: "portrait",
      items: [
        {
          time: "17:15",
          title: "Recepção e acolhimento",
          description: "Chegada e preparação para a experiência.",
          hosts: [],
          image: {
            src: `${IMG}/recepcao-deck-lago.webp`,
            alt: "Deck do Cápsula Bar de frente para o Lago Paranoá em uma tarde de céu claro",
          },
        },
        {
          time: "17:30",
          title: "Remada Alma Azul",
          description: "Uma remada ao entardecer no Lago Paranoá e um momento para contemplar o despertar da Lua Cheia, conforme as condições naturais. Não é necessário ter experiência prévia.",
          hosts: ["Alma Azul Academy"],
          note: "Colete salva-vidas obrigatório, inclusive para crianças.",
          image: {
            src: `${IMG}/remada-entardecer.webp`,
            alt: "Canoa havaiana com remadores em silhueta sobre o Lago Paranoá, sob nuvens escuras e o céu alaranjado do pôr do sol",
            credit: "Remada Sunset · Alma Azul Academy",
          },
        },
        {
          time: "18:30",
          title: "Superioga e dinâmica educativa",
          description: "As duas atividades acontecem ao mesmo tempo. A dinâmica é opcional e foi pensada principalmente para crianças e adolescentes, que devem permanecer sob supervisão adequada de seus responsáveis.",
          hosts: [],
          parallel: [
            {
              title: "Superioga",
              description: "Corpo, respiração e presença. Traga seu próprio tapete.",
              hosts: ["Rapha Dantas"],
              image: {
                src: `${IMG}/superioga-1a-edicao.webp`,
                alt: "Participantes em prática de Superioga sobre tapetes no deck do Cápsula Bar",
                credit: FIRST_EDITION,
              },
            },
            {
              title: "Dinâmica educativa sobre a fauna e a flora do Cerrado",
              description: "Enquanto os adultos praticam Superioga, crianças e adolescentes podem explorar e aprender sobre o Cerrado de forma lúdica, com supervisão adequada de seus responsáveis.",
              hosts: ["Instituto Equilibraí", "Fernanda Garcia"],
              image: {
                src: `${IMG}/educacao-ambiental-cerrado.webp`,
                alt: "Mata de galeria do Cerrado acompanhando um córrego, vista do alto, com a paisagem do Distrito Federal ao fundo",
                credit: "Córrego do Torto · Cerrado do Distrito Federal",
              },
            },
          ],
        },
        {
          time: "19:30",
          title: "Lanche saudável",
          description: "Momento de alimentação saudável e convivência, com o lanche da Nutre - DF.",
          hosts: ["Nutre - DF"],
          note: "Incluído no ingresso, sem cobrança adicional.",
          image: {
            src: `${IMG}/lanche-1a-edicao.webp`,
            alt: "Duas mesas amarelas com alimentos, bebidas e produtos à frente dos participantes em prática de yoga no Cápsula Bar",
            credit: FIRST_EDITION,
          },
        },
        {
          time: "19:30",
          timeLabel: "19h30 às 20h30",
          title: "Autocuidado com Cure-se Bem",
          description: "O lanche e os atendimentos começam às 19h30. Escolha entre massagem terapêutica ou reflexologia podal, conforme a disponibilidade dos profissionais.",
          hosts: ["Cure-se Bem"],
          image: {
            src: `${IMG}/bem-estar-1a-edicao.webp`,
            alt: "Participante sentada sobre o tapete aplicando óleo essencial nas mãos, durante a aromaterapia",
            credit: FIRST_EDITION,
          },
        },
      ],
    },
    included: {
      eyebrow: "Ingresso único",
      title: "Tudo o que está incluso.",
      description: "Um único ingresso para viver a experiência completa, do fim da tarde ao despertar da Lua.",
      items: [
        "Recepção e acolhimento",
        "Remada em canoa havaiana, com colete salva-vidas",
        "Superioga com Rapha Dantas",
        "Lanche saudável da Nutre - DF",
        "Massagem terapêutica ou reflexologia podal com o Cure-se Bem, conforme a disponibilidade dos profissionais",
        "Dinâmica educativa opcional sobre o Cerrado, com o Instituto Equilibraí e Fernanda Garcia",
      ],
    },
    partners: {
      eyebrow: "Quem faz acontecer",
      title: "Uma celebração feita a muitas mãos.",
      items: [
        { name: "Alma Azul Academy", role: "Realização · Remada em canoa havaiana", logo: { src: "/images/branding/alma-azul-logo-dark.png", alt: "Logo Alma Azul Academy" } },
        { name: "Cure-se Bem", role: "Realização · Massagem e reflexologia", logo: { src: "/images/eventos/essencia/logo-cure-se-bem.png", alt: "Logo Cure-se Bem" } },
        { name: "Cápsula Bar", role: "Realização · Local do evento", logo: { src: "/images/bases/concha-acustica/capsula-bar-logo.webp", alt: "Logo Cápsula Bar" } },
        { name: "Rapha Dantas", role: "Superioga", logo: { src: "/images/eventos/essencia/logo-superioga-rapha-dantas.jpg", alt: "Logo Superioga — Rapha Dantas" } },
        { name: "Nutre - DF", role: "Lanche saudável", logo: { src: "/images/eventos/essencia/logo-nutre.png", alt: "Logo Nutre - DF" } },
        { name: "Instituto Equilibraí", role: "Dinâmica educativa · fauna e flora do Cerrado, com Fernanda Garcia" },
      ],
    },
    info: {
      eyebrow: "Antes de ir",
      title: "Informações importantes",
      items: [
        {
          id: "chegada",
          title: "Horário e chegada",
          body: "A chegada e a recepção começam às 17h15, no Cápsula Bar, às margens do Lago Paranoá. A tolerância de chegada vai até as 17h30, horário de início da remada. A programação termina às 20h30.",
        },
        {
          id: "o-que-levar",
          title: "O que levar",
          body: "Roupas confortáveis que possam molhar, muda de roupa, toalha, tapete próprio para a Superioga, garrafa de água, repelente e um agasalho leve para a noite.",
        },
        {
          id: "criancas",
          title: "Participação de crianças",
          body: "Crianças são bem-vindas e participam somente acompanhadas por um responsável. A dinâmica educativa é opcional e os menores continuam sob supervisão adequada de seus responsáveis.\n\nCada criança paga o mesmo ingresso (R$ 160) e conta na capacidade total de 24 participantes. Durante a remada, o uso de colete salva-vidas adequado é obrigatório.",
          email: true,
        },
        {
          id: "seguranca",
          title: "Segurança na remada",
          body: "A remada é realizada em canoas havaianas, com acompanhamento da equipe Alma Azul Academy e uso obrigatório de colete salva-vidas para todos os participantes, inclusive crianças, com colete adequado.\n\nA realização da atividade na água depende de condições seguras de navegação.",
        },
        {
          id: "alimentacao",
          title: "Lanche saudável",
          body: "O ingresso inclui o lanche saudável da Nutre - DF, servido às 19h30, sem cobrança adicional.",
        },
        {
          id: "clima",
          title: "Condições climáticas",
          body: "Se as condições climáticas impedirem a realização segura das atividades, o evento inteiro será reagendado — remada, Superioga, lanche saudável, massagem e reflexologia e Educação Ambiental — e a nova data será comunicada aos participantes.\n\nO evento não é realizado em versão parcial nessas condições.",
        },
        {
          id: "cancelamento",
          title: "Política de cancelamento",
          body: "Você pode solicitar o cancelamento até 21 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para outra experiência da Alma Azul Academy ou reembolso, conforme a política aplicável e os direitos do consumidor.\n\nAs solicitações são atendidas pela nossa equipe, pelos canais oficiais de atendimento.",
        },
      ],
    },
    arrival: { startTime: "17:15", toleranceUntil: "17:30" },
    /** Prazo inclusivo: até 21/11/2026 12h00 de Brasília (UTC−3). Crédito e reembolso seguem o processo manual. */
    cancellation: { deadline: "2026-11-21T12:00:00-03:00", timeZone: "America/Sao_Paulo", summary: "crédito para outra experiência da Alma Azul Academy ou reembolso, pelo atendimento da nossa equipe" },
    reservation: {
      eyebrow: "Celebre os novos ciclos com a gente",
      title: "Garanta a sua vaga",
      ctaLabel: "Garantir minha vaga",
      maxPerOrder: 6,
      notice: "Traga seu próprio tapete para a Superioga. Crianças participam somente acompanhadas por um responsável.",
      comingSoon: true,
      image: RESERVA,
    },
  },
} as const;

/** 23/11/2026, 17h15 em Brasília (UTC−3). */
export const ESSENCIA_LUA_CHEIA_STARTS_AT = "2026-11-23T20:15:00.000Z";

/**
 * Modelo da edição. As reservas em produção seguem o estado da sessão no banco.
 */
export const ESSENCIA_LUA_CHEIA_EDITION: EventEdition = {
  slug: ESSENCIA_LUA_CHEIA_SLUG,
  title: TITLE,
  summary: "Especial de Confraternização de Fim de Ano: remada no Lago Paranoá, Superioga, lanche saudável, massagem ou reflexologia e educação ambiental sobre o Cerrado, no Cápsula Bar.",
  baseSlug: "concha-acustica",
  location: CONCHA_ACUSTICA_LOCATION,
  startsAt: ESSENCIA_LUA_CHEIA_STARTS_AT,
  durationMinutes: 195,
  priceCents: 16_000,
  capacity: 24,
  editorial: ESSENCIA_LUA_CHEIA_EDITORIAL,
  registered: true,
};
