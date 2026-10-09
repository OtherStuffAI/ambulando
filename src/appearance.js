const THEME_KEY = 'ambulando:theme';
const THEMES = ['light', 'dark', 'system'];

// Presentation preference is device-local and independent of workspace authority.
export function installAppearance(Alpine) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem(THEME_KEY) || 'system'; } catch { /* Storage may be disabled. */ }
  if (!THEMES.includes(preference)) preference = 'system';
  Alpine.store('appearance', {
    preference,
    resolved: document.documentElement.dataset.theme || 'light',
    apply() {
      this.resolved = this.preference === 'system' ? (media.matches ? 'dark' : 'light') : this.preference;
      document.documentElement.dataset.theme = this.resolved;
      document.documentElement.style.colorScheme = this.resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.resolved === 'dark' ? '#111D29' : '#F7F8F6');
    },
    setTheme(value) {
      if (!THEMES.includes(value)) return;
      this.preference = value;
      try { localStorage.setItem(THEME_KEY, value); } catch { /* Theme still works in memory. */ }
      this.apply();
    },
    toggle() { this.setTheme(this.resolved === 'dark' ? 'light' : 'dark'); },
  });
  Alpine.store('appearance').apply();
  media.addEventListener('change', () => Alpine.store('appearance').apply());
  window.addEventListener('storage', event => {
    if (event.key !== THEME_KEY) return;
    const store = Alpine.store('appearance');
    store.preference = THEMES.includes(event.newValue) ? event.newValue : 'system';
    store.apply();
  });
}
