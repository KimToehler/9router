// Claude thinking signature validation (ported from CLIProxyAPI internal/signature).
// E-form: single-layer base64, decoded[0] == 0x12 (Claude marker).
// R-form: double-layer base64, outer decoded[0] == 'E', inner decoded[0] == 0x12.
// C-form (CAIS/CAQS, current Anthropic models): single-layer base64, decoded[0] == 0x08.
//   The payload is a protobuf envelope: field 1 varint (envelope version), field 2
//   the container (field 1 = channel block), optional field 3 varint. Validation is
//   structural; version, channel id and block kind are incidental and not pinned.
//   A "C" prefix alone is not enough: Gemini CLI signatures start with "C" too.
// Cache prefix "...#sig" stripped before validation.

const MAX_CLAUDE_SIGNATURE_LEN = 32 * 1024 * 1024;
const CLAUDE_SIGNATURE_MARKER = 0x12;
const CLAUDE_CAIS_MARKER = 0x08;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

function stripCachePrefix(rawSignature) {
  const sig = (rawSignature || "").trim();
  if (!sig) return "";
  const idx = sig.indexOf("#");
  return idx >= 0 ? sig.slice(idx + 1).trim() : sig;
}

// Returns the end offset of the varint at `pos`, or -1 if it runs past `end`.
function skipVarint(buf, pos, end) {
  for (let i = 0; i < 10 && pos < end; i++) {
    if ((buf[pos++] & 0x80) === 0) return pos;
  }
  return -1;
}

function readVarint(buf, pos, end) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10 && pos < end; i++) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, pos };
    scale *= 128;
  }
  return null;
}

// Parses buf[start, end) as protobuf fields. Returns null unless the whole range
// is a well-formed field sequence; length-delimited fields are returned as
// [start, end) ranges so callers can descend without copying.
function parseFields(buf, start, end) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    const key = readVarint(buf, pos, end);
    if (!key) return null;
    const number = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (number === 0) return null;
    pos = key.pos;
    if (wireType === WIRE_VARINT) {
      pos = skipVarint(buf, pos, end);
      if (pos < 0) return null;
      fields.push({ number, wireType });
    } else if (wireType === WIRE_BYTES) {
      const len = readVarint(buf, pos, end);
      if (!len || len.pos + len.value > end) return null;
      fields.push({ number, wireType, start: len.pos, end: len.pos + len.value });
      pos = len.pos + len.value;
    } else if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
      pos += wireType === WIRE_FIXED64 ? 8 : 4;
      if (pos > end) return null;
      fields.push({ number, wireType });
    } else {
      return null;
    }
  }
  return fields;
}

function singleBytesField(fields, number) {
  const matches = fields.filter(f => f.number === number);
  return matches.length === 1 && matches[0].wireType === WIRE_BYTES ? matches[0] : null;
}

// envelope → exactly one container (field 2) → exactly one non-empty channel
// block (field 1) → channel block itself is a protobuf message.
function isClaudeCaisPayload(decoded) {
  if (decoded[0] !== CLAUDE_CAIS_MARKER) return false;
  const envelope = parseFields(decoded, 0, decoded.length);
  const container = envelope && singleBytesField(envelope, 2);
  if (!container) return false;
  const containerFields = parseFields(decoded, container.start, container.end);
  const channel = containerFields && singleBytesField(containerFields, 1);
  if (!channel || channel.end === channel.start) return false;
  return parseFields(decoded, channel.start, channel.end) !== null;
}

// Strict-ish: validates base64 layers + Claude marker byte (E/R) or envelope structure (C).
export function isValidClaudeSignature(rawSignature) {
  const sig = stripCachePrefix(rawSignature);
  if (!sig || sig.length > MAX_CLAUDE_SIGNATURE_LEN) return false;

  try {
    if (sig[0] === "E") {
      const decoded = Buffer.from(sig, "base64");
      return decoded.length > 0 && decoded[0] === CLAUDE_SIGNATURE_MARKER;
    }
    if (sig[0] === "R") {
      const outer = Buffer.from(sig, "base64");
      if (!outer.length || outer[0] !== 0x45) return false; // 'E'
      const inner = Buffer.from(outer.toString(), "base64");
      return inner.length > 0 && inner[0] === CLAUDE_SIGNATURE_MARKER;
    }
    if (sig[0] === "C") {
      // Buffer.from silently skips invalid characters; a structural check needs exact bytes.
      if (sig.length % 4 !== 0 || !BASE64.test(sig)) return false;
      return isClaudeCaisPayload(Buffer.from(sig, "base64"));
    }
    return false;
  } catch {
    return false;
  }
}
