/**
 * Nomes públicos das experiências.
 *
 * O banco guarda o título operacional de cada experiência. Aqui ficam só os
 * ajustes de copy pública, para padronizar a vitrine sem migration: a Concha
 * segue o padrão do Lago Norte ("Remada do Nascer do Sol", "Remada da Lua
 * Cheia"). Sem entrada aqui, o título do banco é usado como está.
 */
const PUBLIC_TITLES: Record<string, string> = {
  "Remada Nascer do Sol": "Remada do Nascer do Sol",
  "Remada Lua Cheia": "Remada da Lua Cheia",
};

export function publicExperienceTitle(title: string) {
  return PUBLIC_TITLES[title] ?? title;
}
