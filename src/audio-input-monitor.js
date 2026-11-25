/** Browser-only input observation. Never opens a second capture or changes tracks. */
export function capturedInputLevel(samples) {
  if (!samples?.length) return 0;
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  return rms < 0.003 ? 0 : Math.min(1, rms * 4);
}

export function observedAudioInput(track, devices = [], preference = '') {
  if (!track || track.readyState === 'ended') return { name: 'Input disconnected', detail: 'Stop to keep the captured audio.' };
  const id = track.getSettings?.().deviceId || '';
  const name = track.label || devices.find(device => id && device.deviceId === id)?.label || 'Unknown (browser did not report input)';
  const detail = preference && id && id !== preference
    ? 'Browser is using a different input from your preference.'
    : preference && !id ? 'Browser did not report whether your preference is in use.' : '';
  return { name, detail };
}

export function observeCapturedInput(stream, onLevel) {
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContext) return null;
  let context;
  let source;
  let analyser;
  try {
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser); // No connection to speakers.
    const samples = new Float32Array(analyser.fftSize);
    void context.resume().catch(() => {});
    const timer = setInterval(() => {
      if (context.state !== 'running') return onLevel(null);
      analyser.getFloatTimeDomainData(samples);
      onLevel(capturedInputLevel(samples));
    }, 100);
    return () => {
      clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => {});
    };
  } catch {
    source?.disconnect();
    analyser?.disconnect();
    void context?.close().catch(() => {});
    return null;
  }
}
