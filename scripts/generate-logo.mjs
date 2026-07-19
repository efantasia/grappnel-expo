// Generates the Grappnel logo / app-icon assets from a single SVG source.
//
// The mark is a grapnel (grappling) hook: Grappnel throws a line into a
// student's course materials and hauls the hard-to-reach ideas back up.
//
// `sharp` rasterises the SVGs. It is NOT a project dependency; install it
// transiently before running:
//   npm install --no-save sharp
//   node scripts/generate-logo.mjs
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Brand palette — mirrors src/constants/theme.ts (primary #5A4FCF).
const VIOLET = '#5A4FCF';
const VIOLET_LIGHT = '#7A6FE8';
const VIOLET_DEEP = '#3E349F';
const INK = '#FFFFFF';

const CX = 512; // canvas centre (x)
const HOOK_CY = 497; // vertical centre of the mark's bounding box

// One fluke (claw arm): sweeps down-and-out from the crown, then the tip
// flares up into a point. `s` = +1 right, -1 left (mirrored across CX).
function fluke(s) {
  const p = (x, y) => `${CX + s * x} ${y}`;
  return [
    `M ${p(0, 596)}`,
    `C ${p(24, 702)} ${p(104, 778)} ${p(178, 768)}`,
    `C ${p(240, 760)} ${p(278, 706)} ${p(258, 644)}`,
  ].join(' ');
}

// The hook mark itself, drawn in absolute 1024-space coordinates.
function hook({ stroke = INK, strokeWidth = 62 } = {}) {
  return `<g fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="${CX}" cy="248" r="80" />
      <path d="M ${CX} 300 L ${CX} 826" />
      <path d="${fluke(-1)}" />
      <path d="${fluke(1)}" />
    </g>`;
}

// Centre + scale the mark inside the 1024 square.
function markGroup({ scale = 0.72, stroke = INK, strokeWidth = 62 } = {}) {
  return `<g transform="translate(${CX} ${CX}) scale(${scale}) translate(${-CX} ${-HOOK_CY})">${hook({ stroke, strokeWidth })}</g>`;
}

const gradient = (id, stops) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">${stops
    .map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`)
    .join('')}</linearGradient>`;

const svg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${inner}</svg>`;

// Square app logo. rounded=true => squircle plate (marketing / web);
// rounded=false => full-bleed square (the source art the OS masks itself).
function squareLogo({ rounded = false } = {}) {
  return svg(`
  <defs>
    ${gradient('bg', [[0, VIOLET_LIGHT], [0.55, VIOLET], [1, VIOLET_DEEP]])}
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#160F3A" flood-opacity="0.30"/>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="${rounded ? 225 : 0}" fill="url(#bg)"/>
  <g filter="url(#sh)">${markGroup({ scale: 0.72 })}</g>`);
}

// Favicon: rounded plate, tighter/bolder mark for small sizes.
function favicon() {
  return svg(`
  <defs>${gradient('bg', [[0, VIOLET_LIGHT], [1, VIOLET_DEEP]])}</defs>
  <rect width="1024" height="1024" rx="220" fill="url(#bg)"/>
  ${markGroup({ scale: 0.66, strokeWidth: 74 })}`);
}

// Transparent hook mark (splash / Android foreground / Android monochrome).
function mark({ scale = 0.86, stroke = INK } = {}) {
  return svg(markGroup({ scale, stroke }));
}

// Solid violet plate for the Android adaptive-icon background layer.
function androidBackground() {
  return svg(`<defs>${gradient('bg', [[0, VIOLET_LIGHT], [0.55, VIOLET], [1, VIOLET_DEEP]])}</defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>`);
}

// iOS Icon Composer symbol layer (square, centred, white).
function iosSymbol() {
  return svg(markGroup({ scale: 0.7 }));
}

async function png(svgStr, out, size) {
  await mkdir(dirname(out), { recursive: true });
  await sharp(Buffer.from(svgStr)).resize(size, size).png().toFile(out);
  console.log('  ', out.replace(ROOT + '/', ''), `${size}²`);
}

async function main() {
  const A = (p) => resolve(ROOT, p);

  console.log('source SVGs → assets/logo/');
  await mkdir(A('assets/logo'), { recursive: true });
  await writeFile(A('assets/logo/grappnel-icon.svg'), squareLogo({ rounded: true }));
  await writeFile(A('assets/logo/grappnel-icon-square.svg'), squareLogo({ rounded: false }));
  await writeFile(A('assets/logo/grappnel-favicon.svg'), favicon());
  await writeFile(A('assets/logo/grappnel-mark.svg'), mark());

  console.log('raster assets → assets/images/');
  await png(squareLogo({ rounded: false }), A('assets/images/icon.png'), 1024);
  await png(favicon(), A('assets/images/favicon.png'), 48);
  await png(mark({ scale: 1.12 }), A('assets/images/splash-icon.png'), 512);
  await png(mark({ scale: 0.82 }), A('assets/images/android-icon-foreground.png'), 512);
  await png(androidBackground(), A('assets/images/android-icon-background.png'), 512);
  await png(mark({ scale: 0.82 }), A('assets/images/android-icon-monochrome.png'), 512);

  console.log('iOS Icon Composer symbol → assets/expo.icon/');
  await writeFile(A('assets/expo.icon/Assets/grappnel-symbol.svg'), iosSymbol());
}

main();
