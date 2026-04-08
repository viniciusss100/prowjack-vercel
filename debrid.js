"use strict";
/**
 * debrid.js — Módulo de integração com serviços Debrid
 * Suporta: TorBox, Real-Debrid (modo individual ou dual)
 *
 * FIX: Implementado "Batch Checking" (Verificação em Lote).
 * Evita bloqueios por Rate Limit da API do Debrid e aumenta drasticamente 
 * o índice de acerto do cache (HITs) em paridade com addons como Jackettio.
 */

const axios = require("axios");

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "https://tracker.nanoha.org/announce",
].map(t => `&tr=${encodeURIComponent(t)}`).join("");

function buildMagnet(infoHash, existingMagnet, title) {
  if (existingMagnet && existingMagnet.startsWith("magnet:")) {
    if (!existingMagnet.includes("&tr=")) {
      return existingMagnet + TRACKERS;
    }
    return existingMagnet;
  }
  const dn = encodeURIComponent(title || infoHash);
  return `magnet:?xt=urn:btih:${infoHash}&dn=${dn}${TRACKERS}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MATCH DE EPISÓDIOS
// ─────────────────────────────────────────────────────────────────────────────

function animeEpisodeMatchRank(title, ep) {
  if (ep == null) return 1;
  const t = (title || "").replace(/\./g, " ");
  const n = ep;
  if (new RegExp(`-\\s*0*${n}(?:v\\d+)?\\s*[\\[\\(\\s]`, "i").test(t)) return 3;
  if (new RegExp(`\\[0*${n}(?:v\\d+)?\\]`, "i").test(t)) return 3;
  if (new RegExp(`(?<=[\\s._\\-\\[\\(])0*${String(n).padStart(2, "0")}(?:v\\d+)?(?=[\\s._\\-\\]\\)\\[]|$)`, "i").test(t)) return 3;
  if (new RegExp(`(?<=[\\s._\\-\\[\\(])0*${String(n).padStart(3, "0")}(?:v\\d+)?(?=[\\s._\\-\\]\\)\\[]|$)`, "i").test(t)) return 3;
  if (new RegExp(`\\bE(?:p(?:isode)?)?\\s*0*${n}\\b`, "i").test(t)) return 3;
  for (const m of t.matchAll(/\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b/g)) {
    const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
    if (n >= lo && n <= hi) return 2;
  }
  if (/\b(complete|completa|batch)\b/i.test(t)) return 1;
  return 0;
}

function episodeMatchRank(title, season, episode) {
  if (season == null || episode == null) return 1;
  const t    = (title || "").toLowerCase();
  const sRaw = parseInt(season, 10);
  const eRaw = parseInt(episode, 10);
  if (new RegExp(`\\bs0*${sRaw}[\\s._-]*e0*${eRaw}\\b|\\b0*${sRaw}x0*${eRaw}\\b`, "i").test(t)) return 4;
  const seasonOnly = new RegExp(`\\bs0*${sRaw}\\b|\\bseason\\s?0*${sRaw}\\b|\\btemporada\\s?0*${sRaw}\\b`, "i");
  if (seasonOnly.test(t) && !/\bs\d{1,2}[\s._-]*e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\bepisodes?\s*\d{1,3}\b|\bep\s*\d{1,3}\b/i.test(t)) return 2;
  if (/\b(complete|completa|batch)\b/i.test(t)) return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// TORBOX
// ─────────────────────────────────────────────────────────────────────────────

async function torboxBatchCheckCache(hashes, key) {
  if (!hashes || !hashes.length) return {};
  const resultMap = {};

  // Torbox aceita múltiplos hashes separados por vírgula. Agrupamos de 50 em 50.
  for (let i = 0; i < hashes.length; i += 50) {
    const chunk = hashes.slice(i, i + 50);
    try {
      const res = await axios.get("https://api.torbox.app/v1/api/torrents/checkcached", {
        params: { hash: chunk.join(","), format: "object", list_files: true },
        headers: { Authorization: `Bearer ${key}` },
        timeout: 10000,
        validateStatus: s => s < 500,
      });
      if (res.data?.success && res.data?.data) {
        Object.assign(resultMap, res.data.data);
      }
    } catch (err) {
      console.log(`  [TorBox Batch] Erro: ${err.message}`);
    }
  }
  return resultMap;
}

function torboxBuildPermalink(torrentId, fileId, key) {
  if (!torrentId && torrentId !== 0) {
    throw new Error(`TorBox: torrent_id inválido (${torrentId})`);
  }
  return `https://api.torbox.app/v1/api/torrents/requestdl?token=${encodeURIComponent(key)}&torrent_id=${torrentId}&file_id=${fileId}&redirect=true`;
}

function torboxPickFile(files, season, episode, isAnime) {
  if (!Array.isArray(files) || !files.length) return { fileId: 0, name: null };

  const withMeta = files.map((f, idx) => ({
    idx, fileId: f.id ?? idx, size: f.size || 0, name: f.name || f.short_name || "",
  }));

  if (season == null && episode == null) {
    const videoFiles = withMeta.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : withMeta;
    const best = pool.reduce((a, b) => b.size > a.size ? b : a);
    return { fileId: best.fileId, name: best.name };
  }

  const scored = withMeta.map(f => ({
    ...f,
    rank: isAnime ? animeEpisodeMatchRank(f.name, episode) : episodeMatchRank(f.name, season, episode),
  })).filter(f => f.rank > 0);

  if (!scored.length) {
    const videoFiles = withMeta.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : withMeta;
    const best = pool.reduce((a, b) => b.size > a.size ? b : a);
    return { fileId: best.fileId, name: best.name };
  }
  const best = scored.reduce((a, b) => b.rank > a.rank || (b.rank === a.rank && b.size > a.size) ? b : a);
  return { fileId: best.fileId, name: best.name };
}

async function torboxAddTorrent(magnet, key, addOnlyIfCached = false) {
  if (!magnet) return false;
  const params = { magnet, seed: "3", allow_zip: "false" };
  if (addOnlyIfCached) params.add_only_if_cached = "true";

  const body = new URLSearchParams(params);
  try {
    const res = await axios.post(
      "https://api.torbox.app/v1/api/torrents/createtorrent",
      body.toString(),
      {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 12000, validateStatus: s => s < 500,
      }
    );
    if (res.data?.success) {
      const tId = res.data.data?.torrent_id ?? res.data.data?.id;
      if (tId !== undefined && tId !== null) return tId;
      return true;
    }
    return false;
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL-DEBRID
// ─────────────────────────────────────────────────────────────────────────────

async function rdBatchCheckCache(hashes, key) {
  if (!hashes || !hashes.length) return {};
  const headers = { Authorization: `Bearer ${key}` };
  const resultMap = {};

  // RD aceita múltiplos hashes separados por barra (/).
  for (let i = 0; i < hashes.length; i += 50) {
    const chunk = hashes.slice(i, i + 50);
    try {
      const res = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${chunk.join("/")}`,
        { headers, timeout: 10000, validateStatus: s => s < 500 }
      );
      if (res.status === 200 && res.data) {
        Object.assign(resultMap, res.data);
      }
    } catch (err) {
      console.log(`  [RD Batch] Erro: ${err.message}`);
    }
  }
  return resultMap;
}

function rdPickFileIds(cacheEntry, season, episode, isAnime) {
  const files = Object.entries(cacheEntry).map(([id, info]) => ({
    id, name: info.filename || "", size: info.filesize || 0,
  }));
  if (!files.length) return ["all"];

  if (season == null && episode == null) {
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : files;
    return [pool.reduce((a, b) => b.size > a.size ? b : a).id];
  }

  const scored = files.map(f => ({
    ...f,
    rank: isAnime ? animeEpisodeMatchRank(f.name, episode) : episodeMatchRank(f.name, season, episode),
  })).filter(f => f.rank > 0);

  if (!scored.length) {
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : files;
    return [pool.reduce((a, b) => b.size > a.size ? b : a).id];
  }
  return [scored.reduce((a, b) => b.rank > a.rank || (b.rank === a.rank && b.size > a.size) ? b : a).id];
}

async function rdDeleteTorrent(torrentId, key) {
  if (!torrentId) return;
  try {
    await axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${torrentId}`,
      { headers: { Authorization: `Bearer ${key}` }, timeout: 6000 });
    console.log(`  [Real-Debrid] Torrent ${torrentId} deletado da conta após uso.`);
  } catch {}
}

async function rdGetDirectLink(hash, magnet, fileIds, key) {
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" };
  let torrentId;
  try {
    const addRes = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
      `magnet=${encodeURIComponent(magnet)}`, { headers, timeout: 12000, validateStatus: s => s < 500 });
    torrentId = addRes.data?.id;
    if (!torrentId) return null;
  } catch (err) { return null; }

  try {
    const filesParam = Array.isArray(fileIds) && fileIds.length && fileIds[0] !== "all" ? fileIds.join(",") : "all";
    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${encodeURIComponent(filesParam)}`, { headers, timeout: 10000, validateStatus: s => s < 500 });
  } catch (err) {
    await rdDeleteTorrent(torrentId, key); return null;
  }

  let links = null;
  const delays = [600, 1000, 1000, 1200, 1200, 1500];
  for (let i = 0; i < delays.length; i++) {
    await new Promise(r => setTimeout(r, delays[i]));
    try {
      const infoRes = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: { Authorization: `Bearer ${key}` }, timeout: 10000 });
      const info = infoRes.data;
      if (info?.status === "downloaded" && info?.links?.length) { links = info.links; break; }
      if (["magnet_error", "error", "virus", "dead"].includes(info?.status)) break;
    } catch (err) {}
  }

  if (!links?.length) { await rdDeleteTorrent(torrentId, key); return null; }

  let downloadUrl = null, filename = null;
  try {
    const unresRes = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link",
      `link=${encodeURIComponent(links[0])}`, { headers, timeout: 12000 });
    downloadUrl = unresRes.data?.download || null;
    filename    = unresRes.data?.filename  || null;
  } catch (err) {
    await rdDeleteTorrent(torrentId, key); return null;
  }

  await rdDeleteTorrent(torrentId, key);
  return downloadUrl ? { download: downloadUrl, filename } : null;
}

async function rdAddTorrent(magnet, key) {
  if (!magnet) return false;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" };
  try {
    const addRes = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
      `magnet=${encodeURIComponent(magnet)}`, { headers, timeout: 12000, validateStatus: s => s < 500 });
    const torrentId = addRes.data?.id;
    if (!torrentId) return false;
    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      "files=all", { headers, timeout: 10000, validateStatus: s => s < 500 });
    return true;
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTRADOR
// ─────────────────────────────────────────────────────────

async function resolveDebridStream(infoHash, magnet, title, season, episode, isAnime, config, torrentFiles, rdCacheEntry, tbCacheEntry) {
  const { mode, torboxKey, rdKey } = config || {};
  const useTorbox = (mode === "torbox"     || mode === "dual") && !!torboxKey;
  const useRD     = (mode === "realdebrid" || mode === "dual") && !!rdKey;

  if (!useTorbox && !useRD) return null;

  const enrichedMagnet = buildMagnet(infoHash, magnet, title);

  if (useTorbox && useRD) {
    const [tbResult, rdResult] = await Promise.allSettled([
      _resolveTorbox(infoHash, enrichedMagnet, season, episode, isAnime, torboxKey, torrentFiles, tbCacheEntry),
      _resolveRD(infoHash, enrichedMagnet, season, episode, isAnime, rdKey, rdCacheEntry),
    ]);

    const results = [];
    if (tbResult.status === "fulfilled" && tbResult.value) results.push(tbResult.value);
    if (rdResult.status === "fulfilled" && rdResult.value) results.push(rdResult.value);

    return results.length > 0 ? { multi: results } : null;
  }

  if (useTorbox) return _resolveTorbox(infoHash, enrichedMagnet, season, episode, isAnime, torboxKey, torrentFiles, tbCacheEntry);
  if (useRD) return _resolveRD(infoHash, enrichedMagnet, season, episode, isAnime, rdKey, rdCacheEntry);

  return null;
}

async function _resolveTorbox(infoHash, magnet, season, episode, isAnime, key, torrentFiles, tbCacheEntry) {
  // Verifica se a entrada em cache previamente obtida no lote existe e não é falsa
  if (tbCacheEntry && typeof tbCacheEntry === 'object' && tbCacheEntry !== false) {
    const torrentId = tbCacheEntry.id ?? tbCacheEntry.torrent_id ?? null;
    const cached = { ...tbCacheEntry, _torrentId: torrentId };
    const files  = cached.files || torrentFiles || [];
    const picked = torboxPickFile(files, season, episode, isAnime);

    const addedTorrentId = await torboxAddTorrent(magnet, key, true);
    if (addedTorrentId && addedTorrentId !== true) {
      const url = torboxBuildPermalink(addedTorrentId, picked.fileId, key);
      console.log(`  [TorBox] Cache HIT para ${infoHash}`);
      return { url, provider: "TorBox", filename: picked.name || null };
    }
  }
  console.log(`  [TorBox] Cache MISS para ${infoHash} — aguardando clique para enfileirar`);
  return { queued: true, provider: "TorBox" };
}

async function _resolveRD(infoHash, magnet, season, episode, isAnime, key, rdCacheEntry) {
  // Verifica se a entrada em cache previamente obtida no lote existe e tem conteúdo válido
  if (rdCacheEntry && Array.isArray(rdCacheEntry.rd) && rdCacheEntry.rd.length > 0) {
    const entry = rdCacheEntry.rd[0];
    const fileIds = rdPickFileIds(entry, season, episode, isAnime);
    const result  = await rdGetDirectLink(infoHash, magnet, fileIds, key);
    if (result?.download) {
      console.log(`  [Real-Debrid] Cache HIT para ${infoHash}`);
      return { url: result.download, provider: "Real-Debrid", filename: result.filename || null };
    }
  }
  console.log(`  [Real-Debrid] Cache MISS para ${infoHash} — aguardando clique para enfileirar`);
  return { queued: true, provider: "Real-Debrid" };
}

module.exports = {
  buildMagnet,
  resolveDebridStream,
  torboxBatchCheckCache,
  torboxPickFile,
  torboxAddTorrent,
  rdBatchCheckCache,
  rdPickFileIds,
  rdGetDirectLink,
  rdAddTorrent,
};
