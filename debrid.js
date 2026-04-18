"use strict";

const axios = require("axios");
const { injectTrackers } = require("./torrentEnrich");

// =========================
// HELPER FUNCTIONS
// =========================

function buildMagnet(infoHash, existingMagnet, title) {
  if (existingMagnet && existingMagnet.startsWith("magnet:")) return existingMagnet;
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://exodus.desync.com:6969/announce",
  ];
  const dn = title ? `&dn=${encodeURIComponent(title)}` : "";
  const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infoHash}${dn}${tr}`;
}

// =========================
// REAL-DEBRID FUNCTIONS
// =========================

async function rdFindExistingTorrent(hash, key) {
  try {
    const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents", {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 8000
    });
    const torrents = res.data || [];
    return torrents.find(t => t.hash?.toLowerCase() === hash.toLowerCase());
  } catch {
    return null;
  }
}

async function rdDeleteTorrent(id, key) {
  try {
    await axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${id}`, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 5000
    });
  } catch {}
}

async function rdAddTorrent(magnet, key, buffer = null) {
  const headersAuth = { Authorization: `Bearer ${key}` };
  
  try {
    if (buffer) {
      const enriched = injectTrackers(buffer);
      const res = await axios.put(
        "https://api.real-debrid.com/rest/1.0/torrents/addTorrent",
        enriched,
        {
          headers: { ...headersAuth, "Content-Type": "application/x-bittorrent" },
          timeout: 12000,
          validateStatus: s => s < 500
        }
      );
      return !!res.data?.id;
    }
    
    const res = await axios.post(
      "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
      `magnet=${encodeURIComponent(magnet)}`,
      {
        headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 12000,
        validateStatus: s => s < 500
      }
    );
    return !!res.data?.id;
  } catch {
    return false;
  }
}

// Cache check usando /instantAvailability — NÃO adiciona nada à conta do usuário
async function rdBatchCheckCache(hashes, key, bufferMap = {}, privateHashes = new Set()) {
  if (!hashes || !hashes.length) return {};

  const headersAuth = { Authorization: `Bearer ${key}` };
  const resultMap = {};

  // Nunca sondamos trackers privados: adicionar ao RD consome ratio mesmo que se delete depois
  const publicHashes = hashes.filter(h => !privateHashes.has(h));
  if (!publicHashes.length) {
    console.log(`[RD Cache Check] Todos os hashes são de trackers privados — pulando verificação`);
    return resultMap;
  }

  // O endpoint /instantAvailability aceita até ~100 hashes separados por "/"
  // e retorna o mapa de disponibilidade SEM adicionar nada à conta.
  const BATCH_SIZE = 40; // conservador para evitar URL muito longa
  for (let i = 0; i < publicHashes.length; i += BATCH_SIZE) {
    const batch = publicHashes.slice(i, i + BATCH_SIZE);
    const hashPath = batch.join("/");

    try {
      const res = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashPath}`,
        { headers: headersAuth, timeout: 10000 }
      );

      const data = res.data || {};

      for (const hash of batch) {
        // A API retorna as chaves em maiúsculo ou minúsculo dependendo da versão
        const entry = data[hash.toLowerCase()] || data[hash.toUpperCase()] || data[hash];
        if (!entry) continue;

        // Formato retornado: { rd: [ { "1": { filename, filesize }, ... } ] }
        // Verifica se há pelo menos uma variante com arquivos
        const rdVariants = Array.isArray(entry.rd) ? entry.rd : [];
        const hasFiles = rdVariants.some(v => v && Object.keys(v).length > 0);

        if (hasFiles) {
          // Normaliza variantes para o formato interno { filename, filesize }
          const normalizedVariants = rdVariants.map(v => {
            const variant = {};
            for (const [id, f] of Object.entries(v)) {
              variant[String(id)] = {
                filename: f.filename || f.path || "",
                filesize: f.filesize || f.bytes || 0,
              };
            }
            return variant;
          });
          resultMap[hash.toLowerCase()] = { rd: normalizedVariants };
          console.log(`[RD Cache Check] ✅ ${hash.slice(0, 8)} cacheado (${normalizedVariants.length} variante(s))`);
        }
      }
    } catch (err) {
      console.error(`[RD Cache Check] Erro no instantAvailability: ${err.message}`);
    }
  }

  console.log(`[RD Cache Check] ${Object.keys(resultMap).length}/${publicHashes.length} hashes em cache (${privateHashes.size} privados ignorados)`);
  return resultMap;
}

async function rdGetDirectLink(hash, magnet, fileIds, key, torrentBuffer = null) {
  const headersAuth = { Authorization: `Bearer ${key}` };
  let torrentId;
  let isExisting = false;

  const existing = await rdFindExistingTorrent(hash, key);

  if (existing) {
    torrentId = existing.id;
    isExisting = true;
  } else {
    try {
      if (torrentBuffer) {
        const enriched = injectTrackers(torrentBuffer);
        const addRes = await axios.put(
          "https://api.real-debrid.com/rest/1.0/torrents/addTorrent",
          enriched,
          {
            headers: { ...headersAuth, "Content-Type": "application/x-bittorrent" },
            timeout: 12000,
            validateStatus: s => s < 500
          }
        );
        torrentId = addRes.data?.id;
      } else {
        const addRes = await axios.post(
          "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
          `magnet=${encodeURIComponent(magnet)}`,
          {
            headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 12000,
            validateStatus: s => s < 500
          }
        );
        torrentId = addRes.data?.id;
      }

      if (!torrentId) return null;
    } catch {
      return null;
    }

    try {
      const filesParam = Array.isArray(fileIds) && fileIds.length && fileIds[0] !== "all"
        ? fileIds.join(",")
        : "all";

      await axios.post(
        `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
        `files=${encodeURIComponent(filesParam)}`,
        {
          headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 8000,
          validateStatus: s => s < 500
        }
      );
    } catch {
      await rdDeleteTorrent(torrentId, key);
      return null;
    }
  }

  // Fast path para torrents existentes
  if (isExisting && existing.links?.length) {
    try {
      const unresRes = await axios.post(
        "https://api.real-debrid.com/rest/1.0/unrestrict/link",
        `link=${encodeURIComponent(existing.links[0])}`,
        {
          headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 12000
        }
      );

      if (unresRes.data?.download) {
        return { download: unresRes.data.download, filename: unresRes.data.filename || null };
      }
    } catch {}
  }

  // Polling com backoff
  let links = null;
  const delays = [2000, 3000, 5000];

  for (let i = 0; i < delays.length; i++) {
    await new Promise(r => setTimeout(r, delays[i]));

    try {
      const infoRes = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: headersAuth, timeout: 8000 }
      );

      const info = infoRes.data;

      if (info?.status === "downloaded" && info?.links?.length) {
        links = info.links;
        break;
      }

      if (["magnet_error", "error", "virus", "dead"].includes(info?.status)) {
        break;
      }
    } catch {}
  }

  if (!links?.length) return null;

  try {
    const unresRes = await axios.post(
      "https://api.real-debrid.com/rest/1.0/unrestrict/link",
      `link=${encodeURIComponent(links[0])}`,
      {
        headers: { ...headersAuth, "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 12000
      }
    );

    return {
      download: unresRes.data?.download,
      filename: unresRes.data?.filename || null
    };
  } catch {
    return null;
  }
}

// =========================
// TORBOX FUNCTIONS
// =========================

async function torboxAddTorrent(magnet, key, waitForReady = false, buffer = null) {
  try {
    let res;
    
    if (buffer) {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', buffer, { filename: 'torrent.torrent', contentType: 'application/x-bittorrent' });
      
      res = await axios.post(
        "https://api.torbox.app/v1/api/torrents/createtorrent",
        form,
        {
          headers: {
            Authorization: `Bearer ${key}`,
            ...form.getHeaders()
          },
          timeout: 15000
        }
      );
    } else {
      res = await axios.post(
        "https://api.torbox.app/v1/api/torrents/createtorrent",
        { magnet },
        {
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          timeout: 15000
        }
      );
    }

    if (!res.data?.data?.torrent_id) return null;

    if (waitForReady) {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const info = await torboxGetTorrentInfo(res.data.data.torrent_id, key);
        if (info?.download_finished) return info;
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    return res.data.data;
  } catch (err) {
    console.error(`[TorBox] Erro ao adicionar torrent: ${err.message}`);
    return null;
  }
}

async function torboxGetTorrentInfo(torrentId, key) {
  try {
    const res = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 8000
    });
    return res.data?.data?.find(t => t.id === torrentId);
  } catch {
    return null;
  }
}

async function torboxBatchCheckCache(hashes, key, privateHashes = new Set()) {
  if (!hashes || !hashes.length) return {};

  try {
    const res = await axios.get("https://api.torbox.app/v1/api/torrents/checkcached", {
      params: { hash: hashes.join(","), format: "object" },
      headers: { Authorization: `Bearer ${key}` },
      timeout: 10000
    });

    const resultMap = {};
    const data = res.data?.data || {};

    for (const hash of hashes) {
      const cached = data[hash];
      if (cached && typeof cached === 'object' && cached !== false) {
        resultMap[hash.toLowerCase()] = cached;
      }
    }

    return resultMap;
  } catch (err) {
    console.error(`[TorBox] Erro no cache check: ${err.message}`);
    return {};
  }
}

// =========================
// RESOLVE DEBRID STREAM
// =========================

async function resolveDebridStream(
  infoHash,
  magnet,
  title,
  season,
  episode,
  isAnime,
  config,
  files,
  rdCache,
  tbCache,
  buffer
) {
  if (!config) return null;

  const { mode, torboxKey, rdKey } = config;
  const results = [];

  // Dual mode: tenta ambos
  if (mode === "dual") {
    if (rdKey && rdCache) {
      const rdStream = await resolveRDStream(infoHash, magnet, season, episode, isAnime, rdKey, files, rdCache, buffer);
      if (rdStream) results.push({ ...rdStream, provider: "Real-Debrid" });
    }
    
    if (torboxKey && tbCache) {
      const tbStream = await resolveTBStream(infoHash, magnet, season, episode, isAnime, torboxKey, files, tbCache, buffer);
      if (tbStream) results.push({ ...tbStream, provider: "TorBox" });
    }

    if (results.length > 0) return { multi: results };
    return null;
  }

  // Real-Debrid only
  if (mode === "realdebrid" && rdKey) {
    const rdStream = await resolveRDStream(infoHash, magnet, season, episode, isAnime, rdKey, files, rdCache, buffer);
    return rdStream ? { ...rdStream, provider: "Real-Debrid" } : null;
  }

  // TorBox only
  if (mode === "torbox" && torboxKey) {
    const tbStream = await resolveTBStream(infoHash, magnet, season, episode, isAnime, torboxKey, files, tbCache, buffer);
    return tbStream ? { ...tbStream, provider: "TorBox" } : null;
  }

  return null;
}

async function resolveRDStream(infoHash, magnet, season, episode, isAnime, key, files, cache, buffer) {
  if (!cache || !cache.rd || !cache.rd.length) {
    return { queued: true, cached: false };
  }

  const variant = cache.rd[0];
  const fileIds = Object.keys(variant);

  if (season != null && episode != null) {
    // Encontrar arquivo específico do episódio
    const matchedFile = findBestFileMatch(variant, season, episode, isAnime);
    if (!matchedFile) return { queued: true, cached: true };

    const link = await rdGetDirectLink(infoHash, magnet, [matchedFile.id], key, buffer);
    if (link?.download) {
      return { url: link.download, filename: matchedFile.filename };
    }
    return { queued: true, cached: true };
  }

  // Filme: pega o maior arquivo
  const largestFile = Object.entries(variant)
    .sort((a, b) => (b[1].filesize || 0) - (a[1].filesize || 0))[0];

  if (!largestFile) return { queued: true, cached: true };

  const link = await rdGetDirectLink(infoHash, magnet, [largestFile[0]], key, buffer);
  if (link?.download) {
    return { url: link.download, filename: largestFile[1].filename };
  }

  return { queued: true, cached: true };
}

async function resolveTBStream(infoHash, magnet, season, episode, isAnime, key, files, cache, buffer) {
  if (!cache || typeof cache !== 'object' || cache === false) {
    return { queued: true, cached: false };
  }

  // TorBox retorna objeto com arquivos cacheados
  const cachedFiles = Object.values(cache);
  if (!cachedFiles.length) return { queued: true, cached: false };

  if (season != null && episode != null) {
    const matchedFile = findBestFileMatch(cache, season, episode, isAnime);
    if (!matchedFile) return { queued: true, cached: true };
    
    // TorBox precisa adicionar o torrent para gerar link
    return { queued: true, cached: true };
  }

  // Filme: maior arquivo
  return { queued: true, cached: true };
}

function findBestFileMatch(variant, season, episode, isAnime) {
  const entries = Object.entries(variant);
  
  for (const [id, file] of entries) {
    const name = file.filename || file.name || "";
    
    if (isAnime) {
      const epMatch = name.match(new RegExp(`[-\\s]0*${episode}(?:v\\d+)?[\\s\\[\\(]`, "i"));
      if (epMatch) return { id, ...file };
    } else {
      const seMatch = new RegExp(`s0*${season}[\\s._-]*e0*${episode}\\b`, "i");
      if (seMatch.test(name)) return { id, ...file };
    }
  }

  return null;
}

// =========================
// EXPORTS
// =========================

module.exports = {
  buildMagnet,
  rdFindExistingTorrent,
  rdDeleteTorrent,
  rdAddTorrent,
  rdBatchCheckCache,
  rdGetDirectLink,
  torboxAddTorrent,
  torboxGetTorrentInfo,
  torboxBatchCheckCache,
  resolveDebridStream
};
