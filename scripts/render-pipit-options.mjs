import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

// Pipit explorations: real vector masks keep eyes and wings transparent.
// These are review assets; they do not select or replace the application icon.
const options = [
  {
    id: '01-harbor', name: 'Harbor', note: 'Orijinal Pipit · daha dengeli oranlar', palette: 'Gece mavisi / buz mavisi',
    bg: '#132d4e', ink: '#b4e2ff', paper: '#eff6fc', dark: '#132d4e',
    body: 'M236 523V384Q236 239 384 239H513Q655 239 655 382V406L742 457L655 501V525Q655 687 498 687H397Q236 687 236 523Z',
    tail: 'M248 552L174 634L302 638Z', eye: [561,376,25],
    wing: 'M323 445Q337 587 482 575Q459 465 323 445Z',
  },
  {
    id: '02-apricot', name: 'Apricot', note: 'Daha yuvarlak gövde · kısa gaga', palette: 'Yanık turuncu / kayısı',
    bg: '#713824', ink: '#ffd4a8', paper: '#fff5e9', dark: '#713824',
    body: 'M223 478Q223 245 449 245Q652 245 664 412L743 458L665 502Q649 695 453 695Q274 695 229 559L175 616L217 499Z',
    tail: '', eye: [569,386,26],
    wing: 'M313 433Q290 571 440 605Q474 486 313 433Z',
  },
  {
    id: '03-dusk', name: 'Dusk', note: 'Yukarı bakan baş · yükselen kanat', palette: 'Koyu mor / lavanta',
    bg: '#382852', ink: '#dbc9ff', paper: '#f6f1ff', dark: '#382852',
    body: 'M239 516V389Q239 258 376 258H494Q625 258 644 375L719 326L690 433Q690 654 500 685H399Q239 685 239 516Z',
    tail: 'M256 541L163 604L291 640Z', eye: [563,369,24],
    wing: 'M324 533Q352 408 490 407Q470 566 324 573Z',
  },
  {
    id: '04-berry', name: 'Berry', note: 'Kısa, köşeleri yumuşak gövde · küçük kanat', palette: 'Bordo / pudra pembe',
    bg: '#592a41', ink: '#ffc3d8', paper: '#fff1f6', dark: '#592a41',
    body: 'M226 511V374Q226 265 339 265H538Q657 265 657 384V416L748 463L657 509V565Q657 676 541 676H338Q226 676 226 562Z',
    tail: 'M240 541L161 612L273 622Z', eye: [566,387,24],
    wing: 'M318 439Q322 562 435 573Q458 474 318 439Z',
  },
  {
    id: '05-sunlit', name: 'Sunlit', note: 'Dik duruş · uzun, damla biçimli kanat', palette: 'Koyu zeytin / sıcak sarı',
    bg: '#3e4227', ink: '#f3df90', paper: '#f8f6e8', dark: '#3e4227',
    body: 'M275 545V362Q275 227 407 227H486Q620 227 620 363V395L713 444L620 491V548Q620 705 468 705H428Q275 705 275 545Z',
    tail: 'M291 543L199 645L321 645Z', eye: [540,365,24],
    wing: 'M353 433Q315 573 443 629Q495 501 353 433Z',
  },
  {
    id: '06-lagoon', name: 'Lagoon', note: 'Akıcı kuyruk · daha geniş, yatay siluet', palette: 'Petrol mavisi / açık turkuaz',
    bg: '#16454c', ink: '#a8eee5', paper: '#edf9f7', dark: '#16454c',
    body: 'M224 494Q224 322 380 322H518Q622 322 643 415L731 458L650 500Q632 645 493 663H390Q291 663 245 600L153 628L214 526Z',
    tail: '', eye: [560,421,23],
    wing: 'M319 461Q352 583 485 567Q455 465 319 461Z',
  },
];
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const shape = (o, color = o.ink, prefix = o.id) => {
  const [cx, cy, r] = o.eye;
  return `<defs><mask id="${prefix}" x="0" y="0" width="960" height="960" maskUnits="userSpaceOnUse"><path d="${o.body}" fill="white"/>${o.tail ? `<path d="${o.tail}" fill="white"/>` : ''}<circle cx="${cx}" cy="${cy}" r="${r}" fill="black"/><path d="${o.wing}" fill="black"/></mask></defs><rect width="960" height="960" fill="${color}" mask="url(#${prefix})"/>`;
};
const svg = (content,w=960,h=960) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${content}</svg>`;
const icon = o => `<rect x="32" y="32" width="896" height="896" rx="214" fill="${o.bg}"/>${shape(o)}`;
const render = (source,path,width) => writeFileSync(path,new Resvg(source,{fitTo:{mode:'width',value:width},font:{defaultFontFamily:'Arial'}}).render().asPng());
const dir = 'branding/logos/pipit';
mkdirSync(dir,{recursive:true});
let cards='';
options.forEach((o,i)=>{
  const mark = svg(`<title>Covebird Pipit ${o.name} — transparent vector mark</title>${shape(o,o.dark)}`);
  const appIcon = svg(`<title>Covebird Pipit ${o.name} — app icon concept</title>${icon(o)}`);
  writeFileSync(`${dir}/${o.id}.svg`,mark);
  writeFileSync(`${dir}/${o.id}-icon.svg`,appIcon);
  render(mark,`${dir}/${o.id}.png`,512);
  render(appIcon,`${dir}/${o.id}-icon.png`,512);
  const x=60+(i%3)*568,y=205+Math.floor(i/3)*570;
  cards+=`<g transform="translate(${x} ${y})">
    <rect width="544" height="542" rx="24" fill="${o.paper}"/>
    <text x="28" y="45" fill="${o.dark}" font-size="23" font-weight="700">${String(i+1).padStart(2,'0')} / ${o.name}</text>
    <text x="28" y="75" fill="${o.dark}" opacity=".72" font-size="14">${escape(o.note)}</text>
    <g transform="translate(13 105) scale(.31)">${shape(o,o.dark,`${o.id}-plain`)}</g>
    <g transform="translate(318 149) scale(.20)">${icon({...o,id:`${o.id}-app`})}</g>
    <text x="40" y="409" fill="${o.dark}" font-size="36" font-weight="600" letter-spacing="-1.2">covebird</text>
    <line x1="28" y1="438" x2="516" y2="438" stroke="${o.dark}" opacity=".12"/>
    <circle cx="36" cy="473" r="9" fill="${o.bg}"/><circle cx="62" cy="473" r="9" fill="${o.ink}" stroke="${o.dark}" stroke-opacity=".12"/>
    <text x="84" y="478" fill="${o.dark}" font-size="14">${o.palette}</text>
    <text x="28" y="519" fill="${o.dark}" opacity=".6" font-size="12">24 / 32 / 48 px</text>
    ${[24,32,48].map((size,j)=>`<g transform="translate(${145+j*60} ${500-(size-24)/2}) scale(${size/960})">${shape(o,o.dark,`${o.id}-small-${size}`)}</g>`).join('')}
    </g>`;
});
const board=svg(`<rect width="1800" height="1390" fill="#f1efe9"/><g font-family="Arial, sans-serif">
  <text x="60" y="62" fill="#77766c" font-size="17" letter-spacing="4">COVEBIRD / PIPIT EXPLORATIONS</text>
  <text x="60" y="122" fill="#272d2c" font-size="43" font-weight="700">Aynı kuş ailesi. Altı farklı karakter.</text>
  <text x="60" y="164" fill="#686e68" font-size="18">Yeni siluetler ve renkler · Şeffaf vektör işaret + uygulama ikonu + küçük boyut karşılaştırması</text>
  ${cards}
  <text x="60" y="1366" fill="#77766c" font-size="14">Tüm şekillerin renkleri birbiriyle değiştirilebilir. Henüz nihai logo seçilmedi.</text>
</g>`,1800,1390);
writeFileSync(`${dir}/options.svg`,board);
render(board,`${dir}/options.png`,1800);
console.log('Rendered six Pipit shape/palette alternatives and transparent SVG/PNG exports.');
