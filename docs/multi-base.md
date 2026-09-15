# Arquitetura multi-base

[README](../README.md) · [Arquitetura](architecture.md) · [Banco de dados](database.md)

A Alma Azul deixou de ser uma operação de base única. A hierarquia passa a ser:

```text
Alma Azul
└── Base                (bases)
    └── Experiência     (experiences.base_id)
        └── Sessão      (sessions.experience_id)
            └── Reserva (reservations.session_id + experience_id)
```

Hoje existem duas bases:

| Base | Slug | Status | Observação |
| --- | --- | --- | --- |
| Lago Norte | `lago-norte` | `ACTIVE` | Operação atual. Todo o histórico pertence a ela. |
| Concha Acústica | `concha-acustica` | `COMING_SOON` | Parceria com o Cápsula Bar. Sem sessões, preço ou capacidade. |

## Decisões

### Modality não mistura operação

`modality` só agrupa cards na vitrine. Nenhuma RPC, métrica, sessão, vaga, reserva, receita,
dashboard ou status lê esse campo. Validado em Postgres abrindo artificialmente a Concha num
banco de teste: uma reserva na Sunset·Concha não alterou vagas, sessões, reservas, receita,
ocupação, "mais vendida" nem status da Sunset·Lago Norte.

### A base vem da experiência

`sessions` e `reservations` **não** ganharam coluna de base. A base é sempre derivada:
`reserva → sessão → experiência → base`. Um segundo vínculo poderia divergir do primeiro
(o projeto já precisou de uma trigger para manter `reservations.experience_id` coerente
com a sessão). Sem redundância, não há o que sincronizar — e todo registro antigo virou
Lago Norte só pelo preenchimento de `experiences.base_id`.

Uma consequência é que "Remada Sunset — Lago Norte" e "Remada Sunset — Concha Acústica" são
**experiências diferentes** no banco (slugs `remada-sunset` e `remada-sunset-concha-acustica`),
cada uma com as suas sessões, vagas, reservas e receita. O que as une é
`experiences.modality`, usado só para apresentação.

### Reservar exige base ativa — sem tocar nas RPCs de reserva

`list_open_sessions`, `get_booking_session` e `create_pre_reservation` já exigiam
experiência `PUBLISHED`. A migration acrescenta uma invariante: **uma experiência só pode
ser `PUBLISHED` em base `ACTIVE`** (trigger `experiences_base_requires_active`, erro
`BASE_NOT_ACTIVE`). Uma base só sai de `ACTIVE` sem experiências publicadas
(`bases_status_guard`, erro `BASE_HAS_PUBLISHED_EXPERIENCES`).

Além disso, **sessão só existe em base ativa** (`sessions_base_requires_active`,
`SESSION_BASE_NOT_ACTIVE`): a Concha não pode ter nenhum horário, nem criado pelo painel.

Resultado: nenhum caminho reserva a Concha — nem uma URL manual, nem uma chamada direta à
API, nem uma sessão criada por engano no painel. O fluxo de pagamento, InfinitePay,
confirmação e e-mail não foi alterado.

### Status "em breve"

- Base: `ACTIVE`, `COMING_SOON`, `INACTIVE`.
- Experiência: `DRAFT`, `PUBLISHED`, `COMING_SOON` (novo), `ARCHIVED`.

Uma experiência `COMING_SOON` aparece no catálogo público com o selo **Em breve** e nunca
tem agenda, preço, vagas ou botão de reserva. O selo é um componente único
(`ComingSoonBadge` em `components/bases/badges.tsx`), usado em base, experiência e nos
estados de URL manual.

`price_cents` e `default_capacity` das experiências da Concha ficam em `0` = "ainda não
definido". O painel aceita 0 para rascunho e "em breve", e exige capacidade real para
publicar.

## Banco — `202609150001_multi_base.sql`

Aditiva e idempotente (validada aplicando duas vezes, em instalação limpa e no schema legado
com as 7 colunas de compatibilidade):

- tabela `bases` com RLS (leitura pública só de bases não inativas);
- `experiences.base_id` (obrigatório, backfill Lago Norte), `is_exclusive`, `modality`;
- backfill **explícito** para Lago Norte só do que já existia; `base_id` fica obrigatório e
  **sem valor padrão** — experiência nova sem base é recusada;
- sobrecargas de `admin_create_experience`/`admin_update_experience` com `p_base_id`
  (obrigatório; troca de base só sem sessões);
- sessão só pode ser criada/movida para experiência de base ativa (`SESSION_BASE_NOT_ACTIVE`);
- `modality = slug` por padrão (só apresentação);
- `experiences_status_check` ampliado com `COMING_SOON` — a única constraint trocada,
  sem nenhum valor existente deixar de valer;
- as 4 experiências planejadas da Concha (`on conflict do nothing`);
- RPCs públicas `list_public_bases()`, `list_public_catalog()` e
  `public_session_context(uuid)` — nenhuma devolve preço, capacidade ou dado de reserva;
- RPC administrativa `admin_base_dashboard_metrics(actor, base_id)` — as mesmas métricas de
  `admin_dashboard_metrics` recortadas por base (`null` = todas). A função original segue
  intacta e continua alimentando a visão geral.

Depois de aplicar, rode `supabase/diagnostics/multi_base_postcheck.sql`; a última linha,
`MULTI_BASE_OK`, precisa ficar `OK`.

**Ordem de deploy recomendada: migration primeiro, código depois.**

- Migration aplicada com o código antigo no ar: site, reservas, pagamento e edição de
  experiências continuam funcionando. Só **criar** experiência nova pelo painel antigo falha
  (sem base) — desejado, e só até o deploy.
- Código novo sem a migration: páginas públicas usam o espelho local em
  `lib/bases/catalog.ts`, o dashboard por base avisa que a migration está pendente e o
  cadastro/edição de experiência fica indisponível (a base é obrigatória e ainda não existe).

## Site

| Rota | O que mostra |
| --- | --- |
| `/` | Nova seção "Escolha onde viver a Alma Azul" logo após o Hero, com um card por base. Cards de experiência mostram a base e o selo de exclusividade. |
| `/bases` | Todas as bases visíveis: foto, status, localização, descrição, experiências e CTA. |
| `/bases/[slug]` | Landing da base. Lago Norte: estrutura, galeria, experiências com reserva. Concha: parceria Alma Azul + Cápsula Bar e experiências planejadas, todas em breve. |
| `/experiencias` | Vitrine com filtro `?base=` (Todas · Lago Norte · Concha Acústica). Cada modalidade é um card com uma linha por base, então "Remada Sunset" aparece uma vez com "Base Lago Norte · Ver datas" e "Base Concha Acústica · Em breve". |
| `/experiencias/[slug]` | Inalterada para experiências publicadas, agora com a faixa da base. Slug de experiência em breve mostra uma página explicativa em vez de 404. |
| `/reservar/[sessionId]` | Inalterada. Sessão de experiência/base em breve explica que as reservas não abriram. |

**Navegação:** Experiências · Bases · Sobre · Acompanhar reserva · **Reservar**.
"Reservar" leva para `/agenda`, que só lista turmas com reserva aberta e diz a base de cada
uma — quem já quer reservar não ganha etapa nova. A Imersão Paranoá saiu do menu principal e
passa a ser apresentada como experiência exclusiva da Base Lago Norte.

Nenhuma URL existente mudou. `/imersao-paranoa` continua redirecionando (308).

O conteúdo rico das páginas de base (estrutura, galeria, texto da parceria) fica em
`lib/bases/content.ts`, por slug. Uma base nova sem entrada ali ganha uma página montada só
com os campos do banco.

## Painel

```text
Dashboard
├── Visão geral       /admin                     (números consolidados + desempenho por base)
├── Lago Norte        /admin/bases/lago-norte
└── Concha Acústica   /admin/bases/concha-acustica
```

- A visão geral mantém todos os indicadores atuais e ganha a comparação entre bases.
- Cada dashboard de base mostra faturamento, reservas, pré-reservas, cancelamentos,
  participantes, ocupação, próximas sessões, experiências da base e atalhos filtrados.
  Base sem operação mostra "Nenhuma sessão cadastrada ainda." — sem erro e sem número inventado.
- Sessões e Reservas ganharam o filtro **Base** (`?base=lago-norte`), aplicado pela
  experiência. Os selects de experiência mostram "Título · Base" para diferenciar modalidades
  repetidas.
- Experiências mostram a base e a exclusividade, e aceitam o status **Em breve**.

## Bloqueadores antes de ativar a Concha Acústica

Nenhum destes impede esta entrega (a Concha não recebe reservas). **Todos** precisam estar
resolvidos antes de a base passar para `ACTIVE`.

1. **Local de encontro por base (e-mail e comunicações).** `MEETING_LOCATION` em
   `lib/reservations/confirmation-email.ts` é fixo no Lago Norte. Endereço/ponto de encontro
   do e-mail de confirmação, da tela de retorno do pagamento, do acompanhamento de reserva e
   de qualquer mensagem precisa vir da base da sessão da reserva (`bases.address`).
2. **Base no Google Sheets.** A integração (`lib/integrations/google-sheets/`) não exporta a
   base. Reservas, sessões, vagas e lista da sessão precisam ganhar a coluna de base.
3. **Mídia real.** Trocar as fotos temporárias do Lago Norte (lista em
   `TEMPORARY_BASE_MEDIA`, `lib/bases/media.ts`) pelo acervo da Concha/Cápsula Bar.
4. **Dados operacionais das experiências.** Preço, capacidade padrão, duração e conteúdo
   editorial completo de cada experiência da Concha (hoje `0` = não definido).
5. **Endereço da base.** Preencher `bases.address` da Concha (hoje vazio).

## Como abrir a Concha Acústica (depois dos bloqueadores)

1. Base para `ACTIVE`: `update public.bases set status = 'ACTIVE' where slug = 'concha-acustica';`
   Antes disso o banco recusa publicar experiência e criar sessão nessa base.
2. Publicar as experiências pelo painel (status Ativa).
3. Criar as sessões.
4. Conferir e-mail, planilha e a página da base com uma reserva de teste.

## Mídia: base × experiência

- **Mídia da base (espaço):** `public/images/bases/<slug>/` e `public/videos/bases/<slug>/`.
  Entra em `space.items` de `lib/bases/content.ts` (seção "O espaço", que só aparece com
  itens), em `heroImage` e em `bases.image_url` (card da base). Aceita fotos e vídeos locais.
- **Mídia da experiência:** `public/images/experiences/<experience-slug>/`, referenciada por
  `experiences.image_url` e `editorial_content`. Ex.: `remada-sunset-concha-acustica/`.
- Sem banco de imagens nem URL externa. Mídia de base só aceita caminho local
  (`isLocalBaseMedia`).
- Foto temporária mostra o selo "Imagem ilustrativa". Ao trocar o arquivo, remova o caminho de
  `TEMPORARY_BASE_MEDIA` e o selo some.

## Pendências menores

- **Edição de bases no painel:** bases são cadastradas e editadas por SQL.
- **Base de uma experiência** é escolhida no painel e fica travada depois da primeira sessão
  (`EXPERIENCE_BASE_LOCKED`): sessões, reservas e receita pertencem à base onde aconteceram.
- **Slug:** o painel gera o slug pelo nome. Uma segunda "Remada Sunset" em outra base precisa de
  nome diferente no cadastro (o slug é único), ou ser semeada por migration, como a Concha.
- Páginas estáticas (`/acompanhar-reserva`, 404) leem as bases do rodapé no build; mudar o
  status de uma base atualiza essas duas no próximo deploy.
- Uma sessão só troca de experiência pelo painel (`admin_update_session`, que recusa com
  reservas). Um `UPDATE` direto por SQL não é bloqueado — comportamento anterior a esta mudança.

## Roteiros — Caminhos do Paranoá (desenho para depois)

Não foi implementado nesta etapa, para não criar schema sem uso. A forma recomendada:

```sql
create table public.experience_routes (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references public.experiences(id) on delete restrict,
  slug text not null,              -- rota-atalaia, rota-prainha
  name text not null,              -- Rota Atalaia
  description text not null default '',
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  display_order integer not null default 0,
  unique (experience_id, slug)
);

alter table public.sessions
  add column route_id uuid references public.experience_routes(id) on delete restrict;
```

- O roteiro é **opcional por sessão**: sessões sem `route_id` continuam como hoje.
- Uma trigger deve garantir que `sessions.route_id` pertença à mesma experiência da sessão.
- `list_open_sessions`, `get_booking_session`, `admin_list_sessions` e o e-mail passam a
  devolver `route_name`; reservas continuam sem coluna própria (o roteiro vem da sessão),
  seguindo a mesma regra que evita redundância com a base.
- Na interface, o roteiro aparece como um detalhe da turma ("Caminhos do Paranoá · Rota
  Atalaia"), não como uma experiência separada.
