const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.setTimeout(45000);
test.use({ serviceWorkers: 'block', trace: 'off', video: 'off' });
for (const width of [390, 1440]) {
  test(`generated captured input, silence, route and retained review ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openFixture(page);
    await page.evaluate(async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      window.voiceFixture = { context, oscillator, gain, stream: destination.stream, captures: 0 };
      const track = destination.stream.getAudioTracks()[0];
      Object.defineProperty(track, 'label', { value: 'Generated actual input' });
      track.getSettings = () => ({ deviceId: 'observed' });
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [
        { kind: 'audioinput', deviceId: 'preferred', label: 'Preferred test microphone' },
        { kind: 'audioinput', deviceId: 'observed', label: 'Generated actual input' },
      ] });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
        window.voiceFixture.captures++;
        window.voiceFixture.constraints = constraints;
        return destination.stream;
      } });
      const store = Alpine.store('chat');
      store.threadInput = 'Retained text draft';
      // Recording/review fixture only: network upload and explicit Send are unit-tested separately.
      store.attachRecordedAudioDraft = async function () { this.audioRecorderState = 'ready'; this.audioRecorderStatusLabel = 'Fixture retained review'; };
      await store.openAudioRecorder('thread');
    });
    const dialog = page.getByRole('dialog', { name: 'Voice note', exact: true });
    const choice = dialog.getByLabel('Microphone preference');
    await expect(choice).toBeEnabled();
    expect(await page.evaluate(() => voiceFixture.captures)).toBe(0);
    await choice.selectOption('preferred');
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(choice).toBeDisabled();
    await expect(dialog.getByTestId('audio-active-input')).toHaveText('Generated actual input');
    await expect(dialog.getByText('Browser is using a different input from your preference.')).toBeVisible();
    await expect(dialog.getByTestId('audio-level-state')).toHaveText('Quiet');
    await page.evaluate(() => { voiceFixture.gain.gain.value = 0.12; });
    await expect(dialog.getByTestId('audio-level-state')).toHaveText('Sound detected');
    await expect.poll(() => dialog.locator('meter').evaluate(node => node.value)).toBeGreaterThan(0.2);
    await page.evaluate(() => { voiceFixture.gain.gain.value = 0; });
    await expect(dialog.getByTestId('audio-level-state')).toHaveText('Quiet');
    await expect.poll(() => dialog.getByRole('timer').textContent()).not.toBe('0:00');
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(dialog.locator('audio')).toBeVisible();
    expect(await page.evaluate(() => ({ size: Alpine.store('chat')._audioRecorderBlob.size,
      captures: voiceFixture.captures, constraints: voiceFixture.constraints,
      track: voiceFixture.stream.getAudioTracks()[0].readyState,
      text: Alpine.store('chat').threadInput, meter: Alpine.store('chat')._audioMeterCleanup }))).toMatchObject({
      captures: 1, constraints: { audio: { deviceId: { exact: 'preferred' } } }, track: 'ended', text: 'Retained text draft', meter: null,
    });
    expect(await page.evaluate(() => Alpine.store('chat')._audioRecorderBlob.size)).toBeGreaterThan(0);
    await page.screenshot({ path: `tmp/docs/handoffs/nightly-voice-1126/review-${width}.png` });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => Alpine.store('chat')._audioRecorderBlob)).toBe(null);
    await page.evaluate(async () => { voiceFixture.oscillator.stop(); await voiceFixture.context.close(); });
  });
}

test('browser fixture permission denial leaves choice available and no active-input claim', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(async () => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Denied fixture', 'NotAllowedError'); } });
    await Alpine.store('chat').openAudioRecorder('chat');
  });
  const dialog = page.getByRole('dialog', { name: 'Voice note', exact: true });
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Microphone permission denied');
  await expect(dialog.getByTestId('audio-active-input')).toHaveText('Not recording');
  await expect(dialog.getByLabel('Microphone preference')).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});
