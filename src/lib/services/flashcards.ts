import { invokeFunction } from '@/lib/functions';
import { ServiceResult } from '@/lib/services/folders';
import { supabase } from '@/lib/supabase';
import { CardType, Flashcard, FlashcardDeck } from '@/lib/types';

// Figure display URLs are shared with study guides; re-exported so existing
// flashcard imports keep working.
export { signFigureUrls } from '@/lib/services/figures';

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
  // How many cards to generate (server clamps to its bounds; defaults to 15).
  count?: number;
  // Which card types are allowed in the mix (defaults to all types server-side).
  cardTypes?: CardType[];
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
      count: input.count,
      card_types: input.cardTypes,
    },
  );
  return { data: data?.deck ?? null, error };
}

// Generates (or returns the cached) deeper explanation of a card's answer,
// grounded in the deck's source materials. Persisted server-side, so the next
// request for the same card is instant.
export async function explainFlashcard(
  cardId: string,
): Promise<ServiceResult<string>> {
  const { data, error } = await invokeFunction<{ explanation: string }>(
    'explain-flashcard',
    { card_id: cardId },
  );
  return { data: data?.explanation ?? null, error };
}

export async function deleteDeck(id: string): Promise<ServiceResult<true>> {
  const { error } = await supabase.from('flashcard_decks').delete().eq('id', id);
  return { data: error ? null : true, error: error?.message ?? null };
}

// Starts an Anki .apkg export (figures embedded, occlusion baked in). Returns
// an export id; poll checkAnkiExport until it's ready, then download the URL.
export async function startAnkiExport(
  deckId: string,
): Promise<ServiceResult<{ export_id: string }>> {
  const { data, error } = await invokeFunction<{ export_id: string }>('export-anki', {
    deck_id: deckId,
  });
  return { data: data ?? null, error };
}

export interface AnkiExportStatus {
  status: 'processing' | 'ready' | 'error';
  url?: string;
  message?: string;
}

export async function checkAnkiExport(
  exportId: string,
  fileName: string,
): Promise<ServiceResult<AnkiExportStatus>> {
  const { data, error } = await invokeFunction<AnkiExportStatus>('check-export', {
    export_id: exportId,
    file_name: fileName,
  });
  return { data: data ?? null, error };
}
