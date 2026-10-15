import { nip19, nip57, verifyEvent } from 'nostr-tools';
import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
const PUBLIC_CONTENT_KINDS = new Set([1, 20, 1063, 30023, 30024]);
const HEX = /^[a-f0-9]{64}$/;
const tags = (event, key) => event.tags.filter((t) => t[0] === key);
const only = (event, key) => {
  const values = tags(event, key);
  return values.length === 1 ? values[0][1] : null;
};
export function validPublicEvent(event, now = Math.floor(Date.now() / 1000)) {
  try {
    return (
      event &&
      Number.isSafeInteger(event.kind) &&
      Number.isSafeInteger(event.created_at) &&
      event.created_at >= 0 &&
      event.created_at <= now + 300 &&
      event.content.length <= 32768 &&
      event.tags.length <= 256 &&
      JSON.stringify(event).length <= 65536 &&
      verifyEvent(JSON.parse(JSON.stringify(event)))
    );
  } catch {
    return false;
  }
}
// Decode the invoice checksum, amount and description-hash commitment. Payment
// itself is attested by the recipient's LNURL provider, never proved by a receipt.
export function zapInvoice(invoice, description, preimage = '') {
  try {
    const { prefix, words } = bech32.decode(invoice, 8192);
    const match = /^lnbc([1-9]\d*)([munp]?)$/.exec(prefix);
    if (!match || words.length < 111) return null;
    const scales = { '': 100000000000n, m: 100000000n, u: 100000n, n: 100n, p: 1n };
    let amount = BigInt(match[1]) * scales[match[2]];
    if (match[2] === 'p') {
      if (amount % 10n) return null;
      amount /= 10n;
    }
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const fields = new Map();
    for (let i = 7; i < words.length - 104; ) {
      const type = words[i++],
        length = words[i++] * 32 + words[i++];
      if (!Number.isInteger(length) || i + length > words.length - 104) return null;
      if ([1, 13, 16, 19, 23].includes(type) && fields.has(type)) return null;
      fields.set(type, words.slice(i, i + length));
      i += length;
    }
    if (fields.has(13) || !fields.has(16) || bech32.fromWords(fields.get(16)).length !== 32)
      return null;
    const hash = fields.get(23); // BOLT11 h (description hash)
    if (
      !hash ||
      bytesToHex(bech32.fromWords(hash)) !==
        bytesToHex(sha256(new TextEncoder().encode(description)))
    )
      return null;
    if (!fields.get(1) || bech32.fromWords(fields.get(1)).length !== 32) return null;
    if (
      preimage &&
      (!HEX.test(preimage) ||
        bytesToHex(sha256(hexToBytes(preimage))) !== bytesToHex(bech32.fromWords(fields.get(1))))
    )
      return null;
    const signature = bech32.fromWords(words.slice(-104));
    if (signature.length !== 65 || signature[64] > 3) return null;
    const signingWords = words.slice(0, -104);
    // BOLT11 signs the HRP followed by the data words packed into bytes with
    // zero padding, excluding the signature and checksum.
    const packed = [];
    let accumulator = 0,
      bits = 0;
    for (const word of signingWords) {
      accumulator = (accumulator << 5) | word;
      bits += 5;
      while (bits >= 8) {
        bits -= 8;
        packed.push((accumulator >>> bits) & 255);
      }
    }
    if (bits) packed.push((accumulator << (8 - bits)) & 255);
    const message = sha256(new Uint8Array([...new TextEncoder().encode(prefix), ...packed]));
    const compact = signature.slice(0, 64);
    const signer = secp256k1.Signature.fromBytes(compact)
      .addRecoveryBit(signature[64])
      .recoverPublicKey(message)
      .toBytes(true);
    if (!secp256k1.verify(compact, message, signer, { prehash: false, lowS: fields.has(19) }))
      return null;
    if (fields.has(19) && bytesToHex(bech32.fromWords(fields.get(19))) !== bytesToHex(signer))
      return null;
    return Number(amount);
  } catch {
    return null;
  }
}
export async function normalizeNostrNotification(
  event,
  recipient,
  { getEvent, getZapProvider, now } = {},
) {
  if (
    !HEX.test(recipient) ||
    !validPublicEvent(event, now) ||
    event.created_at < (now ?? Math.floor(Date.now() / 1000)) - 7 * 86400 ||
    (event.kind !== 9735 && event.pubkey === recipient) ||
    ![1, 6, 7, 16, 9735].includes(event.kind)
  )
    return null;
  let actor = event.pubkey,
    type,
    text = event.content,
    targetId = '',
    amount = null;
  const references = tags(event, 'e').filter((t) => HEX.test(t[1]));
  const pTags = tags(event, 'p');
  if (event.kind === 1) {
    if (!pTags.some((t) => t[1] === recipient)) return null;
    const reply =
      references.find((t) => t[3] === 'reply') || references.filter((t) => !t[3]).at(-1);
    const target = reply && (await getEvent?.(reply[1], [reply[2]].filter(Boolean)));
    type =
      target?.id === reply?.[1] &&
      target?.pubkey === recipient &&
      PUBLIC_CONTENT_KINDS.has(target.kind) &&
      validPublicEvent(target, now)
        ? 'Reply'
        : 'Mention';
    targetId = type === 'Reply' ? target.id : '';
  } else if (event.kind === 7 || event.kind === 6 || event.kind === 16) {
    // NIP-25's final e/p tags identify the actual reaction target.
    targetId = tags(event, 'e').at(-1)?.[1];
    if (!HEX.test(targetId || '') || pTags.at(-1)?.[1] !== recipient) return null;
    const target = await getEvent?.(
      targetId,
      tags(event, 'e')
        .filter((t) => t[1] === targetId)
        .map((t) => t[2])
        .filter(Boolean),
    );
    if (
      !target ||
      target.id !== targetId ||
      target.pubkey !== recipient ||
      !PUBLIC_CONTENT_KINDS.has(target.kind) ||
      !validPublicEvent(target, now)
    )
      return null;
    if (event.kind === 6 && target.kind !== 1) return null;
    if (event.kind === 16 && only(event, 'k') !== String(target.kind)) return null;
    if (event.kind !== 7 && event.content) {
      let embedded;
      try {
        embedded = JSON.parse(event.content);
      } catch {
        return null;
      }
      if (!validPublicEvent(embedded, now) || embedded.id !== targetId) return null;
    }
    type = event.kind === 7 ? 'Reaction' : 'Repost';
    text = `${event.kind === 7 ? event.content || '+' : 'Reposted'} · ${target.content}`;
  } else {
    const description = only(event, 'description'),
      invoice = only(event, 'bolt11');
    if (
      !description ||
      !invoice ||
      only(event, 'p') !== recipient ||
      nip57.validateZapRequest(description)
    )
      return null;
    const request = JSON.parse(description);
    if (
      request.kind !== 9734 ||
      !validPublicEvent(request, now) ||
      only(request, 'p') !== recipient ||
      request.pubkey === recipient ||
      tags(request, 'anon').length
    )
      return null;
    if (
      tags(request, 'e').length > 1 ||
      tags(request, 'a').length > 1 ||
      tags(request, 'amount').length > 1
    )
      return null;
    for (const key of ['e', 'a']) {
      if (tags(event, key).length > 1 || (only(event, key) || '') !== (only(request, key) || ''))
        return null;
    }
    if (tags(event, 'P').length > 1 || (only(event, 'P') && only(event, 'P') !== request.pubkey))
      return null;
    if (
      tags(request, 'P').length > 1 ||
      (only(request, 'P') && only(request, 'P') !== event.pubkey)
    )
      return null;
    amount = zapInvoice(invoice, description, only(event, 'preimage') || '');
    if (tags(event, 'preimage').length > 1) return null;
    if (!amount || (only(request, 'amount') && only(request, 'amount') !== String(amount)))
      return null;
    if ((await getZapProvider?.()) !== event.pubkey) return null;
    targetId = only(request, 'e') || '';
    if (targetId) {
      const target = await getEvent?.(
        targetId,
        tags(event, 'e')
          .filter((t) => t[1] === targetId)
          .map((t) => t[2])
          .filter(Boolean),
      );
      if (
        !target ||
        target.pubkey !== recipient ||
        !PUBLIC_CONTENT_KINDS.has(target.kind) ||
        !validPublicEvent(target, now)
      )
        return null;
    }
    if (only(request, 'a')) {
      const coordinate = only(request, 'a').split(':');
      if (
        !/^\d+$/.test(coordinate[0]) ||
        Number(coordinate[0]) < 30000 ||
        Number(coordinate[0]) >= 40000 ||
        coordinate[1] !== recipient ||
        coordinate.length < 3
      )
        return null;
    }
    actor = request.pubkey;
    type = 'Zap';
    text = request.content;
  }
  const actorNpub = nip19.npubEncode(actor);
  return {
    id: event.id,
    origin: 'nostr',
    recipient,
    actorNpub,
    type,
    targetId,
    amount,
    source_title: `Nostr · ${type}`,
    title: `${type} from ${actorNpub.slice(0, 16)}…${amount ? ` · ${amount / 1000} sats` : ''}`,
    text: String(text).slice(0, 4000),
    published: new Date(event.created_at * 1000).toISOString(),
    url: `https://njump.me/${nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind })}`,
    attachments: [],
  };
}
