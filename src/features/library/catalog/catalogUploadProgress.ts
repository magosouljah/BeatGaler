// E80 — Porcentaje del aviso flotante de subidas a partir de BYTES reales enviados por Direct B (nunca temporizadores ni archivos terminados).
// Entero y truncado: 100 % solo cuando todos los bytes están enviados (la confirmación en PostgreSQL retira el aviso).
export const uploadPercent = (uploadedBytes: number, totalBytes: number): number =>
  totalBytes > 0 ? Math.max(0, Math.min(100, Math.floor((Math.min(uploadedBytes, totalBytes) / totalBytes) * 100))) : 0;

/** Varias subidas: bytes enviados de todas / bytes totales de todas (una subida grande pesa lo que pesa). */
export function aggregateUploadPercent(list: ReadonlyArray<{ uploadedBytes: number; totalBytes: number }>): number {
  const total = list.reduce((n, u) => n + Math.max(0, u.totalBytes), 0);
  return uploadPercent(list.reduce((n, u) => n + Math.max(0, Math.min(u.uploadedBytes, u.totalBytes)), 0), total);
}
