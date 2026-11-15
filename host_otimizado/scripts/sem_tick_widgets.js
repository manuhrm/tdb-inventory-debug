// sem_tick_widgets.js (2026-11-12) - HOST: desliga o tick dos WidgetComponent (marcadores de loot W_MarkLoot e outros widgets 3D).
// Medido na VPS (perf + leitura de /proc/PID/mem): 12.538 das 13.262 funcoes de tick ligadas no host eram WidgetComponent, e so o
// despacho de ticks (QueueTickFunction / FTickFunctionTask / FActorComponentTickFunction::ExecuteTick) custava ~42% da thread do jogo.
// O motor so desliga esse tick sozinho em servidor dedicado (UWidgetComponent::TickComponent: IsRunningDedicatedServer); o host e um
// cliente com -nullrhi, entao o tick continuava, sem nada para desenhar.
// Como: varredura da GObjects em C, dentro do gancho do TickFlush (thread do jogo). Para cada WidgetComponent com o tick ligado chama
// UWidgetComponent::SetTickMode(Disabled) pelo ProcessEvent (funcao do proprio motor: TickMode = Disabled + SetComponentTickEnabled(false)).
// No maximo LOTE chamadas por varredura; repete a cada 20 s ate zerar e depois a cada 60 s (widgets criados depois).
// So mexe no host: o cliente continua com os proprios widgets. Prefixo [wtick]. Desligar: tirar da lista SCRIPTS (--com-tick-widgets).
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[wtick] ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (e) { return '?'; } }
function nome(o) { try { return fn(o.add(0x18).readU32()); } catch (e) { return '?'; } }
function findFName(alvo) {
  for (let block = 0; block < 512; block++) {
    const bp = pool.add(0x10).add(block * 8).readPointer();
    if (bp.isNull()) break;
    let units = 0;
    while (units < 65536) {
      const entry = bp.add(units * 2), header = entry.readU16(), wide = (header & 1) !== 0, len = header >>> 6;
      if (len <= 0 || len > 1024) break;
      if (len === alvo.length) { let s = null; try { s = wide ? entry.add(2).readUtf16String(len) : entry.add(2).readUtf8String(len); } catch (e) {} if (s === alvo) return ((block << 16) | units) >>> 0; }
      units += ((2 + len * (wide ? 2 : 1)) + 1) >> 1;
    }
  }
  return -1;
}
const MORTO = (1 << 28) | (1 << 29) | (1 << 21);
const LOTE = 3000;
// blk: 0 pedido | 1 pronto | 2 GObjects.objs | 3 num | 4 nch | 5 idx FName WidgetComponent | 6 mascara de mortos | 7 UFunction SetTickMode
//      8 lote | 9 total de WidgetComponent | 10 com tick ligado | 11 desligados nesta varredura | 12 classe WidgetComponent (achada pelo C)
const blk = Memory.alloc(16 * 8); for (let i = 0; i < 16; i++) blk.add(i * 8).writeU64(0);
const parms = Memory.alloc(16); parms.writeU64(0);   // ETickMode::Disabled = 0
const cm = new CModule(`
#include <gum/guminterceptor.h>
#include <stdint.h>
extern uint64_t blk[16];
extern uint8_t parms[16];
extern void tdb_pe (void * obj, void * func, void * p);
static void varrer (void)
{
  uint64_t ** objs = (uint64_t **) blk[2];
  int num = (int) blk[3], nch = (int) blk[4], morto = (int) blk[6], lote = (int) blk[8];
  uint32_t idxW = (uint32_t) blk[5];
  void * f = (void *) blk[7];
  int tot = 0, lig = 0, des = 0, i;
  for (i = 0; i < num; i++)
  {
    int ch = i >> 16;
    uint8_t * chunk, * it, * o, * cls, * interno;
    if (ch >= nch) break;
    chunk = (uint8_t *) objs[ch];
    if (chunk == 0) continue;
    it = chunk + (uint64_t) (i & 0xffff) * 0x18;
    o = *(uint8_t **) it;
    if (o == 0) continue;
    if (*(int *) (it + 8) & morto) continue;
    if (*(int *) (o + 8) & 0x10) continue;          /* Default__ */
    cls = *(uint8_t **) (o + 0x10);
    if (cls == 0 || *(uint32_t *) (cls + 0x18) != idxW) continue;
    blk[12] = (uint64_t) cls;
    tot++;
    /* PrimaryComponentTick em +0x30: +0xB TickState (1 = ligado), +0x20 InternalData (bit0 = registrado) */
    if (*(o + 0x30 + 0xB) != 1) continue;
    interno = *(uint8_t **) (o + 0x30 + 0x20);
    if (interno == 0 || !(*interno & 1)) continue;
    lig++;
    if (f != 0 && des < lote) { parms[0] = 0; tdb_pe (o, f, parms); des++; }
  }
  blk[9] = (uint64_t) tot; blk[10] = (uint64_t) lig; blk[11] = (uint64_t) des;
}
void onEnter (GumInvocationContext * ic)
{
  if (blk[0]) { blk[0] = 0; varrer (); blk[1] = 1; }
}
`, { blk, parms, tdb_pe: B.add(0x24077b0) });
globalThis.__tdbSemTickWidgets = { cm, blk, parms };
Interceptor.attach(B.add(0x42f3650), cm);   // UNetDriver::TickFlush (thread do jogo)

let idxW = -1, fSet = null, esperando = false, proxima = Date.now() + 30000, total = 0, ultLog = '', zeros = 0;
function pedir() {
  const g = B.add(0x7ccda10);
  blk.add(16).writePointer(g.readPointer()); blk.add(24).writeU64(g.add(0x14).readS32()); blk.add(32).writeU64(g.add(0x1c).readS32());
  blk.add(40).writeU64(idxW); blk.add(48).writeU64(MORTO); blk.add(56).writePointer(fSet || ptr(0)); blk.add(64).writeU64(LOTE);
  blk.add(8).writeU64(0); blk.add(0).writeU64(1); esperando = true;
}
function acharSetTickMode(cls) {
  let x = cls.add(0x48).readPointer();
  for (let k = 0; k < 2000 && !x.isNull(); k++) { if (nome(x) === 'SetTickMode') return x; x = x.add(0x28).readPointer(); }
  return null;
}
setInterval(function () {
  try {
    const agora = Date.now();
    if (esperando) {
      if (blk.add(8).readS32() !== 1) return;
      esperando = false;
      const tot = blk.add(72).readS32(), lig = blk.add(80).readS32(), des = blk.add(88).readS32();
      if (fSet === null) {
        const cls = blk.add(96).readPointer();
        if (cls.isNull()) { proxima = agora + 20000; return; }   // ainda nao ha WidgetComponent
        fSet = acharSetTickMode(cls);
        if (fSet === null) { log('ERRO: UFunction SetTickMode nao achada na classe ' + cls + ' (script desligado)'); proxima = Infinity; return; }
        log('WidgetComponent: ' + tot + ', com tick ligado: ' + lig + '; SetTickMode @' + fSet);
        proxima = agora + 2000; return;
      }
      total += des;
      const linha = 'tick desligado em ' + des + ' (total ' + total + '); WidgetComponent=' + tot + ', ainda ligados antes desta passada=' + lig;
      if (des > 0 || linha !== ultLog) log(linha);
      ultLog = linha;
      zeros = des > 0 ? 0 : zeros + 1;
      // cada varredura custa ~50 ms na thread do jogo: depois de 5 passadas sem nada para desligar, so a cada 10 min
      proxima = agora + (lig > des ? 3000 : (des > 0 ? 20000 : (zeros >= 5 ? 600000 : 60000)));
      return;
    }
    if (agora < proxima) return;
    if (idxW < 0) { idxW = findFName('WidgetComponent'); if (idxW < 0) { proxima = agora + 10000; return; } }
    pedir();
  } catch (e) { log('erro no ciclo: ' + e); }
}, 1000);
log('pronto: desliga o tick dos WidgetComponent no host (varredura em C no TickFlush)');
})();
