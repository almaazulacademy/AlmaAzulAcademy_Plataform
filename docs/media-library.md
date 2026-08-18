# Biblioteca de mídia da Alma Azul

Fonte oficial das fotos usadas no site. **Sempre consultar este arquivo antes de
procurar imagens em qualquer outro lugar** — não existe pasta do Google Drive
sincronizada localmente, e não deve ser usada nenhuma imagem externa, de banco de
imagens ou gerada por IA.

## Pastas no Google Drive

| Escopo | Link | ID da pasta |
| --- | --- | --- |
| Pasta principal Alma Azul | https://drive.google.com/drive/folders/18mkunV4wjs7sgDhCRPi2H65WAv8c6QcZ | `18mkunV4wjs7sgDhCRPi2H65WAv8c6QcZ` |
| Imersão Paranoá | https://drive.google.com/drive/folders/1sGxl9avQAqN_4mLqgQZozg6dbEatBkEQ | `1sGxl9avQAqN_4mLqgQZozg6dbEatBkEQ` |
| Remada Sunset | a mapear | — |
| Remada do Nascer do Sol | a mapear | — |
| Remada da Lua Cheia | a mapear | — |

As pastas estão públicas para leitura. Para listar o conteúdo de uma pasta sem
autenticação, usar:

```
https://drive.google.com/drive/folders/<ID_DA_PASTA>
```

A pasta da Imersão Paranoá contém 21 arquivos únicos (JPG, JPEG, HEIC e um DNG) e
21 duplicatas com prefixo `Cópia de`. **Preferir sempre o original, nunca a cópia.**
O `.dng` não deve ser usado diretamente no site.

## Regras

1. Nunca referenciar uma URL do Google Drive no frontend. A imagem tem que ser
   baixada, otimizada e versionada em `public/images/`.
2. O banco guarda apenas o **caminho público** da imagem, dentro de
   `experiences.editorial_content`. Nunca os bytes.
3. Fotos com rosto de cliente claramente reconhecível não vão para o site. O
   critério e o histórico estão em [prelaunch-image-privacy-audit.md](prelaunch-image-privacy-audit.md).
4. Formato de saída: WebP. Nome de arquivo em minúsculas, sem espaços e descritivo.
5. **Originais (HEIC, DNG, JPG de câmera) não ficam em `public/`.** Tudo dentro de
   `public/` é servido publicamente pela web e entra inteiro no deploy. O original
   vive no Google Drive; o repositório guarda apenas o derivado WebP otimizado.
   O histórico Git preserva os originais que já estiveram versionados — nada foi
   apagado do Drive nem reescrito no histórico.

## Originais fora de `public/` (Sprint 6.0)

Até o Sprint 6.0, `public/images/experiences/imersao-paranoa/originals/` guardava
13 arquivos brutos (12 HEIC/JPG e um DNG de 18 MB), somando 68 MB — todos servidos
publicamente e sem nenhuma referência no código, nas migrations ou no conteúdo
editorial. Foram removidos do diretório público.

Para recuperar um original: buscar no Google Drive ou, se necessário, no histórico
Git (`git log --all -- public/images/experiences/imersao-paranoa/originals`).

Ao converter um novo original, o fluxo é: baixar do Drive para fora do repositório,
converter para WebP, versionar **apenas** o WebP em `public/images/`.

## Campos de imagem por experiência

Todos dentro de `experiences.editorial_content` (JSONB):

| Campo | Onde aparece |
| --- | --- |
| `hero.image` | Hero da página individual da experiência |
| `cardImage` | **Somente** o card público na Home / seção de experiências (opcional) |
| `about.image` | Seção "Sobre" da página da experiência |
| `gallery.images[]` | Galeria da página da experiência |
| `reservations.image` | Fundo da seção de reservas |

`cardImage` é opcional. Quando ausente, o card cai para `hero.image` e, em último
caso, para a coluna legada `image_url`. A resolução está em
[`lib/editorial/image.ts`](../lib/editorial/image.ts).

## Registro de seleções

### Imersão Paranoá — card público

| Item | Valor |
| --- | --- |
| Data da seleção | 05/08/2026 |
| Arquivo original no Drive | `IMG_2074.HEIC` |
| ID do arquivo no Drive | `14qqmfQFE6Aqs3u0o-5JLXnT5ivBHHpBW` |
| Arquivo otimizado no projeto | `public/images/experiences/imersao-paranoa/imersao-paranoa-corrego-mata.webp` |
| Dimensões / peso | 2560 × 1920 · 1.645 KB · WebP |
| Onde é usado | Card grande da Imersão Paranoá na Home (`app/page.tsx` → `ExperienceCard`) |
| Campo canônico | `editorial_content -> cardImage` |
| Migration | `supabase/migrations/202608050001_imersao_paranoa_card_image.sql` |
| Substituiu | `/images/backgrounds/hero-alma-azul-lago.webp` (foto aérea da margem aberta do lago) |
| Privacidade | Todos os participantes de costas ou com o rosto fora de enquadramento. Nenhum rosto reconhecível. |
| Motivo da escolha | Canoa já dentro do Córrego do Torto, com a água estreita, mata fechada formando túnel e vegetação abundante nas duas margens — exatamente a leitura de imersão que a experiência vende. Enquadramento horizontal 4:3, com o corredor de água no centro, o que sobrevive bem ao corte largo do desktop e ao corte vertical do mobile. |

O mesmo WebP também é usado como imagem 1 da galeria
(`corredor-corrego-do-torto/img-2074.webp`) e como
`backgrounds/corredor-corrego-do-torto.webp`. Os três arquivos são byte a byte
idênticos; vale consolidar em um único caminho numa limpeza futura.

#### Finalistas descartados

| Arquivo | Por que não |
| --- | --- |
| `IMG_1956.HEIC` | Ótima alternativa — mesma mata fechada, com os remos erguidos. Perde para a `IMG_2074` porque a faixa de água aparece menos e a metade inferior fica mais poluída. |
| `IMG_3617.HEIC` | Vertical (1920 × 2560) e com um participante de perfil no canto inferior esquerdo. |
| `IMG_2069.HEIC` | Vertical e com uma participante voltada para a câmera, rosto reconhecível. |
| `IMG_2725.HEIC` | Vertical, já usada na seção "Nossa essência" da Home, e com uma boia de contenção branca atravessando o enquadramento. |
| `IMG_1129.HEIC` | Trecho aberto do córrego, com céu e nuvens: não entrega a sensação de mata fechada. |
