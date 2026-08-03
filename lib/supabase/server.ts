import { createClient } from "@supabase/supabase-js";
import { createSupabaseAuthFetch } from "@/lib/supabase/auth-fetch";

function publicSupabaseConfiguration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const key = publishableKey || anonKey;

  if (!url || !key || url.includes("your-project")) return null;
  return { url, key, keyKind: publishableKey ? "publishable" : "anon" } as const;
}

export function getSupabaseAuthConfigurationSummary() {
  const configuration = publicSupabaseConfiguration();
  if (!configuration) return { configured: false, projectRef: null, keyKind: null };
  let projectRef: string | null = null;
  try {
    projectRef = new URL(configuration.url).hostname.split(".")[0] || null;
  } catch {
    return { configured: false, projectRef: null, keyKind: configuration.keyKind };
  }
  return { configured: true, projectRef, keyKind: configuration.keyKind };
}

export function getSupabaseServerClient() {
  const configuration = publicSupabaseConfiguration();
  if (!configuration) return null;

  return createClient(configuration.url, configuration.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createSupabaseAuthFetch() },
  });
}

export function getSupabaseUserClient(accessToken: string) {
  const configuration = publicSupabaseConfiguration();
  if (!configuration || !accessToken) return null;

  return createClient(configuration.url, configuration.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: createSupabaseAuthFetch(),
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

export function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey || url.includes("your-project")) return null;

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
