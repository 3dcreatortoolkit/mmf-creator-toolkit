export async function runConcurrentWorkers(kinds, run, controller) {
  let firstFailure;
  await Promise.allSettled(kinds.map(kind => Promise.resolve().then(() => run(kind)).catch(error => {
    // An aborted sibling may reject earlier in array order, but it did not cause the stop.
    if (!firstFailure) firstFailure = error;
    controller.abort();
    throw error;
  })));
  if (firstFailure) throw firstFailure;
}
