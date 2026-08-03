type SupabaseErrorLike = {
  code?: string;
  message?: string;
  name?: string;
  status?: number;
};

export function authErrorDetails(error: unknown) {
  const value = (error && typeof error === "object" ? error : {}) as SupabaseErrorLike;
  return {
    errorCode: value.code ?? "unknown",
    errorName: value.name ?? "unknown",
    errorStatus: value.status ?? null,
  };
}

export function describeAuthFailure(error: unknown): { status: number; message: string } {
  const value = (error && typeof error === "object" ? error : {}) as SupabaseErrorLike;
  const code = value.code?.toLowerCase() ?? "";
  const message = value.message?.toLowerCase() ?? "";

  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return { status: 403, message: "O email desta conta ainda não foi confirmado." };
  }
  if (code === "user_not_found") {
    return { status: 401, message: "Usuário não encontrado no projeto de autenticação configurado." };
  }
  if (code === "invalid_credentials" || message.includes("invalid login credentials")) {
    return {
      status: 401,
      message: "Credenciais recusadas pelo Supabase Auth. Confirme a senha e se a aplicação aponta para o projeto correto.",
    };
  }
  if (code.includes("jwt") || message.includes("api key") || message.includes("jwt")) {
    return { status: 503, message: "A chave pública não corresponde ao projeto Supabase configurado." };
  }
  if (value.status && value.status >= 500) {
    return { status: 503, message: "O Supabase Auth está temporariamente indisponível." };
  }
  return { status: 502, message: "O Supabase Auth recusou o login por um erro não relacionado às credenciais." };
}
