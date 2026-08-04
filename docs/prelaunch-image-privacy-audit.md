# Auditoria pré-lançamento de privacidade das imagens

Data: 2026-08-04. Escopo: todas as imagens em `public/images`, referências em código, conteúdo editorial canônico, fallbacks `image_url`, campos legados `cover_image`/`gallery`, Home, login e quatro experiências. A análise se limitou à visibilidade de rosto humano reconhecível; não houve reconhecimento facial, associação de nomes ou tentativa de identificar pessoas.

Fontes aprovadas: somente as quatro subpastas da pasta oficial fornecida no Google Drive. Nenhuma imagem foi misturada entre experiências, nenhum rosto foi desfocado e nenhum original foi apagado do Drive.

## Referências públicas e decisão

| Página/seção | Experiência | Caminho final | Classificação | Justificativa |
| --- | --- | --- | --- | --- |
| Home/Hero e Open Graph; Imersão/Hero | Imersão Paranoá | `/images/backgrounds/hero-alma-azul-lago.webp` | manter | Tomada aérea, pessoas sem detalhe facial |
| Home/Sobre | Imersão Paranoá | `/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2725.webp` | manter | Pessoas de costas |
| Home/CTA final | Imersão Paranoá | `/images/experiences/imersao-paranoa/grupos/img-2572.webp` | manter | Grupo de costas |
| Home/card | Todas | `hero.image.src` de cada experiência | manter | Hero voltou a ser a fonte canônica; quatro imagens seguras |
| Login/fallback legado | Imersão Paranoá | `/images/backgrounds/corredor-corrego-do-torto.webp` | manter | Pessoas de costas |
| Imersão/Sobre | Imersão Paranoá | `/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp` | manter | Pessoas de costas |
| Imersão/Galeria 1 | Imersão Paranoá | `/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2074.webp` | manter | Pessoas de costas |
| Imersão/Galeria 2 | Imersão Paranoá | `/images/experiences/imersao-paranoa/lago/alma-azul-original.webp` | substituir | Conteúdo anterior tinha rostos; substituído por `img-1129.webp`, todos de costas |
| Imersão/Galeria 3 | Imersão Paranoá | `/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-1956.webp` | manter | Pessoas de costas |
| Imersão/Galeria 4 e fallback legado anterior | Imersão Paranoá | `/images/experiences/imersao-paranoa/grupos/img-3964.webp` | substituir | Conteúdo anterior tinha rostos; substituído por `img-2389.webp`, todos de costas |
| Imersão/Galeria 5 | Imersão Paranoá | `/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp` | manter | Pessoas de costas |
| Imersão/Galeria 6 | Imersão Paranoá | `/images/experiences/imersao-paranoa/lago/img-4363.webp` | substituir | Conteúdo anterior tinha rostos; substituído por `img-3617.webp`, todos de costas |
| Imersão/Reservas | Imersão Paranoá | `/images/experiences/imersao-paranoa/lago/img-1225.webp` | manter | Silhuetas sem detalhe facial |
| Sunset/Hero e card | Remada Sunset | `/images/experiences/remada-sunset/remada-sunset-hero.webp` | manter | Silhuetas em contraluz |
| Sunset/Sobre | Remada Sunset | `/images/experiences/remada-sunset/remada-sunset-sobre.webp` | manter | Silhuetas e pessoas de costas |
| Sunset/Galeria | Remada Sunset | `remada-sunset-galeria-01.webp` a `05.webp` | manter | Paisagem, distância, costas ou silhueta |
| Sunset/Reservas | Remada Sunset | `/images/experiences/remada-sunset/remada-sunset-reservas.webp` | manter | Pessoas de costas/contraluz |
| Nascer do Sol/Hero e card | Remada do Nascer do Sol | `/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp` | manter | Pessoas de costas em contraluz |
| Nascer do Sol/Sobre | Remada do Nascer do Sol | `/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-sobre.webp` | manter | Pessoas de costas |
| Nascer do Sol/Galeria | Remada do Nascer do Sol | `remada-nascer-do-sol-galeria-01.webp` a `07.webp` | manter | Pessoas distantes, de costas ou paisagem |
| Nascer do Sol/Reservas | Remada do Nascer do Sol | `/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-reservas.webp` | manter | Canoa distante, sem detalhe facial |
| Lua Cheia/Hero e card | Remada da Lua Cheia | `/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp` | manter | Remada noturna, pessoas em silhueta/de costas |
| Lua Cheia/Sobre | Remada da Lua Cheia | `/images/experiences/remada-lua-cheia/remada-lua-cheia-sobre.webp` | substituir | Grupo frontal anterior substituído por `IMG_3406.HEIC`, lua e paisagem sem pessoas |
| Lua Cheia/Galeria 1–5 e fogueira | Remada da Lua Cheia | `remada-lua-cheia-galeria-01.webp` a `05.webp`; `remada-lua-cheia-fogueira.webp` | manter | Paisagem, fogueira, distância, costas ou silhueta |
| Lua Cheia/Galeria 6 | Remada da Lua Cheia | `/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-06.webp` | substituir | Grupo frontal anterior substituído por `IMG_3420.HEIC`, preparação vista de costas |
| Lua Cheia/Galeria 7 | Remada da Lua Cheia | `/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-07.webp` | substituir | Pessoas reconhecíveis anteriores substituídas por `IMG_3457.HEIC`, remadores de costas |
| Lua Cheia/Reservas | Remada da Lua Cheia | `/images/experiences/remada-lua-cheia/remada-lua-cheia-reservas.webp` | manter | Lua, lago e canoa, sem rosto reconhecível |

## Inventário completo de `public/images`

Além das referências acima, estes arquivos foram inspecionados individualmente.

### Manter — marcas e fundos

- `branding/alma-azul-logo-dark.png`, `branding/alma-azul-logo-white.png`, `branding/alma-azul-selo-1.png`, `branding/alma-azul-selo-6.png`: marcas, sem pessoas.
- `backgrounds/corredor-corrego-do-torto.webp`: pessoas de costas.
- `backgrounds/hero-alma-azul-lago.webp`: tomada aérea.

### Manter — Imersão Paranoá, derivados

- `canoas/canoas-navegando.webp`: pessoas de costas; sem referência ativa.
- `corredor-corrego-do-torto/img-1129.webp`: pessoas de costas; fonte da substituição da Galeria 2.
- `corredor-corrego-do-torto/img-1956.webp`: pessoas de costas; Galeria 3.
- `corredor-corrego-do-torto/img-1966.webp`: pessoas de costas; sem referência ativa.
- `corredor-corrego-do-torto/img-2069.webp`: pessoas de costas; sem referência ativa.
- `corredor-corrego-do-torto/img-2074.webp`: pessoas de costas; Galeria 1.
- `corredor-corrego-do-torto/img-2389.webp`: pessoas de costas; fonte da substituição da Galeria 4.
- `corredor-corrego-do-torto/img-2672.webp`: pessoas de costas; Sobre e Galeria 5.
- `corredor-corrego-do-torto/img-2725.webp`: pessoa de costas; Home/Sobre.
- `corredor-corrego-do-torto/img-3617.webp`: pessoas de costas; fonte da substituição da Galeria 6.
- `corredor-corrego-do-torto/img-3977.webp`: pessoas de costas; sem referência ativa após tornar o Hero canônico do card.
- `grupos/img-2572.webp`: pessoas de costas; Home/CTA.
- `lago/img-1225.webp`: silhuetas; Reservas.
- `lago/vista-aerea-lago.webp`: tomada aérea; sem referência ativa.
- `natureza/paisagem-corrego-do-torto.webp`: pessoas de costas; sem referência ativa.
- `lago/alma-azul-original.webp`, `grupos/img-3964.webp`, `lago/img-4363.webp`: manter após substituição segura no próprio caminho, conforme tabela.

### Manter — originais seguros da Imersão

- `originals/aerial-dji-0065.dng`, `originals/img-1129.heic`, `originals/img-1225.heic`, `originals/img-1956.heic`, `originals/img-1966.heic`, `originals/img-2069.heic`, `originals/img-2074.heic`, `originals/img-2389.jpg`, `originals/img-2572.heic`, `originals/img-2672.heic`, `originals/img-2725.heic`, `originals/img-3617.heic`, `originals/img-3977.heic`: paisagem, tomada aérea ou pessoas de costas.

### Manter — Remada Sunset

- `remada-sunset-hero.webp`, `remada-sunset-sobre.webp`, `remada-sunset-reservas.webp`, `remada-sunset-galeria-01.webp`, `remada-sunset-galeria-02.webp`, `remada-sunset-galeria-03.webp`, `remada-sunset-galeria-04.webp`, `remada-sunset-galeria-05.webp`: todos usados e seguros por distância, costas ou silhueta.

### Manter — Remada do Nascer do Sol

- `remada-nascer-do-sol-hero.webp`, `remada-nascer-do-sol-sobre.webp`, `remada-nascer-do-sol-reservas.webp`, `remada-nascer-do-sol-galeria-01.webp`, `remada-nascer-do-sol-galeria-02.webp`, `remada-nascer-do-sol-galeria-03.webp`, `remada-nascer-do-sol-galeria-04.webp`, `remada-nascer-do-sol-galeria-05.webp`, `remada-nascer-do-sol-galeria-06.webp`, `remada-nascer-do-sol-galeria-07.webp`: todos usados e seguros por distância, costas ou contraluz.

### Manter — Remada da Lua Cheia

- `remada-lua-cheia-hero.webp`, `remada-lua-cheia-reservas.webp`, `remada-lua-cheia-fogueira.webp`, `remada-lua-cheia-galeria-01.webp`, `remada-lua-cheia-galeria-02.webp`, `remada-lua-cheia-galeria-03.webp`, `remada-lua-cheia-galeria-04.webp`, `remada-lua-cheia-galeria-05.webp`: todos usados e seguros.
- `remada-lua-cheia-sobre.webp`, `remada-lua-cheia-galeria-06.webp`, `remada-lua-cheia-galeria-07.webp`: manter após substituição segura no próprio caminho.

### Remover do repositório público

| Caminho | Uso | Classificação/justificativa | Substituição |
| --- | --- | --- | --- |
| `backgrounds/banho-no-lago.webp` | Sem uso | remover; rostos frontais reconhecíveis | Não necessária |
| `experiences/imersao-paranoa/corredor-corrego-do-torto/img-2393.webp` | Sem uso | remover; grupo frontal reconhecível | Não necessária |
| `experiences/imersao-paranoa/grupos/img-1255.webp` | Sem uso | remover; rostos frontais próximos | Não necessária |
| `experiences/imersao-paranoa/grupos/img-2514.webp` | Sem uso | remover; rostos frontais/laterais | Não necessária |
| `experiences/imersao-paranoa/grupos/img-3615.webp` | Sem uso | remover; rostos frontais próximos | Não necessária |
| `experiences/imersao-paranoa/lago/img-1148.webp` | Sem uso | remover; grupo frontal reconhecível | Não necessária |
| `experiences/imersao-paranoa/originals/alma-azul-original.jpg` | Sem uso | remover; rostos frontais reconhecíveis | Original preservado no Drive |
| `experiences/imersao-paranoa/originals/img-1148.heic` | Sem uso | remover; grupo frontal reconhecível | Original preservado no Drive |
| `experiences/imersao-paranoa/originals/img-1255.heic` | Sem uso | remover; rostos frontais próximos | Original preservado no Drive |
| `experiences/imersao-paranoa/originals/img-2393.heic` | Sem uso | remover; grupo frontal reconhecível | Original preservado no Drive |
| `experiences/imersao-paranoa/originals/img-2514.heic` | Sem uso | remover; rostos frontais/laterais | Original preservado no Drive |
| `experiences/imersao-paranoa/originals/img-3615.heic` | Sem uso | remover; rostos frontais próximos | Original preservado no Drive |
| `experiences/imersao-paranoa/originals/img-3964.heic` | Sem uso após substituição | remover; rostos frontais próximos | Original preservado no Drive |
| `experiences/imersao-paranoa/originals/img-4363.jpg` | Sem uso após substituição | remover; rostos frontais próximos | Original preservado no Drive |

## Validação visual e responsiva

As quatro páginas foram renderizadas localmente com o mesmo `ExperienceLanding` usado em produção, a partir do conteúdo editorial versionado, sem acesso ou escrita no Supabase. A inspeção cobriu desktop (1440×900), tablet (834×1112) e mobile (390×844). As capturas de evidência ficaram somente em `work/privacy-qa/screens/`, fora do commit.

| Experiência | Galeria | Desktop | Tablet | Mobile | Resultado |
| --- | ---: | --- | --- | --- | --- |
| Imersão Paranoá | 6 itens | aprovado | aprovado | aprovado | Hero e cards legíveis; imagens seguras; sem overflow |
| Remada Sunset | 5 itens | aprovado | aprovado | aprovado | Silhuetas/contraluz; boa composição; sem overflow |
| Remada do Nascer do Sol | 7 itens | aprovado | aprovado | aprovado | Hero e galeria preservados; sem overflow |
| Remada da Lua Cheia | 8 itens | aprovado | aprovado | aprovado | Três substituições seguras; galeria íntegra; sem overflow |

Em todos os 12 cenários, o `scrollWidth` permaneceu dentro do viewport, todos os elementos `img` tinham texto alternativo e não houve erro no console. A checagem estática adicional confirmou 42 referências públicas, zero caminho ausente, zero divergência de capitalização e zero arquivo vazio. As imagens fora do viewport permanecem lazy-loaded por desenho; seus arquivos e referências foram validados separadamente.

## Sincronização e rollback

`202608040003_prelaunch_image_privacy.sql` atualiza de forma idempotente os alts e galerias, torna o Hero seguro o fallback de `image_url`/`cover_image` e sincroniza `gallery` legado quando esse campo existe. As migrations históricas permanecem intactas. Como as seis substituições reutilizam caminhos existentes, não há janela em que o banco aponte para um arquivo removido.

Rollback de código e imagens: restaurar o commit anterior. Rollback editorial: restaurar os valores anteriores em migration aditiva posterior; não reescrever a migration publicada. Os originais continuam no Drive e no histórico Git. Não há item marcado “requer revisão humana”: toda dúvida razoável foi resolvida pela alternativa mais conservadora.
