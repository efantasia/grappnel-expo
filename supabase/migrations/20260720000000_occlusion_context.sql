-- Image-occlusion "hide all, guess one". When several occlusion cards are built
-- from the SAME figure, each card must also keep the OTHER cards' quizzed labels
-- covered — otherwise a card would reveal the answer to a sibling card (whose
-- label is plainly visible on this card's figure).
--
-- occlusion         = this card's own target box(es); masked in the question,
--                     revealed on the answer (unchanged).
-- occlusion_context = the sibling cards' target box(es) on the same figure;
--                     masked in every state (including the answer) so this card
--                     never gives away another card's answer. NULL when the
--                     figure has only one quizzed label (nothing else to hide).
ALTER TABLE public.flashcards
  ADD COLUMN occlusion_context jsonb;
