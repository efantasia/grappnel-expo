import { createClient, SupabaseClient, User } from 'npm:@supabase/supabase-js@2';

// Service-role client for DB/storage access inside functions. RLS is
// bypassed, so every query MUST filter by the authenticated user's id.
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

// Resolves the calling user from the request's Authorization header.
export async function getRequestUser(req: Request): Promise<User | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    },
  );
  const { data, error } = await client.auth.getUser();
  if (error) return null;
  return data.user;
}
