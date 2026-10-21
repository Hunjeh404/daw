// 트랙 이름으로 악기 종류와 색을 정한다.
const CATS = [
  ['backing', /back(ing)?[\s_-]*vo|코러스|chorus|harmon/i, '#8fd3a8'],
  ['vocal', /vo(cal|x)|보컬|lead[\s_-]*vo|sing/i, '#5fbf8f'],
  ['drums', /drum|드럼|kick|snare|hat|cymbal/i, '#d0605e'],
  ['perc', /perc|퍼커/i, '#e07a4f'],
  ['bass', /bass|베이스/i, '#d9a441'],
  ['guitar', /guitar|기타/i, '#6b86e0'],
  ['keys', /piano|피아노|key|건반|organ|rhodes/i, '#a7adb7'],
  ['synth', /synth|신스|pad/i, '#b07fd6'],
  ['strings', /string|스트링|violin|viola|cello|현악/i, '#57b8c9'],
  ['brass', /brass|브라스|trumpet|trombone|horn/i, '#e6c35c'],
  ['wood', /wood|flute|sax|clarinet|목관/i, '#9bbf5f'],
  ['fx', /fx|effect|효과|sfx/i, '#7d8794'],
];
const SPARE = ['#5f8fbf', '#c27aa8', '#7fb8a0', '#c9925f', '#8c86d9', '#6fa3b5'];

export function category(name) {
  for (const [c, re] of CATS) if (re.test(name)) return c;
  return 'other';
}

export function colorFor(name) {
  for (const [, re, col] of CATS) if (re.test(name)) return col;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length];
}
