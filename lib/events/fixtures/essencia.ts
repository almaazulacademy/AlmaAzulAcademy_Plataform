/**
 * ESSÊNCIA — Corpo, Mente e Natureza (1ª edição, 07/11/2026).
 *
 * Conteúdo editorial no formato exato de `experiences.editorial_content`: é o
 * que será cadastrado pelo painel na fase de lançamento. Aqui ele serve à
 * prévia de desenvolvimento/Preview (`/eventos/demonstracao`) e aos testes.
 * Nada deste arquivo é gravado no banco nem aparece em Production.
 *
 * Textos e créditos vêm do briefing aprovado e do carrossel oficial. As
 * informações operacionais foram aprovadas em 29/10/2026; a programação fluida,
 * sem horários rígidos de encerramento, em 31/10/2026. A versão cadastrada antes
 * disso está em `scripts/events/essencia-editorial-v1.json`, para o rollback.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import type { BaseLocation } from "../../bases/location.ts";
import type { EventAvailability } from "../presentation.ts";
import type { PublicEvent } from "../public.ts";
import { validateEventEditorial } from "../editorial.ts";

export const ESSENCIA_SLUG = "essencia";

export const ESSENCIA_EDITORIAL = {
  version: 1,
  hero: {
    eyebrow: "Evento especial · 1ª edição",
    title: "ESSÊNCIA",
    subtitle: "Uma manhã para desacelerar, se reconectar e viver o que realmente importa.",
    image: {
      src: "/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp",
      alt: "Canoa havaiana com remadores em silhueta no Lago Paranoá ao nascer do sol",
    },
    primaryCta: { label: "Garantir minha vaga", href: "#reserva" },
    secondaryCta: { label: "Ver a programação", href: "#programacao" },
    details: ["07 de novembro de 2026", "A partir das 05h30", "Cápsula Bar · Brasília"],
  },
  quickFacts: [
    { label: "Data", value: "07/11/2026" },
    { label: "Horário", value: "A partir das 05h30" },
    { label: "Local", value: "Cápsula Bar" },
    { label: "Ingresso", value: "R$ 150 por pessoa" },
  ],
  about: {
    eyebrow: "Uma manhã para sentir",
    title: "Natureza, movimento, respiração e encontros.",
    paragraphs: [
      "Entre o nascer do sol, o movimento das águas e a conexão com o presente, nasce um convite para cuidar de si.",
    ],
    image: {
      src: "/images/bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp",
      alt: "Lago Paranoá visto do Cápsula Bar com o céu colorido",
    },
  },
  reservations: {
    eyebrow: "Ingresso único",
    title: "Garanta a sua vaga",
    description: "Canoa havaiana, meditação, Superioga e lanche saudável em um único ingresso.",
    image: {
      src: "/images/eventos/essencia/capsula-pier-amanhecer.jpg",
      alt: "Píer do Cápsula Bar avançando sobre o Lago Paranoá ao amanhecer",
    },
  },
  seo: {
    title: "ESSÊNCIA — Corpo, Mente e Natureza",
    description: "Uma manhã de canoa havaiana ao nascer do sol, meditação sensorial e Superioga no Cápsula Bar, em Brasília. 07 de novembro de 2026.",
  },
  event: {
    badge: "Evento especial · 1ª edição",
    subtitle: "Corpo, mente e natureza",
    tagline: "Uma manhã para desacelerar, se reconectar e viver o que realmente importa.",
    highlights: ["Canoa havaiana", "Meditação", "Superioga"],
    scheduleLabel: "A partir das 05h30",
    heroImageMobile: {
      src: "/images/bases/concha-acustica/concha-hero-nascer-do-sol-mobile.webp",
      alt: "Canoa havaiana com remadores em silhueta no Lago Paranoá ao nascer do sol",
    },
    cardImage: {
      src: "/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp",
      alt: "Canoa havaiana no Lago Paranoá ao nascer do sol",
    },
    intro: {
      eyebrow: "Uma manhã para sentir",
      title: "Um convite para cuidar de si.",
      paragraphs: [
        "Entre o nascer do sol, o movimento das águas e a conexão com o presente, nasce um convite para cuidar de si.",
        "Uma experiência que reúne natureza, movimento, respiração e encontros especiais em uma manhã pensada para renovar as energias.",
      ],
      image: {
        src: "/images/bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp",
        alt: "Lago Paranoá visto do Cápsula Bar com o céu colorido",
      },
    },
    program: {
      eyebrow: "Programação",
      title: "Do nascer do sol ao encontro.",
      items: [
        {
          time: "05:30",
          title: "Canoa havaiana ao nascer do sol",
          description: "O sol nasce, o lago desperta e cada remada convida você a estar presente.",
          hosts: ["Alma Azul Academy"],
          note: "Não é necessário ter experiência prévia.",
          image: {
            src: "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-02.webp",
            alt: "Canoa havaiana deslizando no Lago Paranoá com o céu alaranjado do amanhecer",
          },
        },
        {
          time: "07:30",
          timeLabel: "Por volta das 07h30",
          title: "Meditação sensorial e aromaterapia",
          description: "Um convite para respirar, sentir e se conectar com o presente. Um diferencial da experiência é a dinâmica de aromaterapia com óleos essenciais, com a participação de Fernanda Garcia.",
          hosts: ["Rapha Dantas", "Fernanda Garcia"],
          image: {
            src: "/images/eventos/essencia/capsula-deck-lago.jpg",
            alt: "Deck do Cápsula Bar de frente para o Lago Paranoá, com árvores e o píer ao fundo",
          },
        },
        {
          timeLabel: "Na sequência",
          title: "Superioga",
          description: "Na sequência da meditação, movimento, força e respiração em uma prática que integra corpo e mente.",
          hosts: ["Rapha Dantas"],
        },
        {
          time: "09:00",
          timeLabel: "Por volta das 09h",
          title: "Happy Hour de Conexões",
          description: "O bem-estar também está nos encontros. Um momento descontraído de integração, troca de experiências e lanche saudável oferecido pela Nutre.",
          hosts: [],
          image: {
            src: "/images/eventos/essencia/capsula-mesas-encontro.jpg",
            alt: "Mesas e cadeiras no espaço aberto do Cápsula Bar",
          },
        },
      ],
    },
    included: {
      eyebrow: "Ingresso único",
      title: "Tudo o que está incluso.",
      description: "Um único ingresso para viver a manhã completa — não é só uma remada nem só uma aula.",
      items: [
        "Canoa havaiana ao nascer do sol",
        "Meditação sensorial com aromaterapia",
        "Superioga",
        "Happy Hour de Conexões",
        "Lanche saudável da Nutre",
      ],
    },
    partners: {
      eyebrow: "Quem faz acontecer",
      title: "Uma manhã feita a muitas mãos.",
      items: [
        { name: "Cure-se Bem", role: "Meditação sensorial com aromaterapia", logo: { src: "/images/eventos/essencia/logo-cure-se-bem.png", alt: "Logo Cure-se Bem" } },
        { name: "Alma Azul Academy", role: "Canoa havaiana ao nascer do sol", logo: { src: "/images/branding/alma-azul-logo-dark.png", alt: "Logo Alma Azul Academy" } },
        { name: "Cápsula Bar", role: "Local do evento", logo: { src: "/images/bases/concha-acustica/capsula-bar-logo.webp", alt: "Logo Cápsula Bar" } },
        { name: "Rapha Dantas", role: "Superioga e meditação sensorial" },
        { name: "Fernanda Garcia", role: "Dinâmica de aromaterapia com óleos essenciais · Cure-se Bem" },
        { name: "Nutre", role: "Parceira de alimentação · lanche saudável", logo: { src: "/images/eventos/essencia/logo-nutre.png", alt: "Logo Nutre" } },
      ],
    },
    info: {
      eyebrow: "Antes de ir",
      title: "Informações importantes",
      items: [
        {
          id: "chegada",
          title: "Horário e chegada",
          body: "Nossa experiência começa às 05h30, no Cápsula Bar, às margens do Lago Paranoá.\n\nRecomendamos chegar com alguns minutos de antecedência para aproveitar cada momento. Haverá tolerância de chegada até às 05h50.\n\nAs práticas terminam aproximadamente entre 08h30 e 09h. Na sequência, acontece o Happy Hour de Conexões.",
        },
        {
          id: "o-que-levar",
          title: "O que levar",
          body: "Venha com roupas confortáveis, adequadas para atividades físicas. Recomendamos trazer garrafa de água, protetor solar e seus itens pessoais.\n\nPara participar da prática de Superioga, traga seu próprio tapete. A organização não disponibilizará tapetes para essa atividade.",
        },
        {
          id: "experiencia",
          title: "Preciso ter experiência anterior?",
          body: "Não! A experiência foi pensada para acolher também quem está começando. Nossa equipe conduzirá as atividades e fornecerá as orientações necessárias.",
        },
        {
          id: "seguranca",
          title: "Segurança durante a remada",
          body: "O uso de colete salva-vidas é obrigatório durante a atividade na água. Antes da saída, nossa equipe apresentará as orientações de segurança.",
        },
        {
          id: "alimentacao",
          title: "Alimentação inclusa",
          body: "O ingresso inclui lanche saudável oferecido pela Nutre, servido no Happy Hour de Conexões, depois das práticas.",
        },
        {
          id: "clima",
          title: "Condições climáticas",
          body: "A segurança e o bem-estar de todos vêm em primeiro lugar. Caso as condições climáticas impeçam a realização segura da experiência, o evento será reagendado e os participantes serão comunicados pela organização.",
        },
        {
          id: "cancelamento",
          title: "Política de cancelamento",
          body: "Você pode solicitar o cancelamento até 5 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe.\n\nApós esse prazo, entre em contato conosco para avaliação do seu caso.",
        },
      ],
    },
    /** Início às 05h30, chegada tolerada até 05h50 (horário de Brasília). */
    arrival: { startTime: "05:30", toleranceUntil: "05:50" },
    /**
     * Prazo inclusivo: pedidos até 05/11/2026 12h00 de Brasília (UTC−3) estão
     * dentro. Nada é automático nesta fase: o crédito para outras experiências
     * chega na fase 5, e o reembolso é pedido pelo WhatsApp oficial e devolvido
     * manualmente pela equipe.
     */
    cancellation: { deadline: "2026-11-05T12:00:00-03:00", timeZone: "America/Sao_Paulo", summary: "crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe" },
    reservation: {
      eyebrow: "Sua próxima pausa tem data marcada",
      title: "Garanta a sua vaga",
      ctaLabel: "Garantir minha vaga",
      maxPerOrder: 6,
      notice: "Traga seu próprio tapete para a prática de Superioga. A organização não disponibilizará tapetes.",
      image: {
        src: "/images/eventos/essencia/capsula-pier-amanhecer.jpg",
        alt: "Píer do Cápsula Bar avançando sobre o Lago Paranoá ao amanhecer",
      },
    },
  },
} as const;

/** Endereço da base Concha Acústica, como cadastrado pela migration `202610080001`. */
export const CONCHA_ACUSTICA_LOCATION: BaseLocation = {
  baseSlug: "concha-acustica",
  baseName: "Cápsula Bar — Concha Acústica",
  meetingPoint: "Em frente ao Cápsula Bar — Concha Acústica",
  address: "SHTN Trecho 1, Lote 8 — Brasília/DF",
  mapsUrl: "https://maps.app.goo.gl/ueSCiLvHAggrzuAX7",
};

/**
 * Vagas previstas para o cadastro do ESSÊNCIA. Só a prévia e os testes usam este
 * número: no site, as vagas vêm sempre de `sessions.capacity` no banco.
 */
export const ESSENCIA_CAPACITY = 24;

/** 07/11/2026, 05h30 em Brasília (UTC−3). */
export const ESSENCIA_STARTS_AT = "2026-11-07T08:30:00.000Z";

export const DEMO_AVAILABILITIES = ["AVAILABLE", "SOLD_OUT", "CLOSED", "ENDED"] as const satisfies readonly EventAvailability[];

/** O ESSÊNCIA como a página o recebe, em qualquer situação de vagas, para a prévia. */
export function essenciaDemoEvent(availability: EventAvailability = "AVAILABLE", remainingSpots = ESSENCIA_CAPACITY): PublicEvent {
  const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
  if (!editorial.success) throw new Error(`Fixture do ESSÊNCIA inválida: ${editorial.errors.join("; ")}`);
  return {
    id: "demonstracao-essencia",
    slug: ESSENCIA_SLUG,
    title: "ESSÊNCIA — Corpo, Mente e Natureza",
    summary: "Canoa havaiana ao nascer do sol, meditação sensorial e Superioga no Cápsula Bar.",
    editorial: editorial.data,
    location: CONCHA_ACUSTICA_LOCATION,
    session: {
      id: null,
      startsAt: ESSENCIA_STARTS_AT,
      durationMinutes: 210,
      priceCents: 15_000,
      remainingSpots: availability === "AVAILABLE" ? remainingSpots : availability === "SOLD_OUT" ? 0 : null,
      availability,
    },
  };
}
