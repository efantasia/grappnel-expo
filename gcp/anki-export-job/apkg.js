// Builds an Anki .apkg from a set of notes + media. An .apkg is a zip of:
//   - collection.anki2  : a schema-11 SQLite collection (imported by every
//                         Anki version)
//   - media             : JSON mapping "0","1",… -> real filename
//   - 0, 1, 2, …        : the media files (named by their media-map index)
//
// The schema/model/deck/conf JSON below mirrors what genanki (the de-facto
// reference generator) emits, so Anki imports it cleanly. Two built-in-style
// models are provided: Basic (Front/Back) and Cloze (Text/Back Extra).

import { DatabaseSync } from 'node:sqlite';
import { readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

const BASIC_MODEL_ID = 1720000000001;
const CLOZE_MODEL_ID = 1720000000002;
const DECK_ID = 1720000000003;

const CARD_CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}
.cloze { font-weight: bold; color: blue; }
.nightMode .cloze { color: lightblue; }
img { max-width: 100%; }`;

const LATEX_PRE = `\\documentclass[12pt]{article}
\\special{papersize=3in,5in}
\\usepackage[utf8]{inputenc}
\\usepackage{amssymb,amsmath}
\\pagestyle{empty}
\\setlength{\\parindent}{0in}
\\begin{document}
`;
const LATEX_POST = '\\end{document}';

const FIELD = (name, ord) => ({
  name,
  ord,
  sticky: false,
  rtl: false,
  font: 'Arial',
  size: 20,
  media: [],
});

function basicModel(mod) {
  return {
    id: BASIC_MODEL_ID,
    name: 'Grappnel Basic',
    type: 0,
    mod,
    usn: -1,
    sortf: 0,
    did: DECK_ID,
    tmpls: [
      {
        name: 'Card 1',
        ord: 0,
        qfmt: '{{Front}}',
        afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}',
        did: null,
        bqfmt: '',
        bafmt: '',
      },
    ],
    flds: [FIELD('Front', 0), FIELD('Back', 1)],
    css: CARD_CSS,
    latexPre: LATEX_PRE,
    latexPost: LATEX_POST,
    req: [[0, 'any', [0]]],
    tags: [],
    vers: [],
  };
}

function clozeModel(mod) {
  return {
    id: CLOZE_MODEL_ID,
    name: 'Grappnel Cloze',
    type: 1,
    mod,
    usn: -1,
    sortf: 0,
    did: DECK_ID,
    tmpls: [
      {
        name: 'Cloze',
        ord: 0,
        qfmt: '{{cloze:Text}}',
        afmt: '{{cloze:Text}}<br>\n{{Back Extra}}',
        did: null,
        bqfmt: '',
        bafmt: '',
      },
    ],
    flds: [FIELD('Text', 0), FIELD('Back Extra', 1)],
    css: CARD_CSS,
    latexPre: LATEX_PRE,
    latexPost: LATEX_POST,
    req: [],
    tags: [],
    vers: [],
  };
}

function deckJson(name, mod) {
  return {
    id: DECK_ID,
    name,
    mod,
    usn: -1,
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: false,
    browserCollapsed: false,
    desc: '',
    dyn: 0,
    conf: 1,
    extendNew: 0,
    extendRev: 0,
  };
}

const DEFAULT_DECK = {
  id: 1,
  name: 'Default',
  mod: 0,
  usn: 0,
  lrnToday: [0, 0],
  revToday: [0, 0],
  newToday: [0, 0],
  timeToday: [0, 0],
  collapsed: true,
  browserCollapsed: true,
  desc: '',
  dyn: 0,
  conf: 1,
  extendNew: 0,
  extendRev: 0,
};

const DCONF = {
  1: {
    id: 1,
    name: 'Default',
    replayq: true,
    mod: 0,
    usn: 0,
    maxTaken: 60,
    timer: 0,
    autoplay: true,
    lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 1 },
    rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 },
    new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, separate: true, order: 1, perDay: 20, bury: false },
    dyn: false,
  },
};

const SCHEMA_SQL = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null,
  usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null,
  csum integer not null, flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null,
  due integer not null, ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null,
  type integer not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// Anki's note checksum: first 8 hex of sha1(first field, HTML stripped).
function fieldChecksum(field0) {
  const hex = createHash('sha1').update(stripHtml(field0)).digest('hex');
  return parseInt(hex.slice(0, 8), 16);
}

// notes: [{ model: 'basic'|'cloze', fields: [f1, f2], tags?: string[] }]
// media: [{ filename: string, data: Buffer }]
export async function buildApkg({ deckName, notes, media }) {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const dbPath = join(tmpdir(), `col-${nowMs}-${Math.floor(Math.random() * 1e6)}.anki2`);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_SQL);

    const conf = {
      nextPos: notes.length + 1,
      estTimes: true,
      activeDecks: [1],
      sortType: 'noteFld',
      timeLim: 0,
      sortBackwards: false,
      addToCur: true,
      curDeck: DECK_ID,
      newBury: true,
      newSpread: 0,
      dueCounts: true,
      curModel: String(BASIC_MODEL_ID),
      collapseTime: 1200,
    };
    const models = { [BASIC_MODEL_ID]: basicModel(nowSec), [CLOZE_MODEL_ID]: clozeModel(nowSec) };
    const decks = { 1: DEFAULT_DECK, [DECK_ID]: deckJson(deckName, nowSec) };

    db.prepare('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      1, nowSec, nowMs, nowMs, 11, 0, 0, 0,
      JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(DCONF), '{}',
    );

    const insertNote = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const insertCard = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

    notes.forEach((note, i) => {
      const nid = nowMs + i;
      const mid = note.model === 'cloze' ? CLOZE_MODEL_ID : BASIC_MODEL_ID;
      const tags = ` ${(note.tags && note.tags.length ? note.tags : ['grappnel']).join(' ')} `;
      insertNote.run(
        nid,
        randomUUID().replace(/-/g, '').slice(0, 16),
        mid,
        nowSec,
        -1,
        tags,
        note.fields.join('\x1f'),
        stripHtml(note.fields[0]),
        fieldChecksum(note.fields[0]),
        0,
        '',
      );
      // One card per note (we only ever use cloze index c1 -> ord 0).
      insertCard.run(
        nowMs + 100000 + i, nid, DECK_ID, 0, nowSec, -1, 0, 0, i + 1, 0, 0, 0, 0, 0, 0, 0, 0, '',
      );
    });

    db.close();
    const dbBuffer = await readFile(dbPath);

    const zip = new AdmZip();
    zip.addFile('collection.anki2', dbBuffer);
    const mediaMap = {};
    media.forEach((m, i) => {
      mediaMap[String(i)] = m.filename;
      zip.addFile(String(i), m.data);
    });
    zip.addFile('media', Buffer.from(JSON.stringify(mediaMap), 'utf-8'));
    return zip.toBuffer();
  } finally {
    await unlink(dbPath).catch(() => {});
  }
}
