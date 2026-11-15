// monitor_inventario_cliente.js - rastreio SOMENTE LEITURA de eventos de inventario/RPC no cliente.
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[invtrace-cliente] ' + Date.now() + ' ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) {
  try {
    const b = pool.add(0x10).add((i >>> 16) * 8).readPointer();
    const e = b.add((i & 0xffff) * 2), h = e.readU16(), l = h >>> 6;
    return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l);
  } catch (e) { return '?'; }
}
function nome(o) { try { return fn(o.add(0x18).readU32()); } catch (e) { return '?'; } }
function classe(o) { try { return nome(o.add(0x10).readPointer()); } catch (e) { return '?'; } }
function flagsTxt(o) {
  try {
    const f = o.add(0xb0).readU32(), a = [];
    if (f & 0x40) a.push('NET');
    if (f & 0x80) a.push('RELIABLE');
    if (f & 0x200000) a.push('SERVER');
    if (f & 0x1000000) a.push('CLIENT');
    if (f & 0x4000) a.push('MULTICAST');
    if (f & 0x800) a.push('EVENT');
    if (f & 0x400) a.push('NATIVE');
    return '0x' + (f >>> 0).toString(16) + (a.length ? '[' + a.join('|') + ']' : '');
  } catch (e) { return '?'; }
}
function fstr(p) {
  try {
    const d = p.readPointer(), n = p.add(8).readS32();
    if (d.isNull() || n <= 0 || n > 4000) return '';
    return d.readUtf16String(n - 1);
  } catch (e) { return '?'; }
}
function arrStr(p) {
  const r = [];
  try {
    const d = p.readPointer(), n = p.add(8).readS32();
    if (n < 0 || n > 600) return r;
    for (let i = 0; i < n; i++) r.push(fstr(d.add(i * 16)));
  } catch (e) {}
  return r;
}
function curto(a) { return a.map(s => s.replace(/;[^!]*/, '')).join(' | ').slice(0, 1600); }

const FN_RE = /(inventory|inventario|item|stash|cash|loot|pickup|drop|equip|container|backpack|storage|sharpsync|collect|consume|slot|chest|bag)/i;
const CLASS_RE = /(sharpsync|inventory|stash|loot|container|survpc|survivalplayer|item)/i;
const ACTION_RE = /(add|remove|move|update|load|save|pickup|drop|equip|use|collect|consume|set|server|client|multicast|sync|transfer|store|interact)/i;
const MAX = 256;
const porPtr = new Map();
const alvos = Memory.alloc(MAX * 8), nAlvos = Memory.alloc(8); nAlvos.writeS32(0);
let chamadas = 0, logCalls = 0;
const ultima = new Map();

const notify = new NativeCallback(function (obj, f, parms) {
  try {
    const meta = porPtr.get(f.toString());
    if (!meta) return;
    const chave = f.toString() + '|' + obj.toString(), agora = Date.now();
    if (agora - (ultima.get(chave) || 0) < 350) return;
    ultima.set(chave, agora);
    chamadas++;
    if (logCalls >= 300) return;
    logCalls++;
    if (meta.nome === 'UpdateData' || meta.nome === 'UpdateStash') {
      const lista = arrStr(parms);
      log('CALL ' + meta.qual + ' flags=' + meta.flags + ' n=' + lista.length + ' [' + curto(lista) + ']');
    } else {
      let objDesc = '?';
      try { objDesc = classe(obj) + '/' + nome(obj); } catch (e) {}
      log('CALL ' + meta.qual + ' flags=' + meta.flags + ' obj=' + objDesc + ' parms=' + parms);
    }
  } catch (e) { log('erro na chamada: ' + e); }
}, 'void', ['pointer', 'pointer', 'pointer']);

const cm = new CModule([
  '#include <gum/guminterceptor.h>',
  'extern void notify (void * obj, void * fn, void * parms);',
  'extern void * alvos[256];',
  'extern int nalvos;',
  'void onEnter (GumInvocationContext * ic) {',
  '  void * f = gum_invocation_context_get_nth_argument (ic, 1);',
  '  int i;',
  '  for (i = 0; i < nalvos; i++) if (alvos[i] == f) {',
  '    notify (gum_invocation_context_get_nth_argument (ic, 0), f, gum_invocation_context_get_nth_argument (ic, 2));',
  '    return;',
  '  }',
  '}'
].join('\n'), { notify: notify, alvos: alvos, nalvos: nAlvos });

Interceptor.attach(B.add(0x24077b0), cm);

function scan() {
  const g = B.add(0x7ccda10), objs = g.readPointer(), num = g.add(0x14).readS32(), nch = g.add(0x1c).readS32();
  let novos = 0;
  for (let i = 0; i < num; i++) {
    const ch = (i / 0x10000) | 0; if (ch >= nch) break;
    try {
      const chunk = objs.add(ch * 8).readPointer(); if (chunk.isNull()) continue;
      const o = chunk.add((i % 0x10000) * 0x18).readPointer();
      if (o.isNull() || classe(o) !== 'Function') continue;
      const nf = nome(o), outer = o.add(0x20).readPointer(); if (outer.isNull()) continue;
      const cls = nome(outer);
      if (!(FN_RE.test(nf) || (CLASS_RE.test(cls) && ACTION_RE.test(nf)))) continue;
      const k = o.toString(); if (porPtr.has(k)) continue;
      const n = nAlvos.readS32(); if (n >= MAX) break;
      const flags = flagsTxt(o);
      alvos.add(n * 8).writePointer(o); nAlvos.writeS32(n + 1);
      porPtr.set(k, { qual: cls + '.' + nf, nome: nf, flags: flags });
      log('ALVO ' + cls + '.' + nf + ' flags=' + flags);
      novos++;
    } catch (e) {}
  }
  if (novos) log('alvos acumulados=' + porPtr.size + ' (novos=' + novos + ')');
  return novos;
}

try { scan(); } catch (e) { log('busca inicial falhou: ' + e); }
let rondas = 0;
const timer = setInterval(function () {
  try {
    rondas++;
    const novos = scan();
    if (rondas >= 6) {
      clearInterval(timer);
      log('busca de funcoes encerrada; alvos=' + porPtr.size);
    }
  } catch (e) {
    clearInterval(timer);
    log('erro procurando funcoes: ' + e);
  }
}, 20000);
setInterval(function () {
  log('resumo: ' + chamadas + ' chamada(s) de funcoes de inventario no intervalo; alvos=' + porPtr.size);
  chamadas = 0;
}, 30000);
log('rastreio amplo ativo no CLIENTE (somente leitura)');
})();