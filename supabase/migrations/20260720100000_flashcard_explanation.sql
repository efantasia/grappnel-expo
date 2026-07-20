-- "Explain" on flashcards. A student can optionally ask for a deeper, grounded
-- explanation of a card's answer while studying. It's generated on demand by
-- the explain-flashcard edge function (RAG over the same materials) and cached
-- here so re-opening the card is instant and costs nothing.
--
-- NULL = not requested yet; text = the cached explanation.
ALTER TABLE public.flashcards
  ADD COLUMN explanation text;
