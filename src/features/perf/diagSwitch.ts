// Interruptor unico de diagnostico (D11): trazas apagadas por defecto.
// Se enciende con localStorage["bg:diag"]="1", con ?bgdiag=1 en la URL o con
// globalThis.__BG_DIAG__ = true (sondas y harness de Node). Un Worker del navegador no tiene
// localStorage y su URL no lleva el parametro: ahi queda apagado salvo que se fije __BG_DIAG__.
let cached: boolean | null = null;

function readSwitch(): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("bg:diag") === "1") return true;
  } catch { /* storage bloqueado: sigue apagado */ }
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).get("bgdiag") === "1") return true;
  } catch { /* sin location */ }
  return false;
}

export function diagEnabled(): boolean {
  if ((globalThis as { __BG_DIAG__?: unknown }).__BG_DIAG__ === true) return true;
  return cached ??= readSwitch();
}

/** Solo para pruebas: olvida la lectura cacheada. */
export function resetDiagCache(): void { cached = null; }
