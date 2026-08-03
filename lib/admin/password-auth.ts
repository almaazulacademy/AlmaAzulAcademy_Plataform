import type { Session, User } from "@supabase/supabase-js";

type SignInResult = {
  data: { user: User | null; session: Session | null };
  error: unknown | null;
};

export type PasswordAuthResult =
  | { state: "SUCCESS"; user: User; session: Session }
  | { state: "AUTH_REJECTED"; error: unknown }
  | { state: "NETWORK_FAILURE"; error: unknown }
  | { state: "MISSING_USER" }
  | { state: "MISSING_SESSION" };

export async function requestPasswordSession(
  signIn: (credentials: { email: string; password: string }) => Promise<SignInResult>,
  email: string,
  password: string,
): Promise<PasswordAuthResult> {
  let result: SignInResult;
  try {
    result = await signIn({ email, password });
  } catch (error) {
    return { state: "NETWORK_FAILURE", error };
  }

  if (result.error) return { state: "AUTH_REJECTED", error: result.error };
  if (!result.data.user) return { state: "MISSING_USER" };
  if (!result.data.session) return { state: "MISSING_SESSION" };
  return { state: "SUCCESS", user: result.data.user, session: result.data.session };
}
