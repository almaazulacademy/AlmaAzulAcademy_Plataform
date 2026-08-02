# Alma Azul Platform

Documento de visão do produto da Alma Azul Academy. Para detalhes técnicos, consulte a [arquitetura](docs/architecture.md), o [banco de dados](docs/database.md) e o [roadmap](docs/roadmap.md).

## Missão

A Alma Azul Platform organiza a descoberta, a escolha e a reserva de experiências na água em uma jornada simples, segura e coerente com a identidade da Alma Azul Academy.

O produto deve aproximar pessoas, movimento e natureza sem transformar a operação cotidiana em um processo complexo para a equipe.

## Problema que resolve

A plataforma reúne em um só lugar:

- apresentação das experiências;
- divulgação de datas e disponibilidade;
- coleta validada dos dados do participante;
- bloqueio temporário de vagas;
- encaminhamento ao pagamento;
- confirmação e recuperação segura da reserva;
- base para a futura operação administrativa.

## Público atendido

- Pessoas interessadas em experiências guiadas no Lago Paranoá e em outros ambientes de atuação da Alma Azul.
- Participantes iniciantes ou recorrentes que precisam encontrar datas, entender a atividade e reservar vagas.
- Equipe operacional da Alma Azul, que futuramente administrará sessões e reservas pelo mesmo sistema.

## Primeira experiência

A **Imersão Paranoá** é a primeira experiência publicada e a primeira usuária do sistema de sessões e reservas. Ela não deve ser tratada como uma exceção arquitetural: `experiences`, `sessions`, componentes e RPCs foram estruturados para receber outras experiências.

## Visão multi-experiências

O catálogo local já apresenta a Imersão Paranoá e antecipa formatos como:

- Remada da Lua Cheia;
- Sunset;
- aulas;
- Team Building;
- outras atividades futuras.

Sunrise e SUP Race aparecem no roadmap de produto, mas ainda não possuem páginas ou registros implementados no código atual.

Uma nova experiência deve reutilizar o mesmo fluxo de sessão, capacidade, pré-reserva, pagamento e acompanhamento. O cadastro de conteúdo, a publicação de uma landing específica e a associação das sessões são responsabilidades separadas.

## Princípios do produto

### Simplicidade

O visitante deve entender a proposta, escolher uma data e avançar sem etapas desnecessárias.

### Conexão com a natureza

Texto, imagem e interação devem preservar o caráter humano e contemplativo da Alma Azul, usando o acervo oficial organizado em `public/images`.

### Operação fácil para a equipe

Regras críticas devem estar centralizadas e auditáveis. O futuro painel não deve duplicar regras que já pertencem ao banco ou aos serviços.

### Experiência premium

Design, conteúdo, responsividade e estados de interface devem transmitir cuidado antes, durante e depois da reserva.

### Segurança

Capacidade e confirmação não podem depender apenas do navegador. Dados pessoais e segredos devem permanecer protegidos; uma reserva nunca pode ser recuperada somente pelo CPF.

### Escalabilidade

Experiências diferentes devem compartilhar contratos e componentes. Adicionar um formato não deve exigir reescrever o motor de reservas.

## Regras de negócio centrais

- Uma sessão pertence a uma experiência.
- Apenas sessões abertas, futuras e com vagas aparecem para reserva.
- Uma pré-reserva bloqueia a quantidade selecionada por 2 horas.
- A disponibilidade é `capacidade - CONFIRMED - PRE_RESERVED ainda válida`.
- Pré-reservas vencidas deixam de contar imediatamente e são marcadas como `EXPIRED` automaticamente pelo cron previsto na migration.
- A confirmação exige pagamento verificado pelo servidor.
- Uma criação usa chave de idempotência para reduzir duplicidade em novas tentativas.
- A recuperação exige CPF válido e código público da reserva.
- CPF não é armazenado em texto simples pela migration: ficam o hash SHA-256 e os quatro últimos dígitos.
- Reservas e eventos de pagamento não têm leitura pública direta.

## Decisões já tomadas

- Next.js 15 com App Router como aplicação web.
- Supabase como banco e camada de RPC/RLS.
- Vercel como destino de deploy.
- InfinitePay como provedor preferencial, atrás da interface `PaymentProvider`.
- Imagens locais servidas com `next/image` sempre que aplicável.
- Server Components para leitura inicial e Client Components somente onde há interação.
- Regra de capacidade e ciclo de vida protegidos no Postgres, não apenas no frontend.
- Estados de reserva: `PRE_RESERVED`, `CONFIRMED`, `EXPIRED` e `CANCELLED`.

## O que não deve ser refeito sem necessidade

- O motor genérico de experiências e sessões não deve ser substituído por lógica específica da Imersão Paranoá.
- O cálculo de vagas não deve ser movido para o frontend.
- O acesso administrativo não deve reutilizar credenciais públicas nem expor a service role.
- A integração de pagamento deve continuar atrás de `PaymentProvider`.
- A identidade visual, o Hero e o acervo organizado não devem ser recriados para cada sprint.
- Novos fluxos não devem contornar RPCs, RLS, idempotência ou validação server-side.

## Estado atual

| Área | Estado |
| --- | --- |
| Home e landing da Imersão Paranoá | Implementado |
| Leitura de sessões e disponibilidade | Implementado no código; depende do Supabase configurado |
| Pré-reserva e ciclo de vida | Implementado no código e na migration; aplicação em produção não confirmada |
| InfinitePay | Camada implementada; credenciais e operação em produção não confirmadas |
| Acompanhamento por CPF + código | Implementado no código; depende do banco configurado |
| Painel administrativo | Implementado no código; exige migration, Supabase Auth e administrador ativo |

## Visão de longo prazo

A plataforma deve evoluir para ser o núcleo operacional da Alma Azul: catálogo de experiências, agenda, reservas, pagamentos, check-in, relacionamento, indicadores e automações. Essa evolução deve acontecer por módulos, preservando a simplicidade do visitante e a segurança da operação.
