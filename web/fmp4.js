/* Minimal fragmented-MP4 (DASH) parser for YouTube's H.264 video-only formats.
 * parseInit(bytes)            -> { codec, description, width, height, timescale, segments[] } from ftyp+moov+sidx
 * parseSegment(bytes, init)   -> [{ pts, dts, dur, key, data }] (seconds; data = Uint8Array view) from moof+mdat
 * UMD: works in the browser (window.FMP4) and in node (module.exports) for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FMP4 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function dv(b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); }
  function type4(b, o) { return String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]); }

  // List boxes in b[start, end). Partial (truncated) last box is reported with partial:true.
  function boxes(b, start, end) {
    const v = dv(b); const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = v.getUint32(o); let hdr = 8;
      const type = type4(b, o);
      if (size === 1) { if (o + 16 > end) { out.push({ type, start: o, partial: true }); break; } size = Number(v.getBigUint64(o + 8)); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr) break;
      if (o + size > end) { out.push({ type, start: o, hdr, size, partial: true }); break; }
      out.push({ type, start: o, hdr, size, body: o + hdr, end: o + size });
      o += size;
    }
    return out;
  }
  function child(b, box, type, skip) {
    return boxes(b, box.body + (skip || 0), box.end).find((x) => x.type === type && !x.partial);
  }
  function path(b, box, types) {
    let cur = box;
    for (const t of types) { if (!cur) return null; cur = child(b, cur, t); }
    return cur;
  }

  function parseSidx(b, box) {
    const v = dv(b); let p = box.body;
    const ver = b[p]; p += 4;
    p += 4; // reference_ID
    const ts = v.getUint32(p); p += 4;
    let ept, first;
    if (ver === 0) { ept = v.getUint32(p); first = v.getUint32(p + 4); p += 8; }
    else { ept = Number(v.getBigUint64(p)); first = Number(v.getBigUint64(p + 8)); p += 16; }
    p += 2;
    const n = v.getUint16(p); p += 2;
    let off = box.end + first; let t = ept;
    const segs = [];
    for (let i = 0; i < n; i++) {
      const a = v.getUint32(p); const dur = v.getUint32(p + 4); p += 12;
      const size = a & 0x7fffffff;
      segs.push({ t: t / ts, dur: dur / ts, offset: off, size });
      off += size; t += dur;
    }
    return segs;
  }

  // AudioSpecificConfig from an esds box (ES_Descriptor -> DecoderConfig -> DecoderSpecificInfo).
  function esdsConfig(b, esds) {
    if (!esds) return null;
    let p = esds.body + 4;
    const readLen = () => { let n = 0; for (let i = 0; i < 4; i++) { const c = b[p++]; n = (n << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return n; };
    while (p < esds.end) {
      const tag = b[p++]; const len = readLen();
      if (tag === 3) { const fl = b[p + 2]; p += 3; if (fl & 0x80) p += 2; if (fl & 0x40) p += 1 + b[p]; if (fl & 0x20) p += 2; continue; }
      if (tag === 4) { p += 13; continue; }
      if (tag === 5) return b.slice(p, p + len);
      p += len;
    }
    return null;
  }

  // Returns null if more bytes are needed (sidx not complete yet).
  function parseInit(b) {
    const top = boxes(b, 0, b.byteLength);
    const moov = top.find((x) => x.type === 'moov');
    if (!moov || moov.partial) return null;
    const sidx = top.find((x) => x.type === 'sidx');
    if (!sidx || sidx.partial) {
      // sidx must follow moov; if it's absent entirely the file isn't a DASH fragment file
      const after = top.filter((x) => x.start > moov.start);
      if (after.some((x) => x.type === 'moof' || x.type === 'mdat') && !sidx) throw new Error('no sidx (not a DASH fragmented file)');
      return null;
    }
    const v = dv(b);
    const traks = boxes(b, moov.body, moov.end).filter((x) => x.type === 'trak');
    let res = null;
    for (const trak of traks) {
      const mdia = child(b, trak, 'mdia');
      const stsd = path(b, mdia, ['minf', 'stbl', 'stsd']);
      if (!stsd) continue;
      const mdhd = child(b, mdia, 'mdhd');
      const timescale = v.getUint32(mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
      // stsd: fullbox(4) + entry_count(4) then sample entries
      const entries = boxes(b, stsd.body + 8, stsd.end);
      const avc = entries.find((x) => x.type === 'avc1' || x.type === 'avc3');
      if (avc) {
        const width = v.getUint16(avc.body + 24); const height = v.getUint16(avc.body + 26);
        const avcC = boxes(b, avc.body + 78, avc.end).find((x) => x.type === 'avcC');
        if (!avcC) throw new Error('no avcC');
        const description = b.slice(avcC.body, avcC.end);
        const hex = (n) => n.toString(16).padStart(2, '0');
        res = { kind: 'video', codec: 'avc1.' + hex(description[1]) + hex(description[2]) + hex(description[3]), description, width, height, timescale };
        break;
      }
      const mp4a = entries.find((x) => x.type === 'mp4a');
      if (mp4a) {
        const channels = v.getUint16(mp4a.body + 16);
        const sampleRate = v.getUint32(mp4a.body + 24) >>> 16;
        const esds = boxes(b, mp4a.body + 28, mp4a.end).find((x) => x.type === 'esds');
        const description = esdsConfig(b, esds);
        const objType = description ? (description[0] >> 3) : 2;
        res = { kind: 'audio', codec: 'mp4a.40.' + objType, description, sampleRate, channels, timescale };
        break;
      }
    }
    if (!res) throw new Error('no H.264 or AAC track');
    // trex defaults (mvex/trex)
    const trex = path(b, moov, ['mvex', 'trex']);
    res.trex = trex ? { dur: v.getUint32(trex.body + 12), size: v.getUint32(trex.body + 16), flags: v.getUint32(trex.body + 20) } : { dur: 0, size: 0, flags: 0 };
    res.segments = parseSidx(b, sidx);
    const last = res.segments[res.segments.length - 1];
    res.duration = last ? last.t + last.dur : 0;
    res.initEnd = sidx.end;
    return res;
  }

  function parseSegment(b, init, segFileOffset) {
    const v = dv(b); const ts = init.timescale; const out = [];
    const top = boxes(b, 0, b.byteLength);
    for (const moof of top.filter((x) => x.type === 'moof' && !x.partial)) {
      for (const traf of boxes(b, moof.body, moof.end).filter((x) => x.type === 'traf')) {
        const kids = boxes(b, traf.body, traf.end);
        const tfhd = kids.find((x) => x.type === 'tfhd');
        let p = tfhd.body; const tf = v.getUint32(p) & 0xffffff; p += 8; // flags + track_ID
        let base = moof.start;
        if (tf & 0x1) { base = Number(v.getBigUint64(p)) - (segFileOffset || 0); p += 8; }
        if (tf & 0x2) p += 4;
        let dDur = init.trex.dur, dSize = init.trex.size, dFlags = init.trex.flags;
        if (tf & 0x8) { dDur = v.getUint32(p); p += 4; }
        if (tf & 0x10) { dSize = v.getUint32(p); p += 4; }
        if (tf & 0x20) { dFlags = v.getUint32(p); p += 4; }
        const tfdt = kids.find((x) => x.type === 'tfdt');
        let dts = 0;
        if (tfdt) dts = b[tfdt.body] === 1 ? Number(v.getBigUint64(tfdt.body + 4)) : v.getUint32(tfdt.body + 4);
        let dataPos = base;
        for (const trun of kids.filter((x) => x.type === 'trun')) {
          let q = trun.body; const ver = b[q]; const fl = v.getUint32(q) & 0xffffff; q += 4;
          const n = v.getUint32(q); q += 4;
          if (fl & 0x1) { dataPos = base + v.getInt32(q); q += 4; }
          let firstFlags = null;
          if (fl & 0x4) { firstFlags = v.getUint32(q); q += 4; }
          for (let i = 0; i < n; i++) {
            let dur = dDur, size = dSize, flags = dFlags, cto = 0;
            if (fl & 0x100) { dur = v.getUint32(q); q += 4; }
            if (fl & 0x200) { size = v.getUint32(q); q += 4; }
            if (fl & 0x400) { flags = v.getUint32(q); q += 4; } else if (i === 0 && firstFlags !== null) flags = firstFlags;
            if (fl & 0x800) { cto = ver === 1 ? v.getInt32(q) : v.getUint32(q); q += 4; }
            if (dataPos + size > b.byteLength) throw new Error('segment truncated');
            out.push({ dts: dts / ts, pts: (dts + cto) / ts, dur: dur / ts, key: !(flags & 0x10000), data: b.subarray(dataPos, dataPos + size) });
            dataPos += size; dts += dur;
          }
        }
      }
    }
    return out;
  }

  // ---- progressive (non-fragmented) MP4 audio, e.g. YouTube itag 140 m4a ----
  // parseAudioMoov(bytes) -> { codec, description(AudioSpecificConfig), sampleRate, channels,
  //   timescale, samples: [{offset,size,t,dur}] } or null if moov isn't complete yet.
  function parseAudioMoov(b) {
    const top = boxes(b, 0, b.byteLength);
    const moov = top.find((x) => x.type === 'moov');
    if (!moov || moov.partial) return null;
    const v = dv(b);
    const trak = child(b, moov, 'trak');
    const mdia = child(b, trak, 'mdia');
    const mdhd = child(b, mdia, 'mdhd');
    const timescale = v.getUint32(mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
    const stbl = path(b, mdia, ['minf', 'stbl']);
    const stsd = child(b, stbl, 'stsd');
    const mp4a = boxes(b, stsd.body + 8, stsd.end).find((x) => x.type === 'mp4a');
    const channels = v.getUint16(mp4a.body + 16);
    const sampleRate = v.getUint32(mp4a.body + 24) >>> 16;
    const esds = boxes(b, mp4a.body + 28, mp4a.end).find((x) => x.type === 'esds');
    // walk ES_Descriptor -> DecoderConfigDescriptor -> DecoderSpecificInfo (tag 5)
    let p = esds.body + 4; let description = null;
    const readLen = () => { let n = 0; for (let i = 0; i < 4; i++) { const c = b[p++]; n = (n << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return n; };
    while (p < esds.end) {
      const tag = b[p++]; const len = readLen();
      if (tag === 3) { p += 3; continue; }           // ES_ID + flags, then nested
      if (tag === 4) { p += 13; continue; }          // objectType..avgBitrate, then nested
      if (tag === 5) { description = b.slice(p, p + len); break; }
      p += len;
    }
    const objType = description ? (description[0] >> 3) : 2;
    // sample table
    const stsz = child(b, stbl, 'stsz');
    const fixed = v.getUint32(stsz.body + 4); const n = v.getUint32(stsz.body + 8);
    const sizes = new Array(n);
    for (let i = 0; i < n; i++) sizes[i] = fixed || v.getUint32(stsz.body + 12 + i * 4);
    const stco = child(b, stbl, 'stco'); const co64 = child(b, stbl, 'co64');
    const chunkOff = [];
    if (stco) { const c = v.getUint32(stco.body + 4); for (let i = 0; i < c; i++) chunkOff.push(v.getUint32(stco.body + 8 + i * 4)); }
    else { const c = v.getUint32(co64.body + 4); for (let i = 0; i < c; i++) chunkOff.push(Number(v.getBigUint64(co64.body + 8 + i * 8))); }
    const stsc = child(b, stbl, 'stsc'); const sc = [];
    const scn = v.getUint32(stsc.body + 4);
    for (let i = 0; i < scn; i++) sc.push({ first: v.getUint32(stsc.body + 8 + i * 12), per: v.getUint32(stsc.body + 12 + i * 12) });
    const stts = child(b, stbl, 'stts'); const tt = [];
    const ttn = v.getUint32(stts.body + 4);
    for (let i = 0; i < ttn; i++) tt.push({ count: v.getUint32(stts.body + 8 + i * 8), delta: v.getUint32(stts.body + 12 + i * 8) });
    const samples = new Array(n); let si = 0;
    for (let ci = 0; ci < chunkOff.length && si < n; ci++) {
      let per = sc[0].per;
      for (const e of sc) if (ci + 1 >= e.first) per = e.per;
      let off = chunkOff[ci];
      for (let k = 0; k < per && si < n; k++) { samples[si] = { offset: off, size: sizes[si] }; off += sizes[si]; si++; }
    }
    let t = 0; si = 0;
    for (const e of tt) for (let k = 0; k < e.count && si < n; k++, si++) { samples[si].t = t / timescale; samples[si].dur = e.delta / timescale; t += e.delta; }
    return { codec: 'mp4a.40.' + objType, description, sampleRate, channels, timescale, samples, duration: t / timescale, moovEnd: moov.end };
  }

  return { parseInit, parseSegment, parseAudioMoov, boxes };
});
