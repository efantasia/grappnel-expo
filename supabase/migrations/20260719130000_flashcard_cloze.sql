-- Cloze-style flashcards. A card is now either:
--   'basic': front = question, back = answer (the original behavior)
--   'cloze': front = a statement with the key term blanked out ("_____"),
--            back = the missing term — a fill-in-the-blank card
-- Existing rows are 'basic'.
--
-- (Image answer-reveal review happens in generate-flashcards, not the schema:
-- an attached figure is dropped if Gemini judges the card's answer visible in
-- the image, so no card ever shows its answer on its own picture.)

ALTER TABLE public.flashcards
  ADD COLUMN type text NOT NULL DEFAULT 'basic'
    CHECK (type IN ('basic', 'cloze'));
