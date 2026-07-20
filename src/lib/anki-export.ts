// Builds an Anki text-import file (tab-separated) for a flashcard deck. Anki's
// text importer reads per-row directives, so one file can mix note types: we
// emit "Basic" and "Cloze" notes selected by the notetype column.
//
// Format (Anki manual → Importing → Text files):
//   #separator:tab
//   #html:false            -> Anki escapes <, >, & so plain prose renders right
//                             (cloze {{c1::…}} markup is unaffected)
//   #notetype column:1
//   #deck column:2
//   #tags column:5
//   <notetype>\t<deck>\t<field1>\t<field2>\t<tags>
//
// Both note types have two fields, so columns 3-4 map to them: Basic → Front,
// Back; Cloze → Text, Back Extra. Image-occlusion cards export as Basic Q/A —
// text import can't carry the figure or its mask (that needs a .apkg).

import { Flashcard, FlashcardDeck } from '@/lib/types';

function sanitizeField(text: string): string {
  // Tabs/newlines would break the row/column structure.
  return text.replace(/[\t\r\n]+/g, ' ').trim();
}

function sanitizeDeckName(title: string): string {
  // "::" delimits subdecks in Anki; collapse colons so the title stays one
  // subdeck under the "Grappnel" parent.
  return sanitizeField(title).replace(/:+/g, '-') || 'Deck';
}

// Turns a Grappnel cloze ("The _____ is …", answer "X") into Anki cloze markup
// ("The {{c1::X}} is …"). Falls back to appending the cloze if there's no gap.
function toClozeText(front: string, back: string): string {
  const answer = back.trim();
  if (front.includes('_____')) {
    return front.split('_____').join(`{{c1::${answer}}}`);
  }
  return `${front} {{c1::${answer}}}`.trim();
}

export function toAnkiTsv(deck: FlashcardDeck, cards: Flashcard[]): string {
  const deckName = `Grappnel::${sanitizeDeckName(deck.title)}`;
  const tags = 'grappnel';

  const header = [
    '#separator:tab',
    '#html:false',
    '#notetype column:1',
    '#deck column:2',
    '#tags column:5',
  ];

  const rows = cards.map((card) => {
    const source = card.citation ? `Source: ${sanitizeField(card.citation)}` : '';
    let notetype: string;
    let field1: string;
    let field2: string;
    if (card.type === 'cloze') {
      notetype = 'Cloze';
      field1 = sanitizeField(toClozeText(card.front, card.back));
      field2 = source;
    } else {
      notetype = 'Basic';
      field1 = sanitizeField(card.front);
      const back = sanitizeField(card.back);
      field2 = source ? `${back}  (${source})` : back;
    }
    return [notetype, deckName, field1, field2, tags].join('\t');
  });

  return [...header, ...rows].join('\n') + '\n';
}

// A safe download filename for a deck's Anki export.
export function ankiFileName(deckTitle: string): string {
  const slug = deckTitle
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${slug || 'deck'}-anki.txt`;
}
