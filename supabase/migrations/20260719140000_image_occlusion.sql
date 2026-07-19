-- Image-occlusion cloze cards: a label on a figure is masked and the student
-- has to name it (the mask is the "blank"). Figures now carry the labels +
-- bounding boxes Gemini detected at extraction time; an occlusion card records
-- which region(s) to mask.

-- material_figures.labels: [{ "text": "Loop of Henle", "box": [x, y, w, h] }, …]
-- where x,y,w,h are fractions (0-1) of the figure's own width/height, so the
-- client can position masks over the stored image at any display size.
ALTER TABLE public.material_figures
  ADD COLUMN labels jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Add the new card type.
ALTER TABLE public.flashcards
  DROP CONSTRAINT flashcards_type_check;
ALTER TABLE public.flashcards
  ADD CONSTRAINT flashcards_type_check
  CHECK (type IN ('basic', 'cloze', 'image_occlusion'));

-- occlusion: array of [x, y, w, h] boxes (same fraction coords as labels) to
-- mask on the card's figure; NULL for non-occlusion cards. The masked label is
-- the card's answer (back).
ALTER TABLE public.flashcards
  ADD COLUMN occlusion jsonb;
