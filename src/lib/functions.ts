import { FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

export interface InvokeResult<T> {
  data: T | null;
  error: string | null;
}

// Wraps supabase.functions.invoke so callers always get a readable error
// message (edge functions return { error } bodies with non-2xx statuses,
// which supabase-js surfaces as an opaque FunctionsHttpError).
export async function invokeFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<InvokeResult<T>> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return { data: data as T, error: null };

  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json();
      if (payload?.error) return { data: null, error: String(payload.error) };
    } catch {
      // fall through to the generic message
    }
  }
  return { data: null, error: error.message ?? 'Request failed' };
}
