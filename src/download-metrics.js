export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  const value = bytes / 1024 ** (index + 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  return `${Math.floor(rounded / 3600)}h ${Math.floor(rounded % 3600 / 60)}m`;
}

export function createSpeedMeter(now = () => performance.now()) {
  let total = 0;
  const samples = [{ time: now(), total }];
  return {
    add(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      total += bytes;
      const time = now();
      samples.push({ time, total });
      while (samples.length > 2 && samples[1].time < time - 8_000) samples.shift();
    },
    speed() {
      const first = samples[0];
      const last = samples.at(-1);
      const seconds = (last.time - first.time) / 1_000;
      return seconds >= 0.25 ? (last.total - first.total) / seconds : null;
    },
  };
}

export function phaseMetrics(tasks, kind, active = {}) {
  const phase = tasks.filter(task => task.kind === kind);
  const pending = phase.filter(task => !task.done);
  const finished = phase.filter(task => task.done);
  const activeTask = pending.find(task => task.id === active.taskId);
  const currentBytes = activeTask ? Math.max(0, active.bytes ?? 0) : 0;
  const downloaded = finished.reduce((sum, task) => sum + (task.downloadedBytes ?? task.sizeBytes ?? 0), 0)
    + currentBytes;
  const speed = active.speed > 0 ? active.speed : null;
  let totalBytes = null;
  let unknownSizes = 0;
  let etaSeconds = null;

  if (kind === 'file') {
    totalBytes = phase.reduce((sum, task) => sum + (task.sizeBytes ?? 0), 0);
    unknownSizes = phase.filter(task => task.sizeBytes === null || task.sizeBytes === undefined).length;
    const pendingUnknown = pending.some(task => task.sizeBytes === null || task.sizeBytes === undefined);
    const remaining = pending.reduce((sum, task) => sum + (task.sizeBytes ?? 0), 0)
      - (activeTask?.sizeBytes != null ? Math.min(currentBytes, activeTask.sizeBytes) : 0);
    if (speed && !pendingUnknown) etaSeconds = Math.max(0, remaining) / speed;
  } else if (pending.length && speed) {
    const average = finished.length
      ? finished.reduce((sum, task) => sum + (task.downloadedBytes ?? 0), 0) / finished.length
      : active.length > 0 ? active.length : 0;
    if (average > 0) {
      const currentEstimate = activeTask ? (active.length > 0 ? active.length : average) : 0;
      const remaining = (pending.length - (activeTask ? 1 : 0)) * average
        + Math.max(0, currentEstimate - currentBytes);
      etaSeconds = remaining / speed;
    }
  }
  if (!pending.length) etaSeconds = 0;
  return { downloaded, totalBytes, unknownSizes, speed, etaSeconds, completed: finished.length, total: phase.length };
}
