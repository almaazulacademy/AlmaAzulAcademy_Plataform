/**
 * Tradução das falhas do banco em resposta HTTP do painel.
 *
 * Separado de `http.ts` de propósito: aqui não entra nada do Next, o que
 * permite cobrir cada mensagem com o runner nativo do Node, sem subir a
 * aplicação. As RPCs administrativas levantam símbolos curtos e maiúsculos
 * (`INSUFFICIENT_SPOTS`, `SESSION_NOT_OPEN`, ...) e este módulo é o único lugar
 * que decide o status e o texto que o operador lê.
 */

export function adminMutationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CAPACITY_BELOW_OCCUPANCY")) {
    return { status: 409, message: "A capacidade não pode ficar abaixo das vagas já ocupadas." };
  }
  if (message.includes("SESSION_EXPERIENCE_LOCKED")) {
    return { status: 409, message: "A experiência não pode ser alterada depois que a sessão recebe reservas." };
  }
  if (message.includes("SESSION_HAS_RESERVATIONS")) {
    return { status: 409, message: "Sessões com histórico de reservas não podem ser excluídas." };
  }
  if (message.includes("SESSION_ALREADY_ARCHIVED")) {
    return { status: 409, message: "Esta sessão já está arquivada." };
  }
  if (message.includes("SESSION_NOT_ARCHIVED")) {
    return { status: 409, message: "Esta sessão não está arquivada." };
  }
  if (message.includes("SESSION_RESTORE_PAST")) {
    return { status: 409, message: "Não é possível restaurar uma sessão cuja data já passou." };
  }
  if (message.includes("SESSION_RESTORE_CONFLICT")) {
    return { status: 409, message: "Já existe outra sessão ativa da mesma experiência nesse horário." };
  }
  if (message.includes("SESSION_MUST_BE_FUTURE")) {
    return { status: 400, message: "A nova sessão precisa estar no futuro." };
  }
  if (message.includes("RESERVATION_NOT_CONFIRMED")) {
    return { status: 409, message: "Só uma reserva confirmada pode trocar de turma." };
  }
  // Recusa da versão anterior da RPC, que só permitia trocar de turma dentro da
  // mesma experiência. Continua mapeada de propósito: entre publicar o painel e
  // aplicar a migration no Supabase, o banco antigo ainda pode levantá-la, e o
  // operador merece ler o motivo real em vez de um erro genérico.
  if (message.includes("SESSION_EXPERIENCE_MISMATCH")) {
    return {
      status: 409,
      message: "Este banco ainda não permite reagendar entre experiências diferentes. Aplique a migration mais recente do Supabase.",
    };
  }
  if (message.includes("EXPERIENCE_NOT_AVAILABLE")) {
    return { status: 409, message: "Esta experiência não está publicada e não pode receber a reserva." };
  }
  if (message.includes("EXPERIENCE_NOT_FOUND")) {
    return { status: 404, message: "A experiência da turma escolhida não existe mais." };
  }
  if (message.includes("RESERVATION_EXPERIENCE_DESYNC")) {
    return { status: 409, message: "A reserva ficaria vinculada a uma experiência diferente da turma. Nada foi alterado." };
  }
  if (message.includes("SESSION_NOT_OPEN")) {
    return { status: 409, message: "A turma escolhida não está aberta para receber reservas." };
  }
  if (message.includes("SESSION_NOT_FOUND")) {
    return { status: 404, message: "A turma escolhida não existe mais." };
  }
  if (message.includes("SAME_SESSION")) {
    return { status: 409, message: "Esta já é a turma da reserva." };
  }
  if (message.includes("REASON_TOO_LONG")) {
    return { status: 400, message: "Use no máximo 500 caracteres no motivo." };
  }
  if (message.includes("INSUFFICIENT_SPOTS")) {
    return { status: 409, message: "Não há vagas para confirmar essa reserva sem overbooking." };
  }
  if (message.includes("CANCELLED_RESERVATION")) {
    return { status: 409, message: "Uma reserva cancelada não pode ser confirmada." };
  }
  if (message.includes("SESSION_CANCELLED")) {
    return { status: 409, message: "A sessão está cancelada." };
  }
  if (message.includes("duplicate key")) {
    return { status: 409, message: "Já existe um registro com esses dados." };
  }
  if (message.includes("EXPERIENCE_SLUG_EXISTS")) {
    return { status: 409, message: "Já existe uma experiência com esse identificador." };
  }
  if (message.includes("RESERVED_EXPERIENCE_SLUG")) {
    return { status: 409, message: "Esse identificador é reservado pela plataforma." };
  }
  if (message.includes("INCOMPLETE_EDITORIAL_CONTENT")) {
    return { status: 400, message: "Complete o conteúdo editorial obrigatório antes de publicar." };
  }
  if (message.includes("ADMIN_FORBIDDEN")) {
    return { status: 403, message: "Seu acesso administrativo não está ativo." };
  }
  return { status: 500, message: "Não foi possível concluir a operação." };
}
