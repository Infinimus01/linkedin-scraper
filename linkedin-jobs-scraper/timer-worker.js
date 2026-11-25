// Timers in a worker keep their pace when the scraper tab is in the background,
// where Chrome slows normal page timers down to about one per minute.
onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);
