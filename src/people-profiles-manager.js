/**
 * People / profile resolution and address-book methods extracted from app.js.
 *
 * The peopleProfilesManagerMixin object contains methods and getters that use `this`
 * (the Alpine store) and should be spread into the store definition via applyMixins.
 */

import {
  getAddressBookPeople,
  getCachedProfile,
  upsertAddressBookPerson,
} from './db.js';
import { canonicalProfileNpub, usableProfileText } from './profile-identity.js';
import { fetchProfileByNpub } from './profiles.js';
import { fetchWorkspaceKeyMappings } from './api.js';

const EMPTY_ARRAY = Object.freeze([]);
const addressBookPeopleMapCache = new WeakMap();
const REMEMBER_PEOPLE_TOUCH_MS = 15 * 60 * 1000;
const PROFILE_CARD_WIDTH = 320;
const PROFILE_CARD_HEIGHT = 300;
const PROFILE_CARD_MARGIN = 12;
const FULL_NPUB_PATTERN = /^npub1[0-9a-z]{50,}$/i;
const PROFILE_LOOKUP_RETRY_MS = 60 * 1000;
const MAX_FAILED_AVATAR_URLS = 200;

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return null;
}

function resolveProfileName(profile = {}) {
  const source = profile && typeof profile === 'object' ? profile : {};
  return firstNonEmptyString(source.display_name, source.displayName, source.name, source.username);
}

function resolveProfilePicture(profile = {}) {
  const source = profile && typeof profile === 'object' ? profile : {};
  return firstNonEmptyString(
    source.picture,
    source.image,
    source.avatar_url,
    source.avatarUrl,
    source.avatar,
  );
}

function normalizeProfilePictureUrl(url) {
  const avatarUrl = String(url || '').trim();
  if (!avatarUrl) return null;
  try {
    const parsed = new URL(avatarUrl);
    const originalUrl = parsed.hostname === 'images.fountain.fm'
      && parsed.pathname.startsWith('/profile/')
      ? String(parsed.searchParams.get('original') || '').trim()
      : '';
    if (originalUrl) {
      const original = new URL(originalUrl);
      if (original.protocol === 'https:' || original.protocol === 'http:') {
        return original.href;
      }
    }
  } catch {
    return avatarUrl;
  }
  return avatarUrl;
}

function mergeAddressBookPersonLocal(store, entry = {}) {
  const npub = String(entry.npub || '').trim();
  if (!npub || !Array.isArray(store.addressBookPeople)) return;
  const index = store.addressBookPeople.findIndex((person) => person?.npub === npub);
  const existing = index >= 0 ? store.addressBookPeople[index] : null;
  const merged = {
    npub,
    label: entry.label ?? existing?.label ?? null,
    avatar_url: entry.avatar_url ?? existing?.avatar_url ?? null,
    bio: entry.bio ?? existing?.bio ?? null,
    nip05: entry.nip05 ?? existing?.nip05 ?? null,
    source: entry.source ?? existing?.source ?? 'profile',
    last_used_at: entry.last_used_at ?? existing?.last_used_at ?? new Date().toISOString(),
  };
  store.addressBookPeople = index >= 0
    ? [
      ...store.addressBookPeople.slice(0, index),
      merged,
      ...store.addressBookPeople.slice(index + 1),
    ]
    : [merged, ...store.addressBookPeople];
}

function uniqueNpubCandidates(...candidates) {
  const seen = new Set();
  return candidates
    .map((candidate) => String(candidate || '').trim())
    .filter((candidate) => candidate)
    .filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
}

function getAddressBookPeopleMap(store) {
  const people = Array.isArray(store?.addressBookPeople) ? store.addressBookPeople : EMPTY_ARRAY;
  let cached = addressBookPeopleMapCache.get(people);
  if (cached) return cached;
  cached = new Map();
  // getAddressBookPeople is newest-first. Merge legacy hex/npub duplicates
  // without letting an older alias replace the latest saved label.
  for (const person of people) {
    const key = canonicalProfileNpub(person.npub);
    const newer = cached.get(key);
    cached.set(key, newer ? {
      ...person, ...newer,
      label: usableProfileText(newer.label, person.label),
      avatar_url: usableProfileText(newer.avatar_url, person.avatar_url),
      bio: usableProfileText(newer.bio, person.bio),
      nip05: usableProfileText(newer.nip05, person.nip05),
    } : person);
  }
  addressBookPeopleMapCache.set(people, cached);
  return cached;
}

function isFullNpubCandidate(value = '') {
  const text = String(value || '').trim();
  return FULL_NPUB_PATTERN.test(text) && !text.includes('...');
}

function addFullNpub(target, value) {
  const npub = canonicalProfileNpub(value);
  if (isFullNpubCandidate(npub)) target.add(npub);
}

function addNpubFields(target, item, fields) {
  if (!item || typeof item !== 'object') return;
  for (const field of fields) addFullNpub(target, item[field]);
}

function addNpubArrayFields(target, item, fields) {
  if (!item || typeof item !== 'object') return;
  for (const field of fields) {
    const values = item[field];
    if (!Array.isArray(values)) continue;
    for (const value of values) addFullNpub(target, value);
  }
}

function addGroupMemberNpubs(target, group) {
  if (!group || typeof group !== 'object') return;
  for (const field of ['member_npubs', 'memberNpubs', 'members']) {
    const values = group[field];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === 'string') addFullNpub(target, value);
      else addNpubFields(target, value, ['npub', 'member_npub', 'user_npub']);
    }
  }
}

function collectKnownProfileNpubs(store) {
  const npubs = new Set();
  addFullNpub(npubs, store?.session?.npub);
  addFullNpub(npubs, store?.defaultAgentNpub);
  addFullNpub(npubs, store?.identityCard?.npub);
  for (const npub of Object.keys(store?.chatProfiles || {})) addFullNpub(npubs, npub);
  for (const person of store?.addressBookPeople || []) addNpubFields(npubs, person, ['npub']);
  for (const member of store?.pgWorkspaceMembers || []) addNpubFields(npubs, member, ['npub', 'user_npub', 'member_npub']);
  for (const group of [...(store?.groups || []), ...(store?.currentWorkspaceGroups || [])]) addGroupMemberNpubs(npubs, group);
  for (const message of store?.messages || []) addNpubFields(npubs, message, ['author_npub', 'sender_npub', 'created_by_npub', 'owner_npub']);
  for (const task of store?.tasks || []) {
    addNpubFields(npubs, task, ['created_by_npub', 'owner_npub']);
    addNpubArrayFields(npubs, task, ['assigned_to_npubs']);
  }
  for (const comment of store?.docComments || []) addNpubFields(npubs, comment, ['author_npub', 'created_by_npub', 'owner_npub']);
  return [...npubs];
}

// ---------------------------------------------------------------------------
// Mixin — methods and getters that use `this` (the Alpine store)
// ---------------------------------------------------------------------------

export const peopleProfilesManagerMixin = {

  // Browser image failures are tracked by the exact resolved URL, never by
  // identity. This lets every avatar surface fall back together without
  // suppressing a later profile URL or recreating a failed <img> in a loop.
  failedAvatarImageUrls: {},

  canRenderAvatarImage(url) {
    const avatarUrl = String(url || '').trim();
    return Boolean(avatarUrl) && this.failedAvatarImageUrls?.[avatarUrl] !== true;
  },

  handleAvatarImageError(event, resolvedUrl = '') {
    const image = event?.currentTarget || event?.target || null;
    const avatarUrl = String(image?.currentSrc || image?.src || resolvedUrl || '').trim();
    if (image) {
      image.alt = '';
      image.hidden = true;
    }
    if (!avatarUrl || this.failedAvatarImageUrls?.[avatarUrl] === true) return;

    const failedEntries = Object.entries(this.failedAvatarImageUrls || {});
    const retainedEntries = failedEntries.slice(-(MAX_FAILED_AVATAR_URLS - 1));
    this.failedAvatarImageUrls = Object.fromEntries([
      ...retainedEntries,
      [avatarUrl, true],
    ]);
  },

  // --- workspace key → user npub resolution ---

  // Map of ws_key_npub → real user_npub for display resolution
  _wsKeyDisplayMap: {},
  _profileWorkspaceGeneration: 0,

  /**
   * Fetch workspace key mappings from Tower and populate the display map.
   * Called during workspace bootstrap.
   */
  async refreshWorkspaceKeyMappings() {
    if (!this.workspaceOwnerNpub) return;
    const generation = this._profileWorkspaceGeneration;
    const owner = this.workspaceOwnerNpub;
    try {
      const result = await fetchWorkspaceKeyMappings(this.workspaceOwnerNpub);
      if (generation !== this._profileWorkspaceGeneration || owner !== this.workspaceOwnerNpub) return;
      const map = {};
      for (const entry of (result.mappings || [])) {
        const workspaceUserKeyNpub = String(
          entry.workspace_user_key_npub
          || entry.ws_key_npub
          || ''
        ).trim();
        const userNpub = String(entry.user_npub || '').trim();
        if (!workspaceUserKeyNpub || !userNpub) continue;
        map[canonicalProfileNpub(workspaceUserKeyNpub)] = canonicalProfileNpub(userNpub);
      }
      this._wsKeyDisplayMap = map;
    } catch {
      // Non-critical — display will fall back to ws_key npub
    }
  },

  /**
   * Resolve an npub for display purposes.
   * If the npub is a workspace session key, returns the real user npub.
   * Otherwise returns the input unchanged.
   */
  resolveDisplayNpub(npub) {
    if (!npub) return npub;
    const canonical = canonicalProfileNpub(npub);
    return this._wsKeyDisplayMap[canonical] || canonical;
  },

  // --- profile resolution ---

  resolveChatProfile(rawNpub, options = {}) {
    // Resolve ws_key_npub → real user npub for profile lookup
    const npub = this.resolveDisplayNpub(rawNpub);
    const current = this.chatProfiles[npub] || null;
    const force = options?.force === true;
    const requirePicture = options?.requirePicture === true;
    if (!npub || current?.loading) return;
    const lastLookupAt = Number(current?.profileLookupAttemptedAt || 0);
    if (!force && lastLookupAt && Date.now() - lastLookupAt < PROFILE_LOOKUP_RETRY_MS) return;
    const cached = this.getCachedPerson(npub);

    const generation = this._profileWorkspaceGeneration;
    const workspace = this.workspaceOwnerNpub;
    const isCurrent = () => generation === this._profileWorkspaceGeneration && workspace === this.workspaceOwnerNpub;
    const apply = (profile, loading) => {
      if (!isCurrent()) return;
      const existing = this.chatProfiles[npub] || current || {};
      this.chatProfiles = {
        ...this.chatProfiles,
        [npub]: {
          ...existing,
          name: resolveProfileName(profile) || existing.name || cached?.label || null,
          picture: normalizeProfilePictureUrl(resolveProfilePicture(profile) || existing.picture || cached?.avatar_url),
          nip05: usableProfileText(profile?.nip05, existing.nip05, cached?.nip05),
          about: usableProfileText(profile?.about, profile?.bio, existing.about, cached?.bio),
          loading,
          profileLookupAttemptedAt: Date.now(),
          profileRefreshedAt: loading ? existing.profileRefreshedAt : Date.now(),
        },
      };
    };
    apply(null, true);
    // Hydrate independently of relay latency. A delayed hydration cannot replace
    // a completed refresh or an authoritative member edit.
    const hydrationState = this.chatProfiles[npub];
    const hydration = getCachedProfile(npub).then(profile => {
      if (this.chatProfiles[npub] === hydrationState) apply(profile, true);
    }).catch(() => {});

    return hydration.then(() => fetchProfileByNpub(npub, { force: force || requirePicture }))
      .then((profile) => {
        if (!isCurrent()) return;
        const existingProfile = this.chatProfiles[npub] || current || {};
        const profileName = resolveProfileName(profile) || existingProfile?.name || cached?.label || null;
        const profilePicture = normalizeProfilePictureUrl(
          resolveProfilePicture(profile) || existingProfile?.picture || cached?.avatar_url || null,
        );
        const profileNip05 = firstNonEmptyString(profile?.nip05) || existingProfile?.nip05 || cached?.nip05 || null;
        const profileBio = firstNonEmptyString(profile?.about, profile?.bio) || existingProfile?.about || existingProfile?.bio || cached?.bio || null;
        this.chatProfiles = {
          ...this.chatProfiles,
          [npub]: {
            name: profileName,
            picture: profilePicture,
            nip05: profileNip05,
            about: profileBio,
            loading: false,
            profileLookupAttemptedAt: Date.now(),
            profileRefreshedAt: profile ? Date.now() : 0,
          },
        };
        if (profileName || profilePicture || profileNip05 || profileBio) {
          const addressBookEntry = {
            npub,
            label: profileName,
            avatar_url: profilePicture,
            bio: profileBio,
            nip05: profileNip05,
            source: 'profile',
            last_used_at: new Date().toISOString(),
          };
          mergeAddressBookPersonLocal(this, addressBookEntry);
          upsertAddressBookPerson({
            ...addressBookEntry,
          }).catch(() => {});
        }
      })
      .catch(() => { apply(null, false); });
  },

  refreshKnownNostrProfiles() {
    if (typeof document !== 'undefined' && document.hidden) return;
    // Rotate a bounded prefix through known active identities on the existing
    // visible-session sync cadence. Cooldown and relay concurrency are separate.
    const npubs = collectKnownProfileNpubs(this);
    const offset = (this._profileRefreshOffset || 0) % Math.max(npubs.length, 1);
    for (const npub of [...npubs.slice(offset), ...npubs.slice(0, offset)].slice(0, 20)) {
      this.resolveChatProfile(npub);
    }
    this._profileRefreshOffset = offset + 20;
  },

  async refreshNostrProfileCache() {
    if (this.nostrProfilesRefreshing) return;
    this.nostrProfilesRefreshing = true;
    this.nostrProfilesRefreshMessage = '';
    try {
      const npubs = collectKnownProfileNpubs(this);
      for (const npub of npubs) {
        this.resolveChatProfile(npub, { force: true });
      }
      await this.refreshAddressBook?.();
      this.nostrProfilesRefreshMessage = npubs.length > 0
        ? `Refreshing ${npubs.length} Nostr profiles. Visible names will update as relays respond.`
        : 'No known Nostr profiles to refresh yet.';
    } catch (error) {
      this.nostrProfilesRefreshMessage = error?.message || 'Failed to refresh Nostr profiles.';
    } finally {
      this.nostrProfilesRefreshing = false;
    }
  },

  getCachedPerson(npub) {
    if (!npub) return null;
    return getAddressBookPeopleMap(this).get(canonicalProfileNpub(npub)) ?? null;
  },

  getCachedPersonForSender(rawNpub) {
    const npub = this.resolveDisplayNpub(rawNpub);
    for (const candidate of uniqueNpubCandidates(rawNpub, npub)) {
      const person = this.getCachedPerson(candidate);
      if (person) return person;
    }
    return null;
  },

  getProfileForSender(rawNpub) {
    const npub = this.resolveDisplayNpub(rawNpub);
    return this.chatProfiles[npub] || (npub === rawNpub ? null : this.chatProfiles[rawNpub]);
  },

  getSenderName(rawNpub) {
    if (!rawNpub) return 'Unknown';
    const npub = this.resolveDisplayNpub(rawNpub);
    const rawNpubCandidate = String(rawNpub || '').trim();
    const cached = this.getCachedPersonForSender(rawNpub);
    const member = this.pgWorkspaceMembers?.find(member => canonicalProfileNpub(member.npub) === npub);
    const memberName = usableProfileText(member?.display_name);
    const profileName = memberName || this.getProfileForSender(rawNpub)?.name;
    if (profileName || cached?.label) return profileName || cached.label;

    if (isFullNpubCandidate(rawNpubCandidate) && rawNpubCandidate !== npub) {
      this.resolveChatProfile(rawNpubCandidate);
    }

    if (isFullNpubCandidate(npub)) {
      this.resolveChatProfile(npub);
    }

    return this.getShortNpub(npub);
  },

  getSenderIdentity(rawNpub) {
    if (!rawNpub) return '';
    const npub = this.resolveDisplayNpub(rawNpub);
    const profile = this.getProfileForSender(rawNpub);
    const cached = this.getCachedPersonForSender(rawNpub);
    if (profile?.nip05) return profile.nip05;
    if (cached?.nip05) return cached.nip05;
    if (profile?.name || cached?.label) return this.getShortNpub(npub);
    return '';
  },

  getSenderAvatar(rawNpub) {
    if (!rawNpub) return null;
    const cached = this.getCachedPersonForSender(rawNpub);
    const profile = this.getProfileForSender(rawNpub);
    const avatarUrl = normalizeProfilePictureUrl(profile?.picture || cached?.avatar_url || null);
    if (avatarUrl && this.canRenderAvatarImage(avatarUrl)) return avatarUrl;
    const npub = this.resolveDisplayNpub(rawNpub);
    const rawNpubCandidate = String(rawNpub || '').trim();
    if (isFullNpubCandidate(rawNpubCandidate) && rawNpubCandidate !== npub) {
      this.resolveChatProfile(rawNpubCandidate, { requirePicture: true });
    }
    if (isFullNpubCandidate(npub)) {
      this.resolveChatProfile(npub, { requirePicture: true });
    }
    return null;
  },

  getSenderBio(rawNpub) {
    if (!rawNpub) return '';
    const profile = this.getProfileForSender(rawNpub);
    const cached = this.getCachedPersonForSender(rawNpub);
    return profile?.about || profile?.bio || cached?.bio || '';
  },

  getSenderProfile(rawNpub) {
    const npub = this.resolveDisplayNpub(rawNpub);
    if (!npub) return null;
    return {
      npub,
      name: this.getSenderName(npub),
      identity: this.getSenderIdentity(npub),
      avatarUrl: this.getSenderAvatar(npub),
      bio: this.getSenderBio(npub),
      shortNpub: this.getProfileCardShortNpub(npub),
    };
  },

  getProfileCardShortNpub(npub) {
    const value = String(npub || '');
    if (value.length <= 14) return value;
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  },

  getCompactNpub(rawNpub) {
    const npub = this.resolveDisplayNpub(rawNpub);
    return npub ? this.getProfileCardShortNpub(npub) : '';
  },

  getSenderSecondaryLabel(rawNpub) {
    if (!rawNpub) return '';
    const npub = this.resolveDisplayNpub(rawNpub);
    const cached = this.getCachedPerson(npub);
    return this.chatProfiles[npub]?.nip05
      || cached?.nip05
      || this.getCompactNpub(npub);
  },

  get identityCardProfile() {
    return this.getSenderProfile(this.identityCard?.npub);
  },

  openIdentityCard(event, rawNpub) {
    const npub = this.resolveDisplayNpub(rawNpub);
    if (!npub) return;
    this.resolveChatProfile(npub);
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;
    const rawLeft = rect ? rect.left : event?.clientX || PROFILE_CARD_MARGIN;
    const rawTop = rect ? rect.bottom + 8 : event?.clientY || PROFILE_CARD_MARGIN;
    const maxLeft = Math.max(PROFILE_CARD_MARGIN, viewportWidth - PROFILE_CARD_WIDTH - PROFILE_CARD_MARGIN);
    const maxTop = Math.max(PROFILE_CARD_MARGIN, viewportHeight - PROFILE_CARD_HEIGHT - PROFILE_CARD_MARGIN);
    this.identityCard = {
      open: true,
      npub,
      x: Math.max(PROFILE_CARD_MARGIN, Math.min(rawLeft, maxLeft)),
      y: Math.max(PROFILE_CARD_MARGIN, Math.min(rawTop, maxTop)),
      copied: false,
    };
  },

  closeIdentityCard() {
    if (!this.identityCard) return;
    this.identityCard = { ...this.identityCard, open: false, copied: false };
  },

  async copyIdentityCardNpub() {
    const npub = this.identityCardProfile?.npub;
    if (!npub) return;
    try {
      await navigator.clipboard.writeText(npub);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = npub;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    this.identityCard = { ...this.identityCard, copied: true };
    window.setTimeout(() => {
      if (this.identityCard?.npub === npub) {
        this.identityCard = { ...this.identityCard, copied: false };
      }
    }, 1400);
  },

  // --- address book ---

  async rememberPeople(npubs = [], source = 'unknown') {
    // Filter out workspace key npubs — only real identities go in the address book
    const wsKeyNpubs = this._wsKeyDisplayMap || {};
    const uniqueNpubs = [...new Set(npubs.filter((n) => n && !wsKeyNpubs[n]))];
    if (uniqueNpubs.length === 0) return;

    const existingPeople = getAddressBookPeopleMap(this);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let wroteAny = false;

    for (const npub of uniqueNpubs) {
      const existing = existingPeople.get(npub) ?? null;
      const nextLabel = this.chatProfiles[npub]?.name ?? null;
      const nextAvatar = this.chatProfiles[npub]?.picture ?? null;
      const nextBio = this.chatProfiles[npub]?.about ?? this.chatProfiles[npub]?.bio ?? null;
      const nextNip05 = this.chatProfiles[npub]?.nip05 ?? null;
      const existingLastUsedAt = Date.parse(existing?.last_used_at || '');
      const shouldTouchTimestamp = !Number.isFinite(existingLastUsedAt)
        || (now - existingLastUsedAt) >= REMEMBER_PEOPLE_TOUCH_MS;
      const shouldWrite = !existing
        || (existing.label ?? null) !== nextLabel
        || (existing.avatar_url ?? null) !== nextAvatar
        || (existing.bio ?? null) !== nextBio
        || (existing.nip05 ?? null) !== nextNip05
        || shouldTouchTimestamp;

      if (shouldWrite) {
        await upsertAddressBookPerson({
          npub,
          label: nextLabel,
          avatar_url: nextAvatar,
          bio: nextBio,
          nip05: nextNip05,
          source: existing?.source || source,
          last_used_at: nowIso,
        });
        wroteAny = true;
      }
      this.resolveChatProfile(npub);
    }

    if (wroteAny) {
      this.addressBookPeople = await getAddressBookPeople();
    }
  },

  // --- people search / suggestions ---

  findPeopleSuggestions(query, excludeNpubs = [], candidateNpubs = null) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    // Build set of ws_key_npubs so we can exclude them from results
    const wsKeyNpubs = new Set(Object.keys(this._wsKeyDisplayMap || {}));

    const existing = new Set((excludeNpubs || []).map((value) => String(value || '').trim()).filter(Boolean));
    const allowed = candidateNpubs?.length
      ? new Set(candidateNpubs.map((value) => String(value || '').trim()).filter(Boolean))
      : null;
    return this.addressBookPeople
      .filter((person) => !wsKeyNpubs.has(person.npub))
      .filter((person) => !allowed || allowed.has(person.npub))
      .filter((person) => !existing.has(person.npub))
      .filter((person) =>
        String(person.npub || '').toLowerCase().includes(needle)
        || String(this.getSenderName(person.npub) || '').toLowerCase().includes(needle)
        || String(person.label || '').toLowerCase().includes(needle)
      )
      .slice(0, 8)
      .map((person) => ({
        npub: person.npub,
        label: this.getSenderName(person.npub),
        subtitle: this.getSenderSecondaryLabel(person.npub),
        avatarUrl: this.getSenderAvatar(person.npub),
      }));
  },

  findGroupMemberSuggestions(query, selectedMembers = []) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const wsKeyNpubs = new Set(Object.keys(this._wsKeyDisplayMap || {}));
    const existing = new Set((selectedMembers || []).map((member) => member.npub));
    const workspaceMemberByNpub = new Map((this.pgWorkspaceMembers || [])
      .map((member) => [String(member?.npub || '').trim(), member])
      .filter(([npub]) => npub));
    const peopleByNpub = new Map(this.addressBookPeople.map((person) => [person.npub, person]));
    for (const [npub, member] of workspaceMemberByNpub) {
      const cached = peopleByNpub.get(npub) || {};
      peopleByNpub.set(npub, {
        ...cached,
        npub,
        label: member.display_name || cached.label || null,
        avatar_url: member.picture || member.avatar_url || member.image || cached.avatar_url || null,
      });
    }
    return [...peopleByNpub.values()]
      .filter((person) => !wsKeyNpubs.has(person.npub))
      .filter((person) => !existing.has(person.npub))
      .filter((person) =>
        String(person.npub || '').toLowerCase().includes(needle)
        || String(this.getSenderName(person.npub) || '').toLowerCase().includes(needle)
        || String(person.label || '').toLowerCase().includes(needle)
      )
      .slice(0, 8)
      .map((person) => {
        const member = workspaceMemberByNpub.get(person.npub);
        return {
          npub: person.npub,
          actorId: member?.actor_id || member?.id || '',
          kind: member?.kind || member?.actor_kind || 'human',
          label: member?.display_name || this.getSenderName(person.npub),
          subtitle: this.getSenderSecondaryLabel(person.npub),
          avatarUrl: member?.picture || member?.avatar_url || member?.image || this.getSenderAvatar(person.npub),
        };
      });
  },

  findFlowApproverSuggestions(query, selectedApprovers = []) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const existing = new Set(
      (selectedApprovers || []).map((value) => String(value || '').trim()).filter(Boolean),
    );
    const wsKeyNpubs = new Set(Object.keys(this._wsKeyDisplayMap || {}));

    const people = this.addressBookPeople
      .filter((person) => !wsKeyNpubs.has(person.npub))
      .filter((person) => !existing.has(person.npub))
      .filter((person) =>
        String(person.npub || '').toLowerCase().includes(needle)
        || String(this.getSenderName(person.npub) || '').toLowerCase().includes(needle)
        || String(person.label || '').toLowerCase().includes(needle)
      )
      .slice(0, 6)
      .map((person) => ({
        type: 'person',
        key: `person:${person.npub}`,
        token: person.npub,
        label: this.getSenderName(person.npub),
        subtitle: this.getSenderSecondaryLabel(person.npub),
        avatarUrl: this.getSenderAvatar(person.npub),
      }));

    const groups = this.groups
      .map((group) => {
        const groupRef = String(group.group_id || group.group_npub || '').trim();
        return {
          group,
          groupRef,
          token: groupRef ? `group:${groupRef}` : '',
        };
      })
      .filter(({ token }) => token && !existing.has(token))
      .filter(({ group, groupRef, token }) =>
        String(group.name || '').toLowerCase().includes(needle)
        || String(groupRef || '').toLowerCase().includes(needle)
        || token.toLowerCase().includes(needle)
        || (group.member_npubs || []).some((member) => String(member || '').toLowerCase().includes(needle))
      )
      .slice(0, 6)
      .map(({ group, token }) => ({
        type: 'group',
        key: token,
        token,
        label: group.name || token.slice(6),
        subtitle: `${(group.member_npubs || []).length} members`,
      }));

    return [...people, ...groups].slice(0, 8);
  },

  getFlowApproverLabel(token) {
    const value = String(token || '').trim();
    if (!value) return '';
    if (value.startsWith('npub1')) {
      return this.getSenderName(value);
    }
    if (value.startsWith('group:')) {
      const groupRef = value.slice(6);
      const group = this.groups.find((candidate) =>
        String(candidate.group_id || '').trim() === groupRef
        || String(candidate.group_npub || '').trim() === groupRef
      );
      return group?.name || groupRef;
    }
    return value;
  },

  getFlowApproverSubtitle(token) {
    const value = String(token || '').trim();
    if (!value) return '';
    if (value.startsWith('npub1')) return this.getSenderSecondaryLabel(value);
    if (value.startsWith('group:')) {
      const groupRef = value.slice(6);
      const group = this.groups.find((candidate) =>
        String(candidate.group_id || '').trim() === groupRef
        || String(candidate.group_npub || '').trim() === groupRef
      );
      return group ? `${(group.member_npubs || []).length} members` : value;
    }
    return value;
  },

  mapGroupDraftMembers(memberNpubs = []) {
    return [...new Set((memberNpubs || []).map((value) => String(value || '').trim()).filter(Boolean))]
      .map((npub) => {
        const member = (this.pgWorkspaceMembers || []).find((candidate) => candidate?.npub === npub);
        this.resolveChatProfile(npub);
        return {
          npub,
          actorId: member?.actor_id || member?.id || '',
          kind: member?.kind || member?.actor_kind || 'human',
          label: member?.display_name || this.getSenderName(npub),
          avatarUrl: member?.picture || member?.avatar_url || member?.image || this.getSenderAvatar(npub),
        };
      });
  },

  consumeGroupMemberQuery(query, currentMembers = []) {
    const raw = String(query || '').trim();
    if (!raw) {
      return {
        added: false,
        members: [...currentMembers],
      };
    }

    const parts = raw.split(',').map((value) => value.trim()).filter(Boolean);
    const nextMembers = [...currentMembers];
    const existing = new Set(nextMembers.map((member) => member.npub));
    let added = false;

    for (const part of parts) {
      if (part.startsWith('npub1') && part.length >= 60 && !existing.has(part)) {
        const member = (this.pgWorkspaceMembers || []).find((candidate) => candidate?.npub === part);
        this.resolveChatProfile(part);
        nextMembers.push({
          npub: part,
          actorId: member?.actor_id || member?.id || '',
          kind: member?.kind || member?.actor_kind || 'human',
          label: member?.display_name || this.getSenderName(part),
          avatarUrl: member?.picture || member?.avatar_url || member?.image || this.getSenderAvatar(part),
        });
        existing.add(part);
        added = true;
      }
    }

    if (added) {
      return {
        added: true,
        members: nextMembers,
      };
    }

    const suggestions = this.findGroupMemberSuggestions(raw, currentMembers);
    if (suggestions.length > 0) {
      return {
        added: true,
        members: [...currentMembers, suggestions[0]],
      };
    }

    return {
      added: false,
      members: [...currentMembers],
    };
  },

  // --- computed getters ---

  get docShareSuggestions() {
    const needle = String(this.docShareQuery || '').trim().toLowerCase();
    if (!needle) return [];

    const sharedPeople = new Set(
      this.docEditorShares
        .filter((share) => share.type === 'person')
        .map((share) => share.person_npub)
    );
    const sharedGroups = new Set(
      this.docEditorShares
        .filter((share) => share.type === 'group')
        .map((share) => share.group_id || share.group_npub)
    );

    const people = this.addressBookPeople
      .filter((person) => !sharedPeople.has(person.npub))
      .filter((person) =>
        String(person.npub || '').toLowerCase().includes(needle)
        || String(this.getSenderName(person.npub) || '').toLowerCase().includes(needle)
        || String(person.label || '').toLowerCase().includes(needle)
      )
      .slice(0, 6)
      .map((person) => ({
        type: 'person',
        key: `person:${person.npub}`,
        npub: person.npub,
        label: this.getSenderName(person.npub),
        subtitle: this.getSenderSecondaryLabel(person.npub),
        avatarUrl: this.getSenderAvatar(person.npub),
      }));

    const groups = this.groups
      .filter((group) => !sharedGroups.has(group.group_id || group.group_npub))
      .filter((group) =>
        String(group.name || '').toLowerCase().includes(needle)
        || (group.member_npubs || []).some((member) => member.toLowerCase().includes(needle))
      )
      .slice(0, 6)
      .map((group) => ({
        type: 'group',
        key: `group:${group.group_id || group.group_npub}`,
        group_npub: group.group_id || group.group_npub,
        label: group.name,
        subtitle: `${(group.member_npubs || []).length} members`,
      }));

    return [...people, ...groups];
  },

  get groupMemberSuggestions() {
    return this.findGroupMemberSuggestions(this.newGroupMemberQuery, this.newGroupMembers);
  },

  get editGroupMemberSuggestions() {
    return this.findGroupMemberSuggestions(this.editGroupMemberQuery, this.editGroupMembers);
  },

  get taskAssigneeSuggestions() {
    const assigned = typeof this.getTaskAssigneeNpubs === 'function'
      ? this.getTaskAssigneeNpubs(this.editingTask)
      : [];
    return this.findPeopleSuggestions(this.taskAssigneeQuery, assigned);
  },

  get defaultAgentSuggestions() {
    return this.findPeopleSuggestions(this.defaultAgentQuery, [this.defaultAgentNpub]);
  },

  get harnessAgentSuggestions() {
    return this.findPeopleSuggestions(this.wingmanHarnessAgentQuery, [
      this.wingmanHarnessDraftAgentNpub,
      ...(this.workspaceHarnessAgents || []).map((entry) => entry?.agent_npub),
    ]);
  },

  get defaultAgentLabel() {
    return this.defaultAgentNpub ? this.getSenderName(this.defaultAgentNpub) : '';
  },

  get canDoTaskWithDefaultAgent() {
    const editable = typeof this.isTaskDetailEditing === 'function' ? this.isTaskDetailEditing() : true;
    return Boolean(this.defaultAgentNpub && this.editingTask && editable);
  },
};
