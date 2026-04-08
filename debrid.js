"use strict";
/**
 * debrid.js — Módulo de integração com serviços Debrid
 * Suporta: TorBox, Real-Debrid (modo individual ou dual)
 *
 * FIXES aplicados neste arquivo:
 * 1. TorBox: checkcached retorna estrutura variável — normaliza corretamente
 * (torrent_id pode vir em diferentes campos: `id`, `hash`, etc.)
 * 2. TorBox: permalink agora usa torrent_id e file_id corretamente validados
 * 3. Real-Debrid: instantAvailability retorna 200 com corpo vazio em vez de 403
 * — o probe via addMagnet é acionado automaticamente nesses casos também
 * 4. Real-Debrid: rdGetDirectLink agora loga cada etapa para diagnóstico
 * 5. Real-Debrid: magnet enriquecido com trackers públicos para melhorar
 * desempenho em torrents que vieram apenas de .torrent (sem MagnetUri)
 * 6. resolveDebridStream: retorna provider correto no label de "em fila"
 * (dual mostra ambos; individual mostra o serviço específico)
 * 7. buildMagnet: trackers conhecidos são anexados ao magnet gerado
 * 8. [FIX VERCEL] TorBox: usa createtorrent com add_only_if_cached para pegar o torrent_id real
 * 9. [FIX VERCEL] Real-Debrid: removido probe (addMagnet) do checkCache para evitar Rate Limit e Timeouts
 */

const axios = require("axios");

// ─── Trackers populares para enriquecer magnets gerados ──────────────────────
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "https://tracker.nanoha.org/announce",
].map(t => `&tr=${encodeURIComponent(t)}`).join("");

/**
 * Constrói um magnet URI com trackers populares.
 * Usa o MagnetUri original quando disponível (preserva trackers do indexer).
 * Quando só temos infoHash, adiciona trackers conhecidos para melhorar
 * a chance de iniciar download nos serviços debrid.
 */
function buildMagnet(infoHash, existingMagnet, title) {
  if (existingMagnet && existingMagnet.startsWith("magnet:")) {
    // Adiciona trackers ao magnet existente se não tiver nenhum
    if (!existingMagnet.includes("&tr=")) {
      return existingMagnet + TRACKERS;
    }
    return existingMagnet;
  }
  const dn = encodeURIComponent(title || infoHash);
  return `magnet:?xt=urn:btih:${infoHash}&dn=${dn}${TRACKERS}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÕES DE MATCH DE EPISÓDIO (importadas do index.js para uso interno)
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

/**
 * Verifica cache no TorBox.
 * A API retorna: { success, data: { [hash]: { id, name, size, hash, files: [...] } } }
 * FIX: normaliza torrent_id corretamente — pode vir como `id` ou `torrent_id`.
 */
async function torboxCheckCache(hash, key) {
  const h = hash.toLowerCase();
  let res;
  try {
    res = await axios.get("https://api.torbox.app/v1/api/torrents/checkcached", {
      params: { hash: h, format: "object", list_files: true },
      headers: { Authorization: `Bearer ${key}` },
      timeout: 8000,
      validateStatus: s => s < 500,
    });
  } catch (err) {
    throw new Error(`TorBox checkcached network error: ${err.message}`);
  }

  if (!res.data?.success) return null;
  const entry = res.data.data?.[h];
  if (!entry || entry === false || typeof entry !== "object") return null;

  // FIX: normaliza o torrent_id — a API pode retornar como `id` ou `torrent_id`
  const torrentId = entry.id ?? entry.torrent_id ?? null;
  return { ...entry, _torrentId: torrentId };
}

/**
 * Gera URL de download TorBox (redirect direto para CDN).
 * FIX: valida torrent_id antes de construir a URL.
 */
function torboxBuildPermalink(torrentId, fileId, key) {
  if (!torrentId && torrentId !== 0) {
    throw new Error(`TorBox: torrent_id inválido (${torrentId})`);
  }
  return `https://api.torbox.app/v1/api/torrents/requestdl?token=${encodeURIComponent(key)}&torrent_id=${torrentId}&file_id=${fileId}&redirect=true`;
}

/**
 * Seleciona o melhor arquivo na lista de arquivos TorBox.
 * Retorna { fileId, name } onde fileId é o campo `id` real do arquivo.
 */
function torboxPickFile(files, season, episode, isAnime) {
  if (!Array.isArray(files) || !files.length) {
    return { fileId: 0, name: null };
  }

  const withMeta = files.map((f, idx) => ({
    idx,
    fileId: f.id ?? idx,
    size:   f.size || 0,
    name:   f.name || f.short_name || "",
  }));

  // Filme ou sem episódio: maior arquivo de vídeo
  if (season == null && episode == null) {
    const videoFiles = withMeta.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : withMeta;
    const best = pool.reduce((a, b) => b.size > a.size ? b : a);
    return { fileId: best.fileId, name: best.name };
  }

  // Série/anime
  const scored = withMeta.map(f => ({
    ...f,
    rank: isAnime
      ? animeEpisodeMatchRank(f.name, episode)
      : episodeMatchRank(f.name, season, episode),
  })).filter(f => f.rank > 0);

  if (!scored.length) {
    const videoFiles = withMeta.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : withMeta;
    const best = pool.reduce((a, b) => b.size > a.size ? b : a);
    return { fileId: best.fileId, name: best.name };
  }
  const best = scored.reduce((a, b) =>
    b.rank > a.rank || (b.rank === a.rank && b.size > a.size) ? b : a
  );
  return { fileId: best.fileId, name: best.name };
}

/**
 * Adiciona torrent ao TorBox para download em background.
 * [FIX]: Agora suporta addOnlyIfCached para pegar o torrent_id real da conta
 */
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
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 12000,
        validateStatus: s => s < 500,
      }
    );
    if (res.data?.success) {
      // Pega o torrent_id real gerado pela adição
      const tId = res.data.data?.torrent_id ?? res.data.data?.id;
      if (tId !== undefined && tId !== null) return tId;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL-DEBRID
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifica disponibilidade instantânea no Real-Debrid.
 * [FIX]: Removido o probe (addMagnet) para não estourar rate limit. 
 * Apenas verifica instantAvailability.
 */
async function rdCheckCache(hash, key) {
  const h       = hash.toLowerCase();
  const headers = { Authorization: `Bearer ${key}` };

  try {
    const res = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${h}`,
      { headers, timeout: 8000, validateStatus: s => s < 500 }
    );

    if (res.status === 200) {
      const entry = res.data?.[h];
      // Caso positivo: rd é array com pelo menos um set de arquivos
      if (entry && Array.isArray(entry.rd) && entry.rd.length > 0) {
        return entry.rd[0];
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Seleciona IDs de arquivo no cacheEntry do Real-Debrid.
 */
function rdPickFileIds(cacheEntry, season, episode, isAnime) {
  const files = Object.entries(cacheEntry).map(([id, info]) => ({
    id,
    name: info.filename || "",
    size: info.filesize || 0,
  }));
  if (!files.length) return ["all"];

  if (season == null && episode == null) {
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : files;
    return [pool.reduce((a, b) => b.size > a.size ? b : a).id];
  }

  const scored = files.map(f => ({
    ...f,
    rank: isAnime
      ? animeEpisodeMatchRank(f.name, episode)
      : episodeMatchRank(f.name, season, episode),
  })).filter(f => f.rank > 0);

  if (!scored.length) {
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|ts|m2ts|mov|wmv)$/i.test(f.name));
    const pool = videoFiles.length ? videoFiles : files;
    return [pool.reduce((a, b) => b.size > a.size ? b : a).id];
  }
  return [scored.reduce((a, b) =>
    b.rank > a.rank || (b.rank === a.rank && b.size > a.size) ? b : a
  ).id];
}

/**
 * Deleta torrent da conta Real-Debrid (cleanup após uso).
 */
async function rdDeleteTorrent(torrentId, key) {
  if (!torrentId) return;
  try {
    await axios.delete(
      `https://api.real-debrid.com/rest/1.0/torrents/delete/${torrentId}`,
      { headers: { Authorization: `Bearer ${key}` }, timeout: 6000 }
    );
    console.log(`  [Real-Debrid] Torrent ${torrentId} deletado da conta após uso.`);
  } catch {
    // não-crítico
  }
}

/**
 * Obtém URL de stream direto do Real-Debrid para torrent em cache.
 * FIX: logs detalhados em cada etapa para diagnóstico.
 * Retorna { download, filename } ou null.
 */
async function rdGetDirectLink(hash, magnet, fileIds, key) {
  const magnetUri = magnet;
  const headers   = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  // 1. Adiciona magnet
  let torrentId;
  try {
    const addRes = await axios.post(
      "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
      `magnet=${encodeURIComponent(magnetUri)}`,
      { headers, timeout: 12000, validateStatus: s => s < 500 }
    );
    torrentId = addRes.data?.id;
    if (!torrentId) {
      console.log(`  [Real-Debrid] addMagnet falhou — sem torrent_id (status ${addRes.status})`);
      return null;
    }
    console.log(`  [Real-Debrid] addMagnet OK → torrent_id=${torrentId}`);
  } catch (err) {
    console.log(`  [Real-Debrid] addMagnet erro: ${err.message}`);
    return null;
  }

  // 2. Seleciona arquivos
  try {
    const filesParam = Array.isArray(fileIds) && fileIds.length && fileIds[0] !== "all"
      ? fileIds.join(",")
      : "all";
    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${encodeURIComponent(filesParam)}`,
      { headers, timeout: 10000, validateStatus: s => s < 500 }
    );
  } catch (err) {
    console.log(`  [Real-Debrid] selectFiles erro: ${err.message}`);
    await rdDeleteTorrent(torrentId, key);
    return null;
  }

  // 3. Polling status
  let links = null;
  const delays = [600, 1000, 1000, 1200, 1200, 1500];
  for (let i = 0; i < delays.length; i++) {
    await new Promise(r => setTimeout(r, delays[i]));
    try {
      const infoRes = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: { Authorization: `Bearer ${key}` }, timeout: 10000 }
      );
      const info = infoRes.data;
      console.log(`  [Real-Debrid] poll #${i + 1} status=${info?.status} links=${info?.links?.length || 0}`);
      if (info?.status === "downloaded" && info?.links?.length) {
        links = info.links;
        break;
      }
      if (["magnet_error", "error", "virus", "dead"].includes(info?.status)) {
        console.log(`  [Real-Debrid] status de erro: ${info.status}`);
        break;
      }
    } catch (err) {
      console.log(`  [Real-Debrid] poll #${i + 1} erro: ${err.message}`);
    }
  }

  if (!links?.length) {
    await rdDeleteTorrent(torrentId, key);
    return null;
  }

  // 4. Desrestringe link
  let downloadUrl = null, filename = null;
  try {
    const unresRes = await axios.post(
      "https://api.real-debrid.com/rest/1.0/unrestrict/link",
      `link=${encodeURIComponent(links[0])}`,
      { headers, timeout: 12000 }
    );
    downloadUrl = unresRes.data?.download || null;
    filename    = unresRes.data?.filename  || null;
    console.log(`  [Real-Debrid] unrestrict OK → ${filename || downloadUrl?.slice(0, 60)}`);
  } catch (err) {
    console.log(`  [Real-Debrid] unrestrict erro: ${err.message}`);
    await rdDeleteTorrent(torrentId, key);
    return null;
  }

  // 5. Deleta torrent (link já gerado é permanente)
  await rdDeleteTorrent(torrentId, key);

  return downloadUrl ? { download: downloadUrl, filename } : null;
}

/**
 * Adiciona torrent ao Real-Debrid para download em background.
 * Mantém na conta para iniciar o cache.
 */
async function rdAddTorrent(magnet, key) {
  if (!magnet) return false;
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  try {
    const addRes = await axios.post(
      "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
      `magnet=${encodeURIComponent(magnet)}`,
      { headers, timeout: 12000, validateStatus: s => s < 500 }
    );
    const torrentId = addRes.data?.id;
    if (!torrentId) return false;
    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      "files=all",
      { headers, timeout: 10000, validateStatus: s => s < 500 }
    );
    // NÃO deleta — precisa ficar para o RD fazer cache
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTRADOR
// ─────────────────────────────────────────────────────────

/**
 * Resolve um stream via debrid.
 *
 * Retorna:
 * - { url, provider, filename }  — stream pronto (em cache)
 * - { queued: true, providers }  — enfileirado para download (MISS)
 * - null                         — nenhum serviço ativo
 *
 * FIXES:
 * - Modo "dual": tenta TorBox E Real-Debrid em paralelo
 * - Label "providers" no retorno queued indica quais serviços foram tentados
 * - buildMagnet garante trackers no magnet enviado para download
 */
async function resolveDebridStream(infoHash, magnet, title, season, episode, isAnime, config, torrentFiles) {
  const { mode, torboxKey, rdKey } = config || {};
  const useTorbox = (mode === "torbox"     || mode === "dual") && !!torboxKey;
  const useRD     = (mode === "realdebrid" || mode === "dual") && !!rdKey;

  if (!useTorbox && !useRD) return null;

  const enrichedMagnet = buildMagnet(infoHash, magnet, title);
  const queuedProviders = [];

  // ── Em modo dual: verifica os dois em paralelo para reduzir latência ─────
  if (useTorbox && useRD) {
    const [tbResult, rdResult] = await Promise.allSettled([
      _resolveTorbox(infoHash, enrichedMagnet, season, episode, isAnime, torboxKey, torrentFiles),
      _resolveRD(infoHash, enrichedMagnet, season, episode, isAnime, rdKey),
    ]);

    // Prefere TorBox (geralmente mais rápido), mas usa RD se TorBox não cachear
    if (tbResult.status === "fulfilled" && tbResult.value?.url) {
      // Se RD também retornou URL, deloga para informação
      if (rdResult.status === "fulfilled" && rdResult.value?.url) {
        console.log(`  [DUAL] Ambos em cache — usando TorBox`);
      }
      return tbResult.value;
    }
    if (rdResult.status === "fulfilled" && rdResult.value?.url) {
      return rdResult.value;
    }

    // Nenhum em cache — registra quais foram enfileirados
    if (tbResult.status === "fulfilled" && tbResult.value?.queued) queuedProviders.push("TorBox");
    if (rdResult.status === "fulfilled" && rdResult.value?.queued) queuedProviders.push("Real-Debrid");
    if (tbResult.status === "rejected") console.log(`  [TorBox] Erro: ${tbResult.reason?.message}`);
    if (rdResult.status === "rejected") console.log(`  [Real-Debrid] Erro: ${rdResult.reason?.message}`);

    return queuedProviders.length ? { queued: true, providers: queuedProviders } : null;
  }

  // ── Modo individual ───────────────────────────────────────────────────────
  if (useTorbox) {
    try {
      const result = await _resolveTorbox(infoHash, enrichedMagnet, season, episode, isAnime, torboxKey, torrentFiles);
      if (result?.url)    return result;
      if (result?.queued) return { queued: true, providers: ["TorBox"] };
    } catch (e) {
      console.log(`  [TorBox] Erro: ${e.message}`);
    }
  }

  if (useRD) {
    try {
      const result = await _resolveRD(infoHash, enrichedMagnet, season, episode, isAnime, rdKey);
      if (result?.url)    return result;
      if (result?.queued) return { queued: true, providers: ["Real-Debrid"] };
    } catch (e) {
      console.log(`  [Real-Debrid] Erro: ${e.message}`);
    }
  }

  return null;
}

/** Resolve TorBox: verifica cache, retorna URL ou queued */
async function _resolveTorbox(infoHash, magnet, season, episode, isAnime, key, torrentFiles) {
  const cached = await torboxCheckCache(infoHash, key);
  if (cached) {
    const files  = cached.files || torrentFiles || [];
    const picked = torboxPickFile(files, season, episode, isAnime);

    // FIX: Para baixar no TorBox, o arquivo em cache DEVE ser adicionado à conta para gerar um torrent_id
    const addedTorrentId = await torboxAddTorrent(magnet, key, true);
    if (addedTorrentId && addedTorrentId !== true) {
      const url = torboxBuildPermalink(addedTorrentId, picked.fileId, key);
      console.log(`  [TorBox] Cache HIT para ${infoHash} | torrent_id=${addedTorrentId} file_id=${picked.fileId}${picked.name ? ` (${picked.name})` : ""}`);
      return { url, provider: "TorBox", filename: picked.name || null };
    }
    
    console.log(`  [TorBox] Cache HIT mas falha ao obter torrent_id na adição para ${infoHash}`);
    return null;
  }

  // MISS — enfileira para download
  const queuedId = await torboxAddTorrent(magnet, key, false);
  console.log(`  [TorBox] Cache MISS para ${infoHash} — ${queuedId ? "enfileirado para download" : "falha ao enfileirar"}`);
  return { queued: !!queuedId };
}

/** Resolve Real-Debrid: verifica cache, retorna URL ou queued */
async function _resolveRD(infoHash, magnet, season, episode, isAnime, key) {
  const cacheEntry = await rdCheckCache(infoHash, key);
  if (cacheEntry) {
    const fileIds = rdPickFileIds(cacheEntry, season, episode, isAnime);
    const result  = await rdGetDirectLink(infoHash, magnet, fileIds, key);
    if (result?.download) {
      console.log(`  [Real-Debrid] Cache HIT para ${infoHash}${result.filename ? ` | ${result.filename}` : ""}`);
      return { url: result.download, provider: "Real-Debrid", filename: result.filename || null };
    }
    console.log(`  [Real-Debrid] Cache HIT mas falha ao obter link direto para ${infoHash}`);
    return null;
  }

  // MISS — enfileira para download
  const queued = await rdAddTorrent(magnet, key);
  console.log(`  [Real-Debrid] Cache MISS para ${infoHash} — ${queued ? "enfileirado para download" : "falha ao enfileirar"}`);
  return { queued: true };
}

module.exports = {
  buildMagnet,
  resolveDebridStream,
  // Exportados para testes unitários
  torboxCheckCache,
  torboxPickFile,
  torboxAddTorrent,
  rdCheckCache,
  rdPickFileIds,
  rdGetDirectLink,
  rdAddTorrent,
};
