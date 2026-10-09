// Line icons on a 24×24 grid, drawn with currentColor (SF-Symbols-like weight).
import { svg } from './dom.js';

// Each icon is a list of [tag, attrs] shapes.
const P = (d) => ['path', { d }];
const C = (cx, cy, r, extra = {}) => ['circle', { cx, cy, r, ...extra }];
const R = (x, y, width, height, rx = 2) => ['rect', { x, y, width, height, rx }];

const ICONS = {
  plus: [P('M12 5v14M5 12h14')],
  minus: [P('M5 12h14')],
  chevronLeft: [P('M15 18l-6-6 6-6')],
  chevronRight: [P('M9 18l6-6-6-6')],
  chevronDown: [P('M6 9l6 6 6-6')],
  close: [P('M18 6L6 18M6 6l12 12')],
  xmark: [P('M18 6L6 18M6 6l12 12')],
  check: [P('M20 6L9 17l-5-5')],
  speaker: [P('M11 5L6 9H2v6h4l5 4V5z'), P('M15.5 8.5a5 5 0 0 1 0 7'), P('M19 5a10 10 0 0 1 0 14')],
  speakerSlash: [P('M11 5L6 9H2v6h4l5 4V5z'), P('M23 9l-6 6M17 9l6 6')],
  lightbulb: [P('M9 18h6M10 22h4'), P('M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z')],
  clipboard: [P('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'), R(8, 2, 8, 4, 1)],
  copy: [R(9, 9, 13, 13, 2), P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  sparkles: [P('M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z'), P('M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z')],
  refresh: [P('M23 4v6h-6'), P('M20.5 15a9 9 0 1 1-2.1-9.4L23 10')],
  trash: [P('M3 6h18'), P('M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'), P('M10 11v6M14 11v6'), P('M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2')],
  share: [P('M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8'), P('M16 6l-4-4-4 4'), P('M12 2v13')],
  download: [P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), P('M7 10l5 5 5-5'), P('M12 15V3')],
  upload: [P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), P('M17 8l-5-5-5 5'), P('M12 3v12')],
  gear: [C(12, 12, 3), P('M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z')],
  book: [P('M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z'), P('M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z')],
  books: [P('M12 2L2 7l10 5 10-5-10-5z'), P('M2 17l10 5 10-5'), P('M2 12l10 5 10-5')],
  sun: [C(12, 12, 4.5), P('M12 1.5v2M12 20.5v2M4.6 4.6L6 6M18 18l1.4 1.4M1.5 12h2M20.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4')],
  calendar: [R(3, 4, 18, 18, 2), P('M16 2v4M8 2v4M3 10h18')],
  flame: [P('M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z')],
  keyboard: [R(2, 5, 20, 14, 2), P('M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16.5h10')],
  arrowRight: [P('M5 12h14M12 5l7 7-7 7')],
  arrowUturnLeft: [P('M9 14L4 9l5-5'), P('M4 9h10.5a5.5 5.5 0 0 1 0 11H11')],
  pencil: [P('M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z')],
  info: [C(12, 12, 10), P('M12 16v-4M12 8h.01')],
  listBullet: [P('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01')],
  circle: [C(12, 12, 10)],
  checkCircle: [C(12, 12, 10), P('M8 12.5l2.5 2.5L16 9.5')],
  xCircle: [C(12, 12, 10), P('M15 9l-6 6M9 9l6 6')],
  eye: [P('M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z'), C(12, 12, 3)],
  eyeSlash: [P('M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94'), P('M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19'), P('M14.12 14.12a3 3 0 1 1-4.24-4.24'), P('M1 1l22 22')],
  headphones: [P('M3 18v-6a9 9 0 0 1 18 0v6'), P('M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z'), P('M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z')],
  quote: [P('M6 8h4v4c0 3-1.5 4.5-4 5'), P('M14 8h4v4c0 3-1.5 4.5-4 5')],
  shuffle: [P('M16 3h5v5'), P('M4 20L21 3'), P('M21 16v5h-5'), P('M15 15l6 6'), P('M4 4l5 5')],
  play: [['path', { d: 'M7 4.5v15l12-7.5z', fill: 'currentColor', 'stroke-width': 1.5 }]],
  search: [C(11, 11, 7.5), P('M21 21l-4.6-4.6')],
  ellipsis: [C(5, 12, 1.2, { fill: 'currentColor' }), C(12, 12, 1.2, { fill: 'currentColor' }), C(19, 12, 1.2, { fill: 'currentColor' })],
  target: [C(12, 12, 10), C(12, 12, 6), C(12, 12, 2)],
  family: [C(12, 5, 2.2), C(5, 19, 2.2), C(19, 19, 2.2), P('M12 7.2v3.8M5 16.8V13h14v3.8M12 11v2')],
  blank: [P('M3 6.5h18M3 12h4.5M16.5 12H21M3 17.5h11'), P('M9.5 13.5h5')],
  cards: [R(3, 7, 13, 14, 2), P('M8 3h11a2 2 0 0 1 2 2v12')],
  textInput: [P('M4 7V5h16v2M9 19h6M12 5v14')],
  mic: [R(9, 2, 6, 12, 3), P('M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8')],
  clock: [C(12, 12, 10), P('M12 6v6l4 2')],
  star: [P('M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z')],
  trophy: [P('M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z'), P('M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3')],
  bolt: [P('M13 2L3 14h9l-1 8 10-12h-9z')],
  moon: [P('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z')],
  link: [P('M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7'), P('M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7')],
  externalLink: [P('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'), P('M15 3h6v6M10 14L21 3')],
  phone: [R(6, 2, 12, 20, 3), P('M11 18h2')],
  homeAdd: [R(3, 3, 18, 18, 4), P('M12 8v8M8 12h8')],
};

export function icon(name, { size = 22, className = '', label } = {}) {
  const shapes = ICONS[name] || ICONS.circle;
  const el = svg(
    'svg',
    {
      class: `icon icon-${name}${className ? ' ' + className : ''}`,
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      'aria-hidden': label ? undefined : 'true',
      role: label ? 'img' : undefined,
      'aria-label': label,
      focusable: 'false',
    },
    shapes.map(([tag, attrs]) => svg(tag, attrs)),
  );
  return el;
}

export const iconNames = Object.keys(ICONS);
