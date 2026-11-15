// monitor_inventario_cliente.js - diagnostico SOMENTE LEITURA no cliente Offline.
// Confere se o jogo chama as funcoes de sincronizacao antes de o pedido chegar ao host.
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[invcliente] ' + Date.now() + ' ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nome(o) { return fn(o.add(0x18).readU32()); }
function classe(o) { try { return nome(o.add(0x10).readPointer()); } catch (e) { return '?'; } }
function fstr(p) { try { const d = p.readPointer(), n = p.add(8).readS32(); if (d.isNull() || n <= 0 || n > 4000) return ''; return d.readUtf16String(n - 1); } catch (e) { return '?'; } }
function arrStr(p) { const r = []; try { const d = p.readPointer(), n = p.add(8).readS32(); if (n < 0 || n > 600) return r; for (let i = 0; i < n; i++) r.push(fstr(d.add(i * 16))); } catch (e) {} return r; }
const ALVOS = ['UpdateData', 'UpdateStash', 'StashLoader', 'StashLocal', 'UpdateCash', 'UpdateCashServ', 'CashLoader', 'CashLocal', 'Set_Stash_Money'];
const porPtr = new Map();
const alvosArr = Memory.alloc(32 * 8), nAlvos = Memory.alloc(8); nAlvos.writeS32(0);
const notify = new NativeCallback(function (obj, f, parms) { try { tratar(obj, f, parms); } catch (e) { log('erro lendo chamada: ' + e); } }, 'void', ['pointer', 'pointer', 'pointer']);
const cm = new CModule([
  '#include <gum/guminterceptor.h>',
  'extern void notify (void * obj, void * fn, void * parms);',
  'extern void * alvos[32];',
  'extern int nalvos;',
  'void onEnter (GumInvocationContext * ic)',
  '{',
  '  void * f = gum_invocation_context_get_nth_argument (ic, 1);',
  '  int i;',
  '  for (i = 0; i < nalvos; i++)',
  '    if (alvos[i] == f) { notify (gum_invocation_context_get_nth_argument (ic, 0), f, gum_invocation_context_get_nth_argument (ic, 2)); return; }',
  '}'
].join('\n'), { notify, alvos: alvosArr, nalvos: nAlvos });

function procurarAlvos() {
  const arr = B.add(0x7ccda10), objs = arr.readPointer(), num = arr.add(0x14).readS32(), nch = arr.add(0x1c).readS32();
  let novos = 0;
  for (let i = 0; i < num; i++) {
    const ch = (i / 0x10000) | 0; if (ch >= nch) break;
    try {
      const chunk = objs.add(ch * 8).readPointer(); if (chunk.isNull()) continue;
      const o = chunk.add((i % 0x10000) * 0x18).readPointer(); if (o.isNull()) continue;
      const nf = nome(o);
      if (ALVOS.indexOf(nf) < 0 || classe(o) !== 'Function') continue;
      const outer = o.add(0x20).readPointer(); if (outer.isNull() || nome(outer) !== 'BPC_SharpSync_C') continue;
      const k = o.toString(); if (porPtr.has(k)) continue;
      const n = nAlvos.readS32(); if (n >= 32) break;
      alvosArr.add(n * 8).writePointer(o); nAlvos.writeS32(n + 1); porPtr.set(k, nf); novos++;
    } catch (e) {}
  }
  if (novos) log('funcoes encontradas: ' + [...porPtr.values()].join(', '));
  return ['UpdateData', 'UpdateStash'].every(x => [...porPtr.values()].includes(x));
}
function curto(lista) { return lista.map(s => s.replace(/;[^!]*/, '')).join(' | ').slice(0, 1800); }
function tratar(obj, f, parms) {
  const qual = porPtr.get(f.toString()); if (!qual) return;
  if (qual === 'UpdateData' || qual === 'UpdateStash') {
    const lista = arrStr(parms);
    log(qual + ' obj=' + obj + ' n=' + lista.length + ' [' + curto(lista) + ']');
  } else if (qual === 'Set_Stash_Money') {
    log(qual + ' valor=' + parms.readS32());
  } else {
    const lista = arrStr(parms);
    log(qual + ' obj=' + obj + ' n=' + lista.length + ' [' + curto(lista) + ']');
  }
}
Interceptor.attach(B.add(0x24077b0), cm);
let tentativas = 0;
const timer = setInterval(function () {
  try {
    tentativas++;
    if (procurarAlvos()) {
      clearInterval(timer);
      log('sonda ativa; monitorizando UpdateData/UpdateStash no CLIENTE');
    } else if (tentativas >= 6) {
      clearInterval(timer);
      log('nao encontrei UpdateData/UpdateStash apos 6 buscas; encontrados=' + [...porPtr.values()].join(', '));
    }
  } catch (e) {
    clearInterval(timer);
    log('falha ao procurar funcoes: ' + e);
  }
}, 20000);
try { procurarAlvos(); } catch (e) { log('busca inicial falhou: ' + e); }
log('carregada no processo cliente (somente leitura)');
})();
