/**
 * SY-1 Studio — Standard MIDI File (SMF Format 1) Encoder & Parser
 *
 * Format 1 layout:
 * - Track 0 (Conductor): Track Name, Set Tempo (FF 51), Time Signature 4/4 (FF 58), End of Track
 * - Tracks 1..N: One independent MTrk per SY-1 Studio track with sorted Note On/Off, CC, Pitch Bend,
 *   automatic closure of any dangling open notes, and End of Track aligned to project length.
 */

import { ParsedMidiFile, ParsedMidiTrack, STUDIO_PPQ, StudioMidiEvent, StudioNoteSpan } from "./types";

export interface MidiExportTrackInput {
  name: string;
  /** 0 = auto-assign by track index, 1..16 = explicit MIDI channel */
  midiChannel?: number;
  events: StudioMidiEvent[];
}

function writeVlq(out: number[], value: number): void {
  let n = Math.max(0, Math.round(value));
  const stack = [n & 0x7f];
  while ((n >>>= 7) > 0) {
    stack.unshift((n & 0x7f) | 0x80);
  }
  for (let i = 0; i < stack.length; i++) out.push(stack[i]);
}

function writeUint32BE(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function writeUint16BE(out: number[], value: number): void {
  out.push((value >>> 8) & 0xff, value & 0xff);
}

function encodeMetaText(out: number[], delta: number, metaType: number, text: string): void {
  const bytes = Array.from(new TextEncoder().encode(text.slice(0, 120)));
  writeVlq(out, delta);
  out.push(0xff, metaType);
  writeVlq(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

function eventSortPriority(ev: StudioMidiEvent): number {
  if (ev.type === "noteOff") return 0;
  if (ev.type === "cc") return 1;
  if (ev.type === "pitchBend") return 2;
  return 3; // noteOn
}

function clamp7(v: number): number {
  return Math.max(0, Math.min(127, Math.round(v)));
}

function wrapChunk(tag: string, body: number[]): number[] {
  const out: number[] = [
    tag.charCodeAt(0),
    tag.charCodeAt(1),
    tag.charCodeAt(2),
    tag.charCodeAt(3)
  ];
  writeUint32BE(out, body.length);
  for (let i = 0; i < body.length; i++) out.push(body[i]);
  return out;
}

/** Encode Studio tracks into an SMF Format 1 multi-track MIDI binary. */
export function encodeStudioMidi(
  tracks: MidiExportTrackInput[],
  bpm: number,
  totalTicks: number,
  projectName = "SY-1 Studio",
  ppq = STUDIO_PPQ
): Uint8Array {
  const safeBpm = Math.max(20, Math.min(300, Number.isFinite(bpm) ? bpm : 110));
  const safeTotalTicks = Math.max(0, Math.round(totalTicks));
  const ntrks = 1 + tracks.length;

  // MThd header: format 1, ntrks = 1 + N, division = ppq
  const headerBody: number[] = [];
  writeUint16BE(headerBody, 1);
  writeUint16BE(headerBody, ntrks);
  writeUint16BE(headerBody, ppq);
  const bytes: number[] = wrapChunk("MThd", headerBody);

  // Track 0: Conductor (Tempo + 4/4 Time Signature)
  const conductor: number[] = [];
  encodeMetaText(conductor, 0, 0x03, projectName);
  const usPerQuarter = Math.round(60_000_000 / safeBpm);
  writeVlq(conductor, 0);
  conductor.push(
    0xff,
    0x51,
    0x03,
    (usPerQuarter >>> 16) & 0xff,
    (usPerQuarter >>> 8) & 0xff,
    usPerQuarter & 0xff
  );
  writeVlq(conductor, 0);
  conductor.push(0xff, 0x58, 0x04, 4, 2, 24, 8); // 4/4
  writeVlq(conductor, 0);
  conductor.push(0xff, 0x2f, 0x00); // End of Track
  bytes.push(...wrapChunk("MTrk", conductor));

  // Tracks 1..N
  tracks.forEach((track, idx) => {
    const ch =
      track.midiChannel && track.midiChannel >= 1 && track.midiChannel <= 16
        ? track.midiChannel - 1
        : idx % 16;

    const sorted = track.events
      .map((ev, order) => ({ ev, order, tick: Math.max(0, Math.round(ev.tick)) }))
      .sort((a, b) => a.tick - b.tick || eventSortPriority(a.ev) - eventSortPriority(b.ev) || a.order - b.order);

    const body: number[] = [];
    encodeMetaText(body, 0, 0x03, track.name || `SY-1 Track ${idx + 1}`);

    const openNotes = new Set<number>();
    let lastTick = 0;

    for (const item of sorted) {
      const ev = item.ev;
      const tick = item.tick;
      const delta = Math.max(0, tick - lastTick);
      lastTick = tick;

      if (ev.type === "noteOn") {
        const midi = clamp7(ev.midi);
        const vel = Math.max(1, clamp7(ev.velocity * 127));
        writeVlq(body, delta);
        body.push(0x90 | ch, midi, vel);
        openNotes.add(midi);
      } else if (ev.type === "noteOff") {
        const midi = clamp7(ev.midi);
        writeVlq(body, delta);
        body.push(0x80 | ch, midi, 0);
        openNotes.delete(midi);
      } else if (ev.type === "cc") {
        writeVlq(body, delta);
        body.push(0xb0 | ch, clamp7(ev.cc), clamp7(ev.value));
      } else if (ev.type === "pitchBend") {
        const raw = Math.max(0, Math.min(16383, Math.round((ev.value + 1) * 8192)));
        writeVlq(body, delta);
        body.push(0xe0 | ch, raw & 0x7f, (raw >>> 7) & 0x7f);
      }
    }

    // Close any dangling notes cleanly at endTick
    const endTick = Math.max(lastTick, safeTotalTicks);
    if (openNotes.size > 0) {
      let first = true;
      for (const midi of openNotes) {
        writeVlq(body, first ? Math.max(0, endTick - lastTick) : 0);
        first = false;
        body.push(0x80 | ch, midi, 0);
      }
      lastTick = endTick;
    }

    writeVlq(body, Math.max(0, endTick - lastTick));
    body.push(0xff, 0x2f, 0x00);
    bytes.push(...wrapChunk("MTrk", body));
  });

  return new Uint8Array(bytes);
}

/** Pair Note On / Note Off events into renderable note spans for timeline visualization. */
export function extractNoteSpans(events: StudioMidiEvent[], fallbackEndTick: number): StudioNoteSpan[] {
  const sorted = events
    .map((ev, order) => ({ ev, order, tick: Math.max(0, Math.round(ev.tick)) }))
    .sort((a, b) => a.tick - b.tick || eventSortPriority(a.ev) - eventSortPriority(b.ev) || a.order - b.order);

  const open = new Map<number, { startTick: number; velocity: number }>();
  const spans: StudioNoteSpan[] = [];

  for (const { ev, tick } of sorted) {
    if (ev.type === "noteOn") {
      const existing = open.get(ev.midi);
      if (existing) {
        spans.push({
          midi: ev.midi,
          startTick: existing.startTick,
          endTick: Math.max(existing.startTick + 1, tick),
          velocity: existing.velocity
        });
      }
      open.set(ev.midi, { startTick: tick, velocity: ev.velocity });
    } else if (ev.type === "noteOff") {
      const existing = open.get(ev.midi);
      if (existing) {
        spans.push({
          midi: ev.midi,
          startTick: existing.startTick,
          endTick: Math.max(existing.startTick + 1, tick),
          velocity: existing.velocity
        });
        open.delete(ev.midi);
      }
    }
  }

  for (const [midi, info] of open) {
    spans.push({
      midi,
      startTick: info.startTick,
      endTick: Math.max(info.startTick + 1, fallbackEndTick),
      velocity: info.velocity
    });
  }

  return spans;
}

/** Parse a binary Standard MIDI File (Format 0 or 1) for validation & round-trip inspection. */
export function parseStudioMidi(bytes: Uint8Array): ParsedMidiFile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 14) throw new Error("MIDI file too short");

  const readTag = (off: number) =>
    String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);

  if (readTag(0) !== "MThd") throw new Error("Missing MThd header");
  const headerLen = dv.getUint32(4, false);
  if (headerLen < 6) throw new Error("Invalid MThd length");

  const format = dv.getUint16(8, false);
  const trackCount = dv.getUint16(10, false);
  const ppq = dv.getUint16(12, false);

  let offset = 8 + headerLen;
  let bpm = 120;
  const tracks: ParsedMidiTrack[] = [];

  for (let t = 0; t < trackCount && offset + 8 <= bytes.byteLength; t++) {
    const tag = readTag(offset);
    const len = dv.getUint32(offset + 4, false);
    offset += 8;
    const end = Math.min(bytes.byteLength, offset + len);
    if (tag !== "MTrk") {
      offset = end;
      continue;
    }

    let pos = offset;
    let tick = 0;
    let runningStatus = 0;
    let name = "";
    let trackChannel = 0;
    const events: StudioMidiEvent[] = [];

    const readVlq = (): number => {
      let val = 0;
      while (pos < end) {
        const b = bytes[pos++];
        val = (val << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      return val;
    };

    while (pos < end) {
      const delta = readVlq();
      tick += delta;
      if (pos >= end) break;

      let status = bytes[pos];
      if (status >= 0x80) {
        pos++;
        if (status < 0xf0) runningStatus = status;
      } else {
        status = runningStatus;
      }

      if (status === 0xff) {
        if (pos >= end) break;
        const metaType = bytes[pos++];
        const metaLen = readVlq();
        const metaEnd = Math.min(end, pos + metaLen);
        if (metaType === 0x03) {
          name = new TextDecoder().decode(bytes.subarray(pos, metaEnd));
        } else if (metaType === 0x51 && metaLen === 3 && pos + 3 <= end) {
          const us = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
          if (us > 0) bpm = 60_000_000 / us;
        } else if (metaType === 0x2f) {
          pos = metaEnd;
          break;
        }
        pos = metaEnd;
      } else if (status === 0xf0 || status === 0xf7) {
        const sysLen = readVlq();
        pos = Math.min(end, pos + sysLen);
      } else {
        const cmd = status & 0xf0;
        const ch = (status & 0x0f) + 1;
        if (trackChannel === 0) trackChannel = ch;
        if (cmd === 0x90) {
          const midi = bytes[pos++] & 0x7f;
          const vel = bytes[pos++] & 0x7f;
          if (vel > 0) events.push({ type: "noteOn", tick, midi, velocity: vel / 127 });
          else events.push({ type: "noteOff", tick, midi });
        } else if (cmd === 0x80) {
          const midi = bytes[pos++] & 0x7f;
          pos++; // release velocity
          events.push({ type: "noteOff", tick, midi });
        } else if (cmd === 0xb0) {
          const cc = bytes[pos++] & 0x7f;
          const val = bytes[pos++] & 0x7f;
          events.push({ type: "cc", tick, cc, value: val });
        } else if (cmd === 0xe0) {
          const lsb = bytes[pos++] & 0x7f;
          const msb = bytes[pos++] & 0x7f;
          const val14 = (msb << 7) | lsb;
          events.push({ type: "pitchBend", tick, value: (val14 - 8192) / 8192 });
        } else if (cmd === 0xc0 || cmd === 0xd0) {
          pos += 1;
        } else if (cmd === 0xa0) {
          pos += 2;
        } else {
          break;
        }
      }
    }

    tracks.push({ name, channel: trackChannel, events });
    offset = end;
  }

  return { format, trackCount, ppq, bpm, tracks };
}
