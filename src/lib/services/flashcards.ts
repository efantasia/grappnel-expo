import { invokeFunction } from '@/lib/functions';
import { ServiceResult } from '@/lib/services/folders';
import { supabase } from '@/lib/supabase';
import { Flashcard, FlashcardDeck } from '@/lib/types';

export async function listDecks(): Promise<ServiceResult<FlashcardDeck[]>> {
  const { data, error } = await supabase
    .from('flashcard_decks')
    .select('*')
    .order('created_at', { ascending: false });
  return { data: data as FlashcardDeck[] | null, error: error?.message ?? null };
}

export async function getDeck(id: string): Promise<ServiceResult<FlashcardDeck>> {
  const { data, error } = await supabase
    .from('flashcard_decks')
    .select('*')
    .eq('id', id)
    .single();
  return { data: data as FlashcardDeck | null, error: error?.message ?? null };
}

// Cards in deck order, each with its figure's display metadata (via figure_id).
export async function listCards(deckId: string): Promise<ServiceResult<Flashcard[]>> {
  const { data, error } = await supabase
    .from('flashcards')
    .select('*, material_figures(id, width, height, alt_text, caption)')
    .eq('deck_id', deckId)
    .order('ordinal', { ascending: true });
  return { data: data as Flashcard[] | null, error: error?.message ?? null };
}

export interface GenerateDeckInput {
  topics: string[];
  title?: string;
  folderId?: string | null;
  materialIds?: string[];
}

// Returns immediately with a 'generating' deck row; poll getDeck until the
// status settles (the edge function finishes in the background).
export async function generateFlashcards(
  input: GenerateDeckInput,
): Promise<ServiceResult<FlashcardDeck>> {
  const { data, error } = await invokeFunction<{ deck: FlashcardDeck }>(
    'generate-flashcards',
    {
      topics: input.topics,
      title: input.title,
      folder_id: input.folderId ?? null,
      material_ids: input.materialIds,
    },
  );
  return { data: data?.deck ?? null, error };
}

export async function deleteDeck(id: string): Promise<ServiceResult<true>> {
  const { error } = await supabase.from('flashcard_decks').delete().eq('id', id);
  return { data: error ? null : true, error: error?.message ?? null };
}

// Mints short-lived signed URLs for a set of figures (the bucket is private) so
// the study screen can render card images. Returns a map keyed by figure id.
export async function signFigureUrls(
  figureIds: string[],
): Promise<ServiceResult<Record<string, string>>> {
  if (figureIds.length === 0) return { data: {}, error: null };
  const { data, error } = await invokeFunction<{ urls: Record<string, string> }>(
    'sign-figures',
    { figure_ids: figureIds },
  );
  return { data: data?.urls ?? null, error };
}
