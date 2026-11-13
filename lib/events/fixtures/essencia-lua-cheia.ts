/**
 * ESSÊNCIA — 2ª edição · Celebração da Lua Cheia (24/11/2026).
 *
 * Conteúdo editorial no formato exato de `experiences.editorial_content`, com os
 * textos do briefing aprovado pelo Rudah em 13/11/2026 (PR B). Serve à prévia
 * (`/eventos/demonstracao/essencia-lua-cheia`), à prévia do e-mail e aos scripts
 * de cadastro gerados (`pnpm events:edition-sql essencia-lua-cheia`). Nada daqui
 * é gravado no banco nem aparece em Production sem o cadastro autorizado.
 *
 * Nasce com `reservation.comingSoon = true`: publicada, a edição mostra
 * "Reservas abrem em breve" e o servidor recusa reserva até a abertura explícita.
 *
 * Fotos (`public/images/eventos/essencia-lua-cheia/`): as da 1ª edição levam a
 * legenda "Registro da 1ª edição do ESSÊNCIA · 07/11/2026"; as de outras
 * experiências da Alma Azul com pessoas levam o nome da experiência, para não
 * parecerem desta edição. Logos: os oficiais já usados na 1ª edição.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import type { EventEdition } from "../edition.ts";
import { CONCHA_ACUSTICA_LOCATION } from "./essencia.ts";

export const ESSENCIA_LUA_CHEIA_SLUG = "essencia-lua-cheia";

const IMG = "/images/eventos/essencia-lua-cheia";
const FIRST_EDITION = "Registro da 1ª edição do ESSÊNCIA · 07/11/2026";

const HERO = {
  src: `${IMG}/hero-lua-desktop.webp`,
  alt: "Lua cheia nascendo no céu rosado do entardecer sobre o Lago Paranoá, com remadores de colete preparando a canoa havaiana",
  credit: "Remada da Lua Cheia · Alma Azul Academy",
};

export const ESSENCIA_LUA_CHEIA_EDITORIAL = {
  version: 1,
  hero: {
    eyebrow: "Evento especial · 2ª edição",
    title: "ESSÊNCIA",
    subtitle: "Um encontro para celebrar a vida e os novos ciclos.",
    image: HERO,
    primaryCta: { label: "Garantir minha vaga", href: "#reserva" },
    secondaryCta: { label: "Ver a programação", href: "#programacao" },
    details: ["24 de novembro de 2026", "A partir das 15h", "Cápsula Bar · Brasília"],
  },
  quickFacts: [
    { label: "Data", value: "24/11/2026" },
    { label: "Horário", value: "A partir das 15h" },
    { label: "Local", value: "Cápsula Bar" },
    { label: "Ingresso", value: "R$ 150 por pessoa" },
  ],
  about: {
    eyebrow: "Especial de confraternização de fim de ano",
    title: "Um encontro para celebrar a vida e os novos ciclos.",
    paragraphs: [
      "Que tal celebrar a vida, brindar às conquistas e encerrar o ano com boas energias?",
    ],
    image: {
      src: `${IMG}/apresentacao-capsula-entardecer.webp`,
      alt: "Varal de luzes acesas no gramado do Cápsula Bar, com palmeiras e o pôr do sol sobre o Lago Paranoá",
    },
  },
  reservations: {
    eyebrow: "Ingresso único",
    title: "Garanta a sua vaga",
    description: "Superioga, momento de bem-estar, remada ao despertar da Lua Cheia e confraternização com um drink de cortesia, em um único ingresso.",
    image: {
      src: "/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp",
      alt: "Lua cheia nascendo sobre o Lago Paranoá, vista de dentro de uma canoa havaiana à noite",
    },
  },
  seo: {
    title: "ESSÊNCIA — 2ª edição · Celebração da Lua Cheia",
    description: "Superioga, bem-estar com o Cure-se Bem, remada ao despertar da Lua Cheia e confraternização com música no Cápsula Bar, em Brasília. 24 de novembro de 2026, a partir das 15h.",
  },
  event: {
    theme: "dusk",
    badge: "Evento especial · 2ª edição",
    subtitle: "Celebração da Lua Cheia",
    tagline: "Um encontro para celebrar a vida e os novos ciclos.",
    highlights: ["Superioga", "Bem-estar", "Remada ao despertar da Lua Cheia", "Música e brinde"],
    scheduleLabel: "A partir das 15h",
    heroImageMobile: {
      src: `${IMG}/hero-lua-mobile.webp`,
      alt: HERO.alt,
      credit: HERO.credit,
    },
    cardImage: { src: HERO.src, alt: HERO.alt },
    intro: {
      eyebrow: "Especial de confraternização de fim de ano",
      title: "Um encontro para celebrar a vida e os novos ciclos.",
      paragraphs: [
        "Que tal celebrar a vida, brindar às conquistas e encerrar o ano com boas energias?",
        "A segunda edição do ESSÊNCIA chega em uma celebração especial da Lua Cheia, reunindo natureza, movimento, relaxamento, música e alegria.",
        "Uma oportunidade de desacelerar, cuidar de si, reencontrar pessoas queridas e celebrar tudo o que vivemos ao longo deste ano.",
        "Do movimento do corpo à tranquilidade das terapias, da remada contemplativa ao encontro entre amigos: cada momento foi pensado para criar memórias especiais.",
        "Venha viver essa celebração conosco.",
      ],
      image: {
        src: `${IMG}/apresentacao-capsula-entardecer.webp`,
        alt: "Varal de luzes acesas no gramado do Cápsula Bar, com palmeiras e o pôr do sol sobre o Lago Paranoá",
      },
    },
    program: {
      eyebrow: "Programação",
      title: "Do pôr do sol ao despertar da Lua Cheia.",
      imageShape: "portrait",
      items: [
        {
          time: "15:00",
          title: "Recepção e boas-vindas",
          description: "Um momento de acolhimento para iniciar nossa experiência em um ambiente de conexão e boas energias.",
          hosts: [],
          image: {
            src: `${IMG}/recepcao-deck-lago.webp`,
            alt: "Deck do Cápsula Bar de frente para o Lago Paranoá em uma tarde de céu claro",
          },
        },
        {
          time: "15:15",
          title: "Superioga",
          description: "Movimento, energia e conexão com o corpo em uma prática especial para começar nossa jornada de bem-estar.",
          hosts: ["Rapha Dantas"],
          note: "Traga seu próprio tapete.",
          image: {
            src: `${IMG}/superioga-1a-edicao.webp`,
            alt: "Participantes em prática de Superioga sobre tapetes no deck do Cápsula Bar, sob o sol da manhã",
            credit: FIRST_EDITION,
          },
        },
        {
          time: "16:30",
          title: "Momento de Bem-Estar",
          description: "Uma experiência de relaxamento e autocuidado com massagem relaxante ou reflexologia podal, associada aos benefícios dos óleos essenciais. Os atendimentos serão organizados pela equipe do Cure-se Bem, conforme a disponibilidade, sem escolha antecipada de modalidade.",
          hosts: ["Cure-se Bem"],
          image: {
            src: `${IMG}/bem-estar-1a-edicao.webp`,
            alt: "Participante sentada sobre o tapete aplicando óleo essencial nas mãos, durante a aromaterapia",
            credit: FIRST_EDITION,
          },
        },
        {
          time: "17:30",
          title: "Remada Alma Azul · O Despertar da Lua Cheia",
          description: "Uma remada contemplativa pelas águas do Lago Paranoá, acompanhando as cores do pôr do sol e o despertar da Lua Cheia. Um momento de conexão com a natureza, tranquilidade e celebração dos novos ciclos.",
          hosts: ["Alma Azul Academy"],
          note: "Canoa havaiana com colete salva-vidas obrigatório.",
          image: {
            src: `${IMG}/remada-entardecer.webp`,
            alt: "Canoa havaiana com remadores em silhueta sobre o Lago Paranoá, sob nuvens escuras e o céu alaranjado do pôr do sol",
            credit: "Remada Sunset · Alma Azul Academy",
          },
        },
        {
          time: "19:00",
          title: "Música no Cápsula Bar",
          description: "Para encerrar a experiência, um momento de confraternização com música ambiente, boas conversas e um brinde especial à vida, às conquistas e aos novos ciclos.",
          hosts: [],
          note: "Sem cobrança de entrada ou couvert para os participantes.",
          image: {
            src: `${IMG}/musica-capsula-noite.webp`,
            alt: "Pátio do Cápsula Bar à noite, com árvores iluminadas, mesas e pessoas conversando",
          },
        },
      ],
    },
    spotlight: {
      eyebrow: "Um drink para brindar",
      title: "Um brinde aos novos ciclos.",
      paragraphs: [
        "Cada participante recebe 1 drink de cortesia, oferecido pelo Cápsula Bar, para celebrar a vida, as amizades, as conquistas e os novos ciclos.",
        "O drink está incluído no ingresso.",
      ],
      note: "Com ou sem álcool, à sua escolha.",
      image: {
        src: `${IMG}/drink-capsula-neon.webp`,
        alt: "Letreiro luminoso do Cápsula Bar em uma parede de madeira, à noite",
      },
    },
    included: {
      eyebrow: "Ingresso único",
      title: "Tudo o que está incluso.",
      description: "Um único ingresso para viver a tarde completa, do pôr do sol ao despertar da Lua Cheia.",
      items: [
        "Recepção e boas-vindas",
        "Superioga com Rapha Dantas",
        "Momento de Bem-Estar com o Cure-se Bem",
        "Remada contemplativa em canoa havaiana",
        "Confraternização com música ambiente",
        "1 drink de cortesia, com ou sem álcool",
      ],
    },
    partners: {
      eyebrow: "Quem faz acontecer",
      title: "Uma celebração feita a muitas mãos.",
      items: [
        { name: "Alma Azul Academy", role: "Realização · Remada em canoa havaiana", logo: { src: "/images/branding/alma-azul-logo-dark.png", alt: "Logo Alma Azul Academy" } },
        { name: "Cure-se Bem", role: "Realização · Momento de Bem-Estar", logo: { src: "/images/eventos/essencia/logo-cure-se-bem.png", alt: "Logo Cure-se Bem" } },
        { name: "Cápsula Bar", role: "Realização · Local, música e drink de cortesia", logo: { src: "/images/bases/concha-acustica/capsula-bar-logo.webp", alt: "Logo Cápsula Bar" } },
        { name: "Rapha Dantas", role: "Superioga", logo: { src: "/images/eventos/essencia/logo-superioga-rapha-dantas.jpg", alt: "Logo Superioga — Rapha Dantas" } },
      ],
    },
    info: {
      eyebrow: "Antes de ir",
      title: "Informações importantes",
      items: [
        {
          id: "chegada",
          title: "Horário e chegada",
          body: "Recomendamos chegar às 14h50, dez minutos antes do início das atividades.\n\nA recepção começa às 15h00, e a tolerância máxima de chegada será até 15h15.",
        },
        {
          id: "o-que-levar",
          title: "O que levar",
          body: "Tapete próprio para a prática de Superioga, roupas leves e confortáveis, garrafa de água e uma muda de roupa para depois da remada.",
        },
        {
          id: "seguranca",
          title: "Segurança na remada",
          body: "A remada será realizada em canoas havaianas, com acompanhamento da equipe Alma Azul Academy e uso obrigatório de colete salva-vidas.\n\nA realização da atividade na água depende de condições seguras de navegação.",
        },
        {
          id: "drink",
          title: "Um drink para brindar",
          body: "Cada participante recebe 1 drink de cortesia, com ou sem álcool, oferecido pelo Cápsula Bar. O benefício está incluído no ingresso.\n\nA confraternização com música ambiente, a partir das 19h, não tem cobrança adicional de entrada ou couvert para os participantes.",
          email: true,
        },
        {
          id: "clima",
          title: "Condições climáticas",
          body: "Se as condições climáticas impedirem a realização segura das atividades, o evento inteiro será reagendado, e a nova data será comunicada aos participantes.\n\nO evento não é realizado em versão parcial nessas condições.",
        },
        {
          id: "cancelamento",
          title: "Política de cancelamento",
          body: "Você pode solicitar o cancelamento até 22 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para outra experiência da Alma Azul ou reembolso, conforme a política aplicável e os direitos do consumidor.\n\nAs solicitações são atendidas pela nossa equipe, pelos canais oficiais de atendimento.",
        },
      ],
    },
    /** Recepção às 15h00, chegada tolerada até 15h15 (horário de Brasília). */
    arrival: { startTime: "15:00", toleranceUntil: "15:15" },
    /** Prazo inclusivo: até 22/11/2026 12h00 de Brasília (UTC−3). Crédito e reembolso seguem o processo manual. */
    cancellation: { deadline: "2026-11-22T12:00:00-03:00", timeZone: "America/Sao_Paulo", summary: "crédito para outra experiência da Alma Azul ou reembolso, pelo atendimento da nossa equipe" },
    reservation: {
      eyebrow: "Celebre os novos ciclos com a gente",
      title: "Garanta a sua vaga",
      ctaLabel: "Garantir minha vaga",
      maxPerOrder: 6,
      notice: "Traga seu próprio tapete para a prática de Superioga.",
      comingSoon: true,
      image: {
        src: "/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp",
        alt: "Lua cheia nascendo sobre o Lago Paranoá, vista de dentro de uma canoa havaiana à noite",
      },
    },
  },
} as const;

/** 24/11/2026, 15h em Brasília (UTC−3). */
export const ESSENCIA_LUA_CHEIA_STARTS_AT = "2026-11-24T18:00:00.000Z";

/**
 * A 2ª edição no registro de edições. Ainda não cadastrada em produção.
 * Duração técnica de 240 minutos: das 15h ao início da confraternização, às
 * 19h. A página e o e-mail dizem "A partir das 15h" e não anunciam fim.
 */
export const ESSENCIA_LUA_CHEIA_EDITION: EventEdition = {
  slug: ESSENCIA_LUA_CHEIA_SLUG,
  title: "ESSÊNCIA — 2ª edição · Celebração da Lua Cheia",
  summary: "Superioga, bem-estar com o Cure-se Bem, remada ao despertar da Lua Cheia e confraternização com música no Cápsula Bar.",
  baseSlug: "concha-acustica",
  location: CONCHA_ACUSTICA_LOCATION,
  startsAt: ESSENCIA_LUA_CHEIA_STARTS_AT,
  durationMinutes: 240,
  priceCents: 15_000,
  capacity: 24,
  editorial: ESSENCIA_LUA_CHEIA_EDITORIAL,
  registered: false,
};
