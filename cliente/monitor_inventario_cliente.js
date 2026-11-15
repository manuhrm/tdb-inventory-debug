// monitor_inventario_cliente.js - SONDA SOMENTE LEITURA (cliente).
// Registra chamadas relacionadas com inventario no proprio cliente. Nao altera memoria nem envia RPCs.
// Objetivo: distinguir se o cliente produz UpdateData e se usa UJSIContainer_C para alterar os itens.
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[invcli] ' + m }); }

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
    if (n < 0 || n > 300 || (n && d.isNull())) return null;
    for (let i = 0; i < n; i++) r.push(fstr(d.add(i * 16)));
    return r;
  } catch (e) { return null; }
}
function hex(p, n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    try { s += ('0' + p.add(i).readU8().toString(16)).slice(-2); }
    catch (e) { break; }
  }
  return s;
}

const MAX = 128;
const targets = new Map();
const targetMem = Memory.alloc(MAX * 8), targetCount = Memory.alloc(8);
targetCount.writeS32(0);
let eventCount = 0, dropped = 0;
const notify = new NativeCallback(function (obj, f, parms) {
  try {
    const meta = targets.get(f.toString());
    if (!meta) return;
    eventCount++;
    if (eventCount > 500) { dropped++; return; }
    let detail = '';
    if (meta.name === 'UpdateData' || meta.name === 'UpdateStash') {
      const a = arrStr(parms);
      detail = a === null ? ' parms=' + hex(parms, 48) : ' n=' + a.length + ' [' + a.join(' | ') + ']';
    } else {
      detail = ' parms=' + hex(parms, 48);
    }
    log(meta.owner + '.' + meta.name + ' obj=' + obj + detail);
  } catch (e) { log('erro no callback: ' + e); }
}, 'void', ['pointer', 'pointer', 'pointer']);

const cm = new CModule(\`
#include <gum/guminterceptor.h>
extern void notify (void * obj, void * fn, void * parms);
extern void * targets[128];
extern int targetCount;
void onEnter (GumInvocationContext * ic)
{
  void * f = gum_invocation_context_get_nth_argument (ic, 1);
  int i;
  for (i = 0; i < targetCount; i++) {
    if (targets[i] == f) {
      notify (gum_invocation_context_get_nth_argument (ic, 0), f,
              gum_invocation_context_get_nth_argument (ic, 2));
      return;
    }
  }
}
\`, { notify, targets: targetMem, targetCount });

function deveVigiar(owner, name) {
  if (owner === 'BPC_SharpSync_C')
    return /Update|Stash|Cash|Inventory|Item/i.test(name);
  if (owner === 'UJSIContainer_C')
    return /Item|Data|Update|Container|Save|Move|Remove|Add|Drop|Equip/i.test(name);
  if (/^SurvivalPlayer(?:_V2)?_C$/.test(owner))
    return /Item|Inventory|Container|Stash|Save|UpdateData|RequestUID|AddItem|RemoveItem/i.test(name);
  return false;
}

function procurar() {
  const arr = B.add(0x7ccda10), objs = arr.readPointer();
  const num = arr.add(0x14).readS32(), chunks = arr.add(0x1c).readS32();
  let novos = 0;
  for (let i = 0; i < num; i++) {
    const ch = (i / 0x10000) | 0;
    if (ch >= chunks) break;
    try {
      const chunk = objs.add(ch * 8).readPointer();
      if (chunk.isNull()) continue;
      const o = chunk.add((i % 0x10000) * 0x18).readPointer();
      if (o.isNull() || classe(o) !== 'Function') continue;
      const name = nome(o), outer = o.add(0x20).readPointer();
      if (outer.isNull()) continue;
      const owner = nome(outer);
      if (!deveVigiar(owner, name)) continue;
      const key = o.toString();
      if (targets.has(key)) continue;
      const n = targetCount.readS32();
      if (n >= MAX) { log('limite de ' + MAX + ' funcoes atingido'); break; }
      targetMem.add(n * 8).writePointer(o);
      targetCount.writeS32(n + 1);
      targets.set(key, { owner, name });
      novos++;
    } catch (e) {}
  }
  if (novos) log('funcoes encontradas: ' + [...targets.values()].map(x => x.owner + '.' + x.name).join(', '));
  return targets.size;
}

Interceptor.attach(B.add(0x24077b0), cm);
let tentativas = 0;
function scan() {
  try {
    tentativas++;
    const n = procurar();
    if (tentativas >= 8) {
      clearInterval(timer);
      log('busca encerrada: ' + n + ' funcoes vigiadas em ' + tentativas + ' varreduras');
    }
  } catch (e) { log('erro procurando funcoes: ' + e); }
}
const timer = setInterval(scan, 20000);
setTimeout(scan, 1000);
setInterval(function () {
  if (dropped) { log('limite de eventos de log atingido; eventos adicionais omitidos=' + dropped); dropped = 0; }
}, 60000);
log('pronto: sonda de inventario do cliente (somente leitura)');
})();