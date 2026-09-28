// In-process scheduler for periodic jobs (webhook retries, reminders, automatic locks, accruals, etc.)
const jobs = [];
export function registerJob(name, intervalMs, fn) { jobs.push({ name, intervalMs, fn, timer: null }); }

export function startScheduler() {
  for (const j of jobs) {
    const run = async () => { try { await j.fn(); } catch (err) { console.error(`[scheduler] ${j.name} failed:`, err.message); } };
    j.timer = setInterval(run, j.intervalMs);
    j.timer.unref?.();
    setTimeout(run, 2000).unref?.();
  }
  console.log(`[scheduler] ${jobs.length} job(s) started`);
}

export function stopScheduler() { for (const j of jobs) if (j.timer) clearInterval(j.timer); }
export { jobs };
