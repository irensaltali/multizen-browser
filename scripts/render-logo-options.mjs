import { writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

// Original vector concepts. None is selected as the application logo.
const options = [
  { id: '01-shelter', title: '01 / Shelter', subtitle: 'Korunaklı koy + kuş', description: 'Sakin, güven veren, belirgin bir siluet.',
    mark: `<path d="M188 362C227 224 354 144 500 151C616 156 709 222 751 316" fill="none" stroke="currentColor" stroke-width="62" stroke-linecap="round"/>
    <path d="M161 579C307 722 557 744 743 565C662 606 594 605 533 574C483 548 455 505 458 456C462 395 522 355 577 374L630 397L690 395L650 435C648 508 599 569 532 602C407 667 274 643 161 579Z" fill="currentColor"/>` },
  { id: '02-wing', title: '02 / Open Wing', subtitle: 'Açık kanat + ayrı profiller', description: 'Hareketli, teknik ve küçük boyutta net.',
    mark: `<path d="M180 663L313 283Q326 246 359 265L722 463L500 487L405 695L367 504Z" fill="currentColor"/>
    <path d="M368 449L544 414L403 331Z" fill="var(--cutout)"/>
    <path d="M517 534L711 511L466 716Z" fill="currentColor"/>` },
  { id: '03-cove', title: '03 / Cove', subtitle: 'Açık C + ufuk çizgisi', description: 'Minimal, rafine ve tipografiyle uyumlu.',
    mark: `<path d="M670 283A270 270 0 1 0 670 677" fill="none" stroke="currentColor" stroke-width="92" stroke-linecap="round"/>
    <path d="M410 427Q477 420 524 470Q572 406 657 401Q589 441 541 537Q478 467 410 427Z" fill="currentColor"/>
    <path d="M419 616H590" stroke="currentColor" stroke-width="24" stroke-linecap="round"/>` },
  { id: '04-pipit', title: '04 / Pipit', subtitle: 'Karakterli bir kuş simgesi', description: 'Dost canlısı, akılda kalan, uygulamaya özel.',
    mark: `<path d="M240 525V379Q240 233 384 233H522Q660 233 660 379V400L748 455L660 499V527Q660 687 503 687H402Q240 687 240 525Z" fill="currentColor"/>
    <circle cx="568" cy="371" r="27" fill="var(--cutout)"/>
    <path d="M324 438Q339 590 483 577Q463 462 324 438Z" fill="var(--cutout)"/>
    <path d="M248 559L178 631L294 637Z" fill="currentColor"/>` },
];
const renderMark = (mark, ink, cutout) => mark.replaceAll('currentColor', ink).replaceAll('var(--cutout)', cutout);
const svg = (content, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${content}</svg>`;
const png = (source, path, width) => writeFileSync(path, new Resvg(source, { fitTo: { mode: 'width', value: width }, font: { defaultFontFamily: 'Arial' } }).render().asPng());
mkdirSync('branding/logos', {recursive:true});
let cards = '';
options.forEach((o, i) => {
  const source = svg(`<title>Covebird ${o.title} logo concept</title>${renderMark(o.mark, '#153831', '#ffffff')}`, 960, 960);
  writeFileSync(`branding/logos/${o.id}.svg`, source);
  const icon = svg(`<rect x="32" y="32" width="896" height="896" rx="210" fill="#102d27"/>${renderMark(o.mark,'#b6f4d3','#102d27')}`,960,960);
  writeFileSync(`branding/logos/${o.id}-icon.svg`,icon);
  png(icon, `branding/logos/${o.id}-icon.png`,512);
  const x = 64 + (i % 2) * 748, y = 215 + Math.floor(i / 2) * 565;
  cards += `<g transform="translate(${x} ${y})">
    <rect width="716" height="533" rx="24" fill="#ffffff" stroke="#d9ded7"/>
    <text x="32" y="45" font-size="19" font-weight="700" fill="#153831">${o.title}</text>
    <text x="32" y="73" font-size="15" fill="#6a7771">${o.subtitle}</text>
    <g transform="translate(54 104) scale(.28)">${renderMark(o.mark,'#153831','#ffffff')}</g>
    <g transform="translate(409 139) scale(.21)"><rect x="32" y="32" width="896" height="896" rx="210" fill="#102d27"/>${renderMark(o.mark,'#b6f4d3','#102d27')}</g>
    <text x="55" y="401" font-size="40" letter-spacing="-1.5" font-weight="600" fill="#153831">covebird</text>
    <line x1="32" y1="430" x2="684" y2="430" stroke="#e8ebe6"/>
    <text x="32" y="462" font-size="15" fill="#64736b">${o.description}</text>
    <text x="32" y="498" font-size="12" fill="#8b958f">Küçük boyut</text>
    ${[16,24,32].map((s,j)=>`<g transform="translate(${147+j*60} ${482-(s-16)/2}) scale(${s/960})">${renderMark(o.mark,'#153831','#ffffff')}</g>`).join('')}
    <g transform="translate(584 455) scale(.06)">${renderMark(o.mark,'#153831','#ffffff')}</g>
    </g>`;
});
const board = svg(`<rect width="1600" height="1400" fill="#f3f2ec"/><g font-family="Arial, sans-serif">
  <text x="64" y="75" font-size="18" letter-spacing="4" fill="#67786e">COVEBIRD / LOGO EXPLORATIONS</text>
  <text x="64" y="139" font-size="46" font-weight="700" fill="#153831">Dört farklı yön. Tek bağımsız marka.</text>
  <text x="64" y="179" font-size="19" fill="#67786e">Aynı renk ve yazı karakteri: önce sembolü seçelim. Hiçbiri henüz nihai logo değil.</text>
  ${cards}
  <text x="64" y="1370" font-size="14" fill="#67786e">Original SVG concepts / Dark app icon + single-color mark + small-size checks</text>
</g>`,1600,1400);
writeFileSync('branding/logos/options.svg',board);
png(board,'branding/logos/options.png',1600);
console.log('Rendered four Covebird logo concepts; application logo remains a temporary C.');
