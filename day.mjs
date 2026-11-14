// day.mjs: the day a record was written, as the clock of this machine has it.
// A record keeps the instant in UTC. Shown as its first ten characters it reads a day ahead for anyone west of
// Greenwich in the evening: at 20:29 on the 13th in Los Angeles an agent was told a decision was made on the 14th, and
// remarked on it (a real session, 2026-11-13). A commit's own date (rank.mjs) is not a record's and is left as git has it.
export function localDay(at) {
  const s = String(at || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;   // already a day: reading it as an instant would move it
  const d = new Date(s);
  if (!s || Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
