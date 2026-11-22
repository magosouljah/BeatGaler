// LAB navegador: inyección de un File en el selector nativo (no automatizable) para sondas de «Add beat».
// Misma técnica que probe-add-beat.mjs (HTMLInputElement.prototype.click devuelve un File por cola); con fixtures MP3, PNG, WAV y ZIP.
// Uso: const inj = makeFileInjector(ex); await ex((b64, build) => { window.__mp3 = b64; (0, eval)(build); }, inj.silentMp3Base64(), inj.BUILD); await inj.armPicker(['x.mp3', 'mp3']);

export function silentMp3Base64() {
  const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90;
  return Buffer.concat(Array.from({ length: 1500 }, () => frame)).toString('base64');
}

export const BUILD = `window.__mk = async (name, kind) => {
  if (kind === 'wav') { const rate = 44100, n = rate; const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 8000), true); return new File([buf], name, { type: 'audio/wav' }); }
  if (kind === 'png') { const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }); const g = cv.getContext('2d'); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 64, 64); return new File([await new Promise((r) => cv.toBlob(r, 'image/png'))], name, { type: 'image/png' }); }
  if (kind === 'zip') return new File([new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], name, { type: 'application/zip' });
  const bytes = Uint8Array.from(atob(window.__mp3), (c) => c.charCodeAt(0)); return new File([bytes], name, { type: 'audio/mpeg' });
};`;

export function makeFileInjector(ex) {
  // Parchea el selector: la siguiente apertura de un <input type=file> recibe el File (cola).
  const armPicker = (...files) => ex((list) => (async () => {
    window.__queue = [];
    for (const [n, k] of list) window.__queue.push(await window.__mk(n, k));
    if (!window.__pickerPatched) {
      window.__pickerPatched = true; const orig = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file' || !window.__queue.length) return orig.call(this);
        const file = window.__queue.shift(); const dt = new DataTransfer(); dt.items.add(file); this.files = dt.files;
        setTimeout(() => this.dispatchEvent(new Event('change', { bubbles: true })), 0);
      };
    }
  })(), files);
  return { armPicker, silentMp3Base64, BUILD };
}
