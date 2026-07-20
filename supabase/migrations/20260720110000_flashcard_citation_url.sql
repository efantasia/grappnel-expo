-- Deep-link for a card's citation. When a card's source is a recorded lecture
-- with a watch URL (YouTube), generate-flashcards resolves the timestamp of the
-- cited excerpt and stores a link to that moment (…&t=<seconds>s), mirroring the
-- study-guide footnotes. NULL for uploaded files (no playable URL to jump into)
-- and documents (no per-page link).
ALTER TABLE public.flashcards
  ADD COLUMN citation_url text;
