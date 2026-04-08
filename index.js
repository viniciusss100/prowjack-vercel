"use strict";
const crypto  = require("crypto");
const express = require("express");
const axios   = require("axios");
const Redis   = require("ioredis");
const path    = require("path");
const fs      = require("fs");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  next();
});
app.options("*", (_, res) => res.sendStatus(200));

// ─────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────
const ENV = {
  jackettUrl: (process.env.JACKETT_URL || "http://localhost:9117").replace(/\/+$/, ""),
  apiKey:     (process.env.JACKETT_API_KEY || "").trim(),
  port:       process.env.PORT || 7014,
  redisUrl:   process.env.REDIS_URL || "redis://localhost:6379",
};

// ─────────────────────────────────────────────────────────
// REDIS
// ─────────────────────────────────────────────────────────
let redis = null;
try {
  redis = new Redis(ENV.redisUrl, { lazyConnect: true, enableOfflineQueue: false });
  redis.on("error", () => {});
} catch {}
const rc = {
  async get(k)         { try { return redis ? await redis.get(k) : null; } catch { return null; } },
  async set(k, v, ttl) { try { redis && await redis.set(k, v, "EX", ttl); } catch {} },
  async del(k)         { try { redis && await redis.del(k); } catch {} },
  async keys(p)        { try { return redis ? await redis.keys(p) : []; } catch { return []; } },
};
const CACHE_VERSION = "v6-debrid-direct";

// ─────────────────────────────────────────────────────────
// INDEXERS (ISOLAMENTO DE ANIME)
// ─────────────────────────────────────────────────────────
const ANIME_ONLY_IDS = new Set([
  "nyaasi", "animetosho", "animez", "nekobt",
  "animebytes", "anidex", "tokyotosho", "animeworld",
]);
function isAnimeOnly(id) {
  if (!id) return false;
  const norm = id.toLowerCase().replace(/[-_\s]/g, "");
  for (const known of ANIME_ONLY_IDS) {
    if (norm === known || norm.startsWith(known)) return true;
  }
  return false;
}
let _ixCache   = null;
let _ixCacheAt = 0;
async function getCachedIndexers() {
  if (_ixCache && Date.now() - _ixCacheAt < 300_000) return _ixCache;
  try {
    _ixCache   = await jackettFetchIndexers();
    _ixCacheAt = Date.now();
  } catch {
    _ixCache = _ixCache || [];
  }
  return _ixCache;
}
async function resolveSearchIndexers(prefs, isAnime) {
  const selected = (Array.isArray(prefs.indexers) ? prefs.indexers : []).filter(Boolean);
  const useAll   = !selected.length || selected.includes("all");
  const allList  = await getCachedIndexers();
  const pool     = useAll ? allList.map(ix => ix.id) : selected;
  if (isAnime) {
    const animePool = pool.filter(id => isAnimeOnly(id));
    if (animePool.length > 0) return animePool;
    return pool;
  }
  const generalPool = pool.filter(id => !isAnimeOnly(id));
  return generalPool.length > 0 ? generalPool : pool;
}

// ─────────────────────────────────────────────────────────
// RATE LIMIT
// ─────────────────────────────────────────────────────────
async function isRateLimited(indexer) {
  return !!(await rc.get(`rl:${indexer}`));
}
async function setRateLimit(indexer, retryAfterHeader) {
  const parsed = parseInt(retryAfterHeader || "", 10);
  const ttl    = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3600) : 90;
  await rc.set(`rl:${indexer}`, "1", ttl);
}

// ─────────────────────────────────────────────────────────
// CONFIG (Base64URL)
// ─────────────────────────────────────────────────────────
function decodeUserCfg(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch { return null; }
}
function defaultPrefs() {
  return {
    indexers:        ["all"],
    categories:      ["movie", "series"],
    weights:         { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5 },
    maxResults:      20,
    slowThreshold:   8000,
    skipBadReleases: true,
    priorityLang:    "pt-br",
    onlyDubbed:      false,
    // ── Debrid ──────────────────────────────────────────
    debrid:          false,
    debridProvider:  "",   // "realdebrid" | "torbox"
    debridKey:       "",   // API key do provider
  };
}
function resolvePrefs(encoded) {
  const u = encoded ? (decodeUserCfg(encoded) || {}) : {};
  const m = { ...defaultPrefs(), ...u };
  if (!Array.isArray(m.indexers) || !m.indexers.length) m.indexers = ["all"];
  if (m.priorityLang === undefined) m.priorityLang = "pt-br";
  return m;
}

// ─────────────────────────────────────────────────────────
// PARSERS E DICIONÁRIOS
// ─────────────────────────────────────────────────────────
const RESOLUTION = [
  { re: /\b(4k|2160p)\b/i, label: "2160p", emoji: "🎞️ 4K",  score: 4   },
  { re: /\b1440p\b/i,      label: "1440p", emoji: "🎞️ 2K",  score: 3.5 },
  { re: /\b1080p\b/i,      label: "1080p", emoji: "🎞️ FHD", score: 3   },
  { re: /\b720p\b/i,       label: "720p",  emoji: "💿 HD",   score: 2   },
  { re: /\b576p\b/i,       label: "576p",  emoji: "📼 576P", score: 1   },
  { re: /\b480p\b/i,       label: "480p",  emoji: "📼 480P", score: 0.5 },
];
const QUALITY = [
  { re: /remux/i,            label: "REMUX",  emoji: "📀", score: 5   },
  { re: /blu[-.]?ray/i,      label: "BluRay", emoji: "💿", score: 4   },
  { re: /web[-.]?dl/i,       label: "WEBDL",  emoji: "🌐", score: 3   },
  { re: /webrip/i,           label: "WEBRip", emoji: "🖥️", score: 2.5 },
  { re: /hdrip/i,            label: "HDRip",  emoji: "💾", score: 2   },
  { re: /dvdrip/i,           label: "DVDRip", emoji: "💾", score: 1.5 },
  { re: /hdtv/i,             label: "HDTV",   emoji: "📺", score: 1   },
  { re: /\b(ts|tc|hcts)\b/i, label: "TS",     emoji: "⚠️", score: -2  },
  { re: /\bcam(rip)?\b/i,    label: "CAM",    emoji: "⛔ ", score: -5  },
];
const CODEC = [
  { re: /\bav1\b/i,         label: "AV1",   score: 4 },
  { re: /[hx]\.?265|hevc/i, label: "H.265", score: 3 },
  { re: /[hx]\.?264|avc/i,  label: "H.264", score: 2 },
  { re: /xvid|divx/i,       label: "XViD",  score: 0 },
];
const AUDIO = [
  { re: /atmos/i,             label: "Atmos"  },
  { re: /dts[-.]?x\b/i,       label: "DTS-X"  },
  { re: /dts[-.]?hd/i,        label: "DTS-HD" },
  { re: /\bdts\b/i,           label: "DTS"    },
  { re: /truehd/i,            label: "TrueHD" },
  { re: /dd\+|eac[-.]?3/i,    label: "DD+"    },
  { re: /\b(dd|ac[-.]?3)\b/i, label: "DD"     },
  { re: /\baac\b/i,           label: "AAC"    },
  { re: /\bmp3\b/i,           label: "MP3"    },
  { re: /\bopus\b/i,          label: "Opus"   },
];
const VISUAL = [
  { re: /hdr10\+/i,                   label: "HDR10+" },
  { re: /hdr10\b/i,                   label: "HDR10"  },
  { re: /dolby.?vision|dovi|\bdv\b/i, label: "DV"     },
  { re: /\bhdr\b/i,                   label: "HDR"    },
  { re: /\bsdr\b/i,                   label: "SDR"    },
];
const LANG = [
  { re: /(dublado|pt[-.]?br|portugu[eê]s|portuguese|brazilian)/i, code: "pt-br", emoji: "🇧🇷", label: "PT-BR" },
  { re: /\b(english|eng)\b/i,                                      code: "en",    emoji: "🇺🇸", label: "EN"    },
  { re: /(espa[nñ]ol|spanish|\besp\b)/i,                           code: "es",    emoji: "🇪🇸", label: "ES"    },
  { re: /(fran[cç]ais|french|\bfre\b)/i,                           code: "fr",    emoji: "🇫🇷", label: "FR"    },
];
const first    = (map, t) => map.find(e => e.re.test(t));
const matchAll = (map, t) => map.filter(e => e.re.test(t));
const uniq     = arr => [...new Set(arr.filter(Boolean))];
const normTitle = s => (s || "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
function qp(extra = {}) {
  const p = { ...extra };
  if (ENV.apiKey) p.apikey = ENV.apiKey;
  return p;
}

// ─────────────────────────────────────────────────────────
// DETECÇÃO DE IDIOMA
// ─────────────────────────────────────────────────────────
function getLangs(title, isAnime) {
  const langs  = matchAll(LANG, title);
  const isDual = /(dual)[-.\s]?(audio|2\.1|5\.1)?/i.test(title);
  if (isDual && !isAnime && !langs.some(l => l.code === "pt-br")) {
    langs.push({ code: "pt-br", emoji: "🇧🇷", label: "PT-BR" });
  }
  return langs;
}

// ─────────────────────────────────────────────────────────
// SCORE
// ─────────────────────────────────────────────────────────
function score(r, weights = {}, isAnime = false, priorityLang = "") {
  const w = { language: 40, resolution: 30, seeders: 20, size: 5, codec: 5, ...weights };
  const t = r.Title || "";
  let s   = 0;
  const langs       = getLangs(t, isAnime);
  const hasPriority = priorityLang ? langs.some(l => l.code === priorityLang) : false;
  const isMulti     = /(multi)[-.\s]?(audio)?/i.test(t);
  const isDualAnim  = isAnime && /(dual)[-.\s]?(audio)?/i.test(t);
  if (priorityLang && hasPriority)  s += w.language * 25;
  else if (isDualAnim)              s += w.language * 15;
  else if (isMulti)                 s += w.language * 10;
  else if (langs.length > 0)        s += w.language * 5;
  else                              s += w.language * 2;
  const res  = first(RESOLUTION, t); if (res)  s += res.score  * w.resolution * 10;
  const qual = first(QUALITY,    t); if (qual) s += qual.score * 50;
  s += (r.Seeders || 0) * (w.seeders / 10);
  const gb = (r.Size || 0) / 1e9;
  if (gb > 0) s += Math.max(0, 10 - Math.abs(gb - 8)) * w.size;
  const codec = first(CODEC, t); if (codec) s += codec.score * w.codec * 5;
  return s;
}

function normalizeTitleTokens(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[._]+/g, " ")
    .replace(/[\[\(][^\]\)]*[\]\)]/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3}|season\s?\d{1,2}|temporada\s?\d{1,2}|episode\s?\d{1,3}|ep\s?\d{1,3})\b/gi, " ")
    .replace(/\b(2160p|1440p|1080p|720p|576p|480p|4k|remux|blu[-.]?ray|web[-.]?dl|webrip|hdrip|dvdrip|hdtv|brrip|x26[45]|h\.?26[45]|hevc|av1|avc|dual|multi|audio|dublado|legendado|pt[-.]?br|eng|english|spanish|espa[nñ]ol|french|fran[cç]ais|aac|ac3|ddp?|eac3|atmos|truehd|dts(?:[-.]?hd|[-.]?x)?|10bit|8bit|proper|repack|extended|uncut|complete|completa|batch)\b/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(tok => tok.length >= 3 || /^(?:[a-z]\d|\d[a-z]|[a-z]\d[a-z]|\d[a-z]\d)$/i.test(tok))
    .filter(tok => !new Set(["the", "movie", "film", "one", "two", "and", "for", "with", "from", "into", "part"]).has(tok));
}
function escapedWordRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function titleMatchScore(title, aliases = []) {
  const titleTokens = normalizeTitleTokens(title);
  const titleText   = titleTokens.join(" ");
  if (!titleTokens.length) return 0;
  let best = 0;
  for (const alias of aliases.filter(Boolean)) {
    const aliasTokens = normalizeTitleTokens(alias);
    const aliasText   = aliasTokens.join(" ");
    if (!aliasTokens.length) continue;
    const aliasSet = new Set(aliasTokens);
    const matched  = aliasTokens.filter(tok => titleTokens.includes(tok)).length;
    const coverage = matched / aliasTokens.length;
    const density  = matched / Math.max(titleTokens.length, aliasTokens.length);
    const phraseHit = aliasText.length >= 5 && titleText.includes(aliasText);
    const exactShortHit = aliasTokens.length === 1 && aliasTokens[0].length <= 3
      ? new RegExp(`(^|[^a-z0-9])${escapedWordRegex(aliasTokens[0])}([^a-z0-9]|$)`, "i").test(String(title || ""))
      : false;
    if (!phraseHit && !exactShortHit) {
      if (aliasTokens.length <= 2 && matched < aliasTokens.length) continue;
      if (aliasTokens.length === 3 && matched < 2) continue;
    }
    let sc = coverage * 0.8 + density * 0.2;
    if (aliasTokens.length >= 2 && matched >= aliasTokens.length - 1) sc += 0.15;
    if (titleTokens.some(tok => aliasSet.has(tok))) sc += 0.05;
    if (phraseHit) sc += 0.25;
    if (exactShortHit) sc += 0.35;
    best = Math.max(best, Math.min(sc, 1));
  }
  return best;
}
function relaxedTitleMatchScore(title, aliases = []) {
  const titleTokens = normalizeTitleTokens(title);
  if (!titleTokens.length) return 0;
  let best = 0;
  for (const alias of aliases.filter(Boolean)) {
    const aliasTokens = normalizeTitleTokens(alias);
    if (!aliasTokens.length) continue;
    const matched  = aliasTokens.filter(tok => titleTokens.includes(tok)).length;
    const coverage = matched / aliasTokens.length;
    best = Math.max(best, coverage);
  }
  return best;
}

// ─────────────────────────────────────────────────────────
// EPISODE MATCHING
// ─────────────────────────────────────────────────────────
function seriesEpisodeMatches(title, season, episode) {
  if (!season && !episode) return true;
  const t = title.toLowerCase().replace(/[._]/g, " ");
  const S = String(season  || 1).padStart(2, "0");
  const E = String(episode || 1).padStart(2, "0");
  const patterns = [
    new RegExp(`s${S}e${E}\\b`, "i"),
    new RegExp(`\\b${parseInt(S)}x${parseInt(E)}\\b`, "i"),
    new RegExp(`season\\s?${parseInt(S)}.*episode\\s?${parseInt(E)}`, "i"),
    new RegExp(`temporada\\s?${parseInt(S)}.*epis[oó]dio\\s?${parseInt(E)}`, "i"),
  ];
  const packPatterns = [
    new RegExp(`s${S}\\b`, "i"),
    new RegExp(`season\\s?${parseInt(S)}\\b`, "i"),
    new RegExp(`temporada\\s?${parseInt(S)}\\b`, "i"),
    /\bcomplete\b/i, /\bcompleta\b/i, /\bbatch\b/i,
  ];
  return patterns.some(p => p.test(t)) || packPatterns.some(p => p.test(t));
}
function episodeMatchRank(title, season, episode) {
  if (!season && !episode) return 0;
  const t = title.toLowerCase().replace(/[._]/g, " ");
  const S = String(season  || 1).padStart(2, "0");
  const E = String(episode || 1).padStart(2, "0");
  if (new RegExp(`s${S}e${E}\\b`, "i").test(t)) return 3;
  if (new RegExp(`\\b${parseInt(S)}x${parseInt(E)}\\b`, "i").test(t)) return 3;
  if (new RegExp(`s${S}\\b`, "i").test(t)) return 1;
  return 0;
}
function looksLikeEpisodeRelease(title) {
  return /\bS\d{1,2}E\d{1,3}\b|\bSeason\s?\d|\b\d{1,2}x\d{1,2}\b/i.test(title);
}
function animeEpisodeMatches(title, episode) {
  if (!episode) return true;
  const t   = title.toLowerCase().replace(/[._]/g, " ");
  const ep  = parseInt(episode, 10);
  const pad = String(ep).padStart(2, "0");
  const patterns = [
    new RegExp(`\\b${ep}\\b`),
    new RegExp(`\\b${pad}\\b`),
    new RegExp(`ep(?:isode)?\\s?0*${ep}\\b`, "i"),
    new RegExp(`#\\s?0*${ep}\\b`),
  ];
  const packPats = [/\bbatch\b/i, /\bcomplete\b/i, /\bcompleta\b/i, /\b01[-–]\d{2,3}\b/];
  return patterns.some(p => p.test(t)) || packPats.some(p => p.test(t));
}
function animeEpisodeMatchRank(title, episode) {
  if (!episode) return 0;
  const ep  = parseInt(episode, 10);
  const pad = String(ep).padStart(2, "0");
  const t   = title.toLowerCase().replace(/[._]/g, " ");
  if (new RegExp(`ep(?:isode)?\\s?0*${ep}\\b`, "i").test(t)) return 3;
  if (new RegExp(`\\b${pad}\\b`).test(t)) return 2;
  if (new RegExp(`\\b${ep}\\b`).test(t)) return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────
// MISC HELPERS
// ─────────────────────────────────────────────────────────
function normalizeImdbId(id) {
  if (!id) return null;
  const m = String(id).match(/tt\d+/i);
  return m ? m[0].toLowerCase() : null;
}
function getResultImdbId(r) {
  const raw = r.Imdb || r.ImdbId || r.imdb || r.imdbId || null;
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/\d+/);
  if (!m) return null;
  return `tt${m[0].padStart(7, "0")}`;
}
function extractReleaseYear(title) {
  const m = title.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  return m ? parseInt(m[1], 10) : null;
}
function pickEpisodeFile(files, season, episode, isAnime) {
  if (!files?.length) return null;
  const videoExts = /\.(mkv|mp4|avi|mov|wmv|m4v|ts|mpg|mpeg|flv|webm)$/i;
  const videos    = files.filter(f => videoExts.test(f.name || ""));
  const pool      = videos.length ? videos : files;
  if (!season && !episode) {
    return pool.reduce((a, b) => (a.size || 0) > (b.size || 0) ? a : b, pool[0]);
  }
  const S   = parseInt(season  || 1, 10);
  const E   = parseInt(episode || 1, 10);
  const pad = String(E).padStart(2, "0");
  if (isAnime) {
    const found = pool.find(f => {
      const n = (f.name || "").toLowerCase();
      return new RegExp(`ep(?:isode)?\\s?0*${E}\\b`, "i").test(n)
          || new RegExp(`\\b${pad}\\b`).test(n)
          || new RegExp(`\\b${E}\\b`).test(n);
    });
    if (found) return found;
  } else {
    const re = new RegExp(`s0*${S}e0*${E}\\b|\\b${S}x0*${E}\\b`, "i");
    const found = pool.find(f => re.test(f.name || ""));
    if (found) return found;
  }
  if (pool.length === 1) return pool[0];
  return pool.reduce((a, b) => (a.size || 0) > (b.size || 0) ? a : b, pool[0]);
}
function extractGroup(title) {
  const m = title.match(/[-.]([A-Z0-9]{2,12})(?:\[.+?\])?$/i);
  return m ? m[1].toUpperCase() : null;
}
function fmtBytes(bytes) {
  if (!bytes) return null;
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}
function renameIndexer(name) {
  if (!name) return name;
  return name
    .replace(/\[TORRENT🧲?\]\s*/gi, '')
    .replace(/🇧🇷\s*Rede/gi, 'Rede Torrent')
    .replace(/🇧🇷\s*TorrentFilmes/gi, 'TorrentFilmes')
    .trim();
}

// ─────────────────────────────────────────────────────────
// FORMATTER
// ─────────────────────────────────────────────────────────
function formatStream(r, indexerName, isAnime = false, prefs = {}, debridLabel = "") {
  const t      = r.Title || "";
  const res    = first(RESOLUTION, t);
  const qual   = first(QUALITY, t);
  const codec  = first(CODEC, t);
  const audios = matchAll(AUDIO, t);
  const vis    = matchAll(VISUAL, t);
  const langs  = getLangs(t, isAnime);
  const group  = extractGroup(t);
  const size   = fmtBytes(r.Size);
  const seeds  = r.Seeders || 0;
  const cleanIndexer = renameIndexer(indexerName);
  const addonName    = prefs.addonName || "ProwJack PRO";
  const resLabel     = res ? res.label : "Desconhecida";
  const langDisplay  = [];
  if (langs.length) langDisplay.push(langs.map(l => `${l.emoji} ${l.label}`).join(" / "));
  else langDisplay.push("🌐 Original");
  const isMulti = /(multi|dual)[-.\s]?(audio)?/i.test(t);
  if (isMulti && isAnime)                              langDisplay.push("🎧 Multi/Dual-Audio");
  else if (isMulti && !langs.some(l => l.code === "pt-br")) langDisplay.push("🎧 Multi");
  const clean = t.replace(/\b\d{4}\b\.?/g, " ").replace(/\./g, " ").replace(/\s{2,}/g, " ").trim();
  // FIX: quando debrid ativo, mostra label do provider em vez de "⚠️ P2P"
  const statusLabel = debridLabel || (prefs.debrid ? "" : "⚠️ P2P");
  const desc = [
    `🎬 ${clean}`,
    [qual ? `🎥 ${qual.label}` : "", vis.length ? `📺 ${vis.map(v => v.label).join(" | ")}` : "", codec ? `🎞️ ${codec.label}` : ""].filter(Boolean).join("  "),
    [audios.length ? `🎧 ${audios.map(a => a.label).join(" | ")}` : "", langDisplay.join(" | ")].filter(Boolean).join("  "),
    [size ? `📦 ${size}` : "", seeds > 0 ? `🌱 ${seeds} seeds` : "", `📡 ${cleanIndexer}`].filter(Boolean).join("  "),
    group ? `🏷️ ${group}` : "",
    statusLabel,
  ].filter(Boolean).join("\n");
  return { name: `${addonName}\n${resLabel}`, description: desc.trim() };
}

// ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════
// DEBRID DIRETO — Real-Debrid e TorBox
// ══════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────

// ── Real-Debrid ────────────────────────────────────────────
// FIX: implementação completa do fluxo RD:
//   1. checkcache por infoHash
//   2. Se cached → addMagnet → selectFiles → info → unrestrict → URL direta
//   3. Se não cached → addMagnet → selectFiles (envia ao debrid p/ download futuro)
//      retorna null para não exibir como stream disponível ainda

async function rdCheckCache(infoHash, apiKey) {
  try {
    const hash = infoHash.toLowerCase();
    const r = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hash}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8000 }
    );
    const data = r.data?.[hash]?.rd;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

async function rdAddMagnet(magnet, apiKey) {
  const params = new URLSearchParams({ magnet });
  const r = await axios.post(
    "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
    params.toString(),
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );
  return r.data?.id || null;
}

async function rdSelectFiles(torrentId, apiKey) {
  const params = new URLSearchParams({ files: "all" });
  await axios.post(
    `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
    params.toString(),
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
  );
}

async function rdGetInfo(torrentId, apiKey) {
  // Polling: aguarda o torrent ficar "downloaded" ou "seeding" (já cacheado processa rápido)
  for (let i = 0; i < 8; i++) {
    const r = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8000 }
    );
    const d = r.data;
    if (d?.status === "downloaded" && d?.links?.length) return d.links;
    if (d?.status === "seeding" && d?.links?.length) return d.links;
    if (d?.status === "error" || d?.status === "magnet_error") return null;
    await new Promise(res => setTimeout(res, 2000));
  }
  return null;
}

async function rdUnrestrict(link, apiKey) {
  const params = new URLSearchParams({ link });
  const r = await axios.post(
    "https://api.real-debrid.com/rest/1.0/unrestrict/link",
    params.toString(),
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
  );
  return r.data?.download || null;
}

async function resolveRealDebrid(infoHash, magnet, apiKey) {
  try {
    const cached = await rdCheckCache(infoHash, apiKey);
    if (!cached) {
      console.log(`  [RD] Não cacheado: ${infoHash} — enviando para download no debrid`);
      if (magnet) {
        const id = await rdAddMagnet(magnet, apiKey);
        if (id) await rdSelectFiles(id, apiKey);
      }
      return null; // não exibe como stream disponível ainda
    }
    console.log(`  [RD] Cacheado! Gerando link direto para: ${infoHash}`);
    const torrentId = await rdAddMagnet(
      magnet || `magnet:?xt=urn:btih:${infoHash}`,
      apiKey
    );
    if (!torrentId) return null;
    await rdSelectFiles(torrentId, apiKey);
    const links = await rdGetInfo(torrentId, apiKey);
    if (!links?.length) return null;
    const directUrl = await rdUnrestrict(links[0], apiKey);
    return directUrl || null;
  } catch (err) {
    console.log(`  [RD] Erro: ${err.message}`);
    return null;
  }
}

// ── TorBox ────────────────────────────────────────────────
// FIX: implementação completa do fluxo TorBox:
//   1. checkcache por hash
//   2. Se cached → createtorrent → requestdl → URL direta
//   3. Se não cached → createtorrent (envia ao debrid p/ download futuro)
//      retorna null para não exibir como stream disponível ainda

async function tbCheckCache(infoHash, apiKey) {
  try {
    const hash = infoHash.toLowerCase();
    const r = await axios.get("https://api.torbox.app/v1/api/torrents/checkcached", {
      params: { hash, format: "object", list_files: true },
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 8000,
    });
    const d = r.data?.data;
    if (!d || d === false) return { cached: false };
    const entry = d[hash] || d[hash.toUpperCase()] || Object.values(d)[0];
    if (!entry) return { cached: false };
    return { cached: true, files: entry.files || [] };
  } catch {
    return { cached: false };
  }
}

async function tbCreateTorrent(magnet, apiKey) {
  // Primeiro verificar se já existe na lista
  try {
    const list = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
      params: { bypass_cache: true },
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 8000,
    });
    const items = list.data?.data || [];
    const hash  = (magnet.match(/xt=urn:btih:([a-f0-9]+)/i) || [])[1]?.toLowerCase();
    if (hash) {
      const existing = items.find(t => (t.hash || "").toLowerCase() === hash);
      if (existing) return existing.id;
    }
  } catch {}
  // Criar novo
  const form = new URLSearchParams({ magnet });
  const r = await axios.post(
    "https://api.torbox.app/v1/api/torrents/createtorrent",
    form.toString(),
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );
  return r.data?.data?.torrent_id || null;
}

async function tbRequestDl(torrentId, fileId, apiKey) {
  const r = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl", {
    params: { token: apiKey, torrent_id: torrentId, file_id: fileId, zip_link: false },
    timeout: 10000,
  });
  return r.data?.data || null;
}

async function resolveTorBox(infoHash, magnet, fileIdx, apiKey) {
  try {
    const hash   = infoHash.toLowerCase();
    const mag    = magnet || `magnet:?xt=urn:btih:${hash}`;
    const result = await tbCheckCache(hash, apiKey);
    if (!result.cached) {
      console.log(`  [TB] Não cacheado: ${hash} — enviando para download no debrid`);
      await tbCreateTorrent(mag, apiKey);
      return null; // não exibe como stream disponível
    }
    console.log(`  [TB] Cacheado! Gerando link direto para: ${hash}`);
    const torrentId = await tbCreateTorrent(mag, apiKey);
    if (!torrentId) return null;
    // Escolher file_id: usar fileIdx se disponível, senão pegar maior arquivo
    const files  = result.files || [];
    let fileId   = 0;
    if (files.length) {
      if (fileIdx !== undefined && fileIdx !== null && files[fileIdx]) {
        fileId = files[fileIdx].id ?? fileIdx;
      } else {
        const biggest = files.reduce((a, b) => ((a.size || 0) > (b.size || 0) ? a : b), files[0]);
        fileId = biggest.id ?? 0;
      }
    }
    const dlUrl = await tbRequestDl(torrentId, fileId, apiKey);
    return dlUrl || null;
  } catch (err) {
    console.log(`  [TB] Erro: ${err.message}`);
    return null;
  }
}

// ── Dispatcher debrid direto ──────────────────────────────
async function resolveDebridDirect(infoHash, magnet, fileIdx, prefs) {
  if (!prefs.debrid || !prefs.debridKey) return null;
  if (prefs.debridProvider === "realdebrid") {
    return resolveRealDebrid(infoHash, magnet, prefs.debridKey);
  }
  if (prefs.debridProvider === "torbox") {
    return resolveTorBox(infoHash, magnet, fileIdx, prefs.debridKey);
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// JACKETT + SEARCH
// ─────────────────────────────────────────────────────────
async function jackettFetchIndexers() {
  try {
    const res = await axios.get(`${ENV.jackettUrl}/api/v2.0/indexers/all/results`, {
      params: qp({ Query: "" }), timeout: 15000, validateStatus: () => true,
    });
    if (res.status < 400 && Array.isArray(res.data?.Indexers)) {
      return res.data.Indexers
        .map(ix => ({ id: String(ix.ID).trim(), name: String(ix.Name).trim() }))
        .filter(ix => ix.id && ix.id !== "all");
    }
  } catch {}
  return [];
}
function decodeXmlEntities(str = "") {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
function xmlTagValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeXmlEntities(m[1].trim()) : null;
}
function parseTorznabResults(xml, indexer) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => {
    const attrs = {};
    for (const m of item.matchAll(/<(?:torznab:)?attr\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?/gi))
      attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2]);
    const enclosure = item.match(/<enclosure\b[^>]*url="([^"]+)"[^>]*length="([^"]*)"/i);
    const magnetUri = attrs.magneturl || null;
    const link = magnetUri ? magnetUri : (xmlTagValue(item, "link") || enclosure?.[1] || null);
    const size = attrs.size ? parseInt(attrs.size, 10) : (enclosure?.[2] ? parseInt(enclosure[2], 10) : 0);
    const seeders = attrs.seeders ? parseInt(attrs.seeders, 10) : 0;
    return {
      Title:     xmlTagValue(item, "title") || "",
      Link:      link,
      MagnetUri: magnetUri,
      InfoHash:  attrs.infohash || null,
      Size:      size,
      Seeders:   seeders,
      Tracker:   indexer,
      TrackerId: indexer,
      Imdb:      attrs.imdb || attrs.imdbid || null,
    };
  }).filter(r => r.Title);
}
async function jackettSearchOne(indexer, params, timeout = 12000) {
  if (await isRateLimited(indexer)) return [];
  try {
    const url = `${ENV.jackettUrl}/api/v2.0/indexers/${indexer}/results/torznab`;
    const res = await axios.get(url, { params: qp(params), timeout, validateStatus: s => s < 500 });
    if (res.status === 429) { await setRateLimit(indexer, res.headers["retry-after"]); return []; }
    if (res.status >= 400) return [];
    const xml = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return parseTorznabResults(xml, indexer);
  } catch (err) {
    if (err.response?.status === 429) await setRateLimit(indexer, err.response.headers["retry-after"]);
    return [];
  }
}

function buildJackettParams(search) {
  if (!search) return null;
  const p = { t: search.mode, limit: 100 };
  if (search.imdbId) {
    p.imdbid = search.imdbId.replace("tt", "");
  } else if (search.title) {
    p.q = search.title;
  }
  if (search.mode === "tvsearch") {
    if (search.season)  p.season  = search.season;
    if (search.episode) p.ep      = search.episode;
  }
  return p;
}

function deduplicateResults(results) {
  const seen = new Map();
  for (const r of results) {
    const key = (r.InfoHash || "").toLowerCase() || r.Title;
    if (!seen.has(key) || (r.Seeders || 0) > (seen.get(key).Seeders || 0)) {
      seen.set(key, r);
    }
  }
  return [...seen.values()];
}

async function jackettSearch({ parsed, queries, search }, indexers, prefs) {
  const slow = prefs.slowThreshold || 8000;
  const queryList = queries.slice(0, 3);
  const cacheKey  = `search:${CACHE_VERSION}:${Buffer.from(JSON.stringify({ queryList, search: search || null, parsed: parsed || null })).toString("base64")}:${indexers.join(",")}`;
  const cached    = await rc.get(cacheKey);
  if (cached) {
    console.log("  [Cache] HIT");
    return JSON.parse(cached);
  }

  const structParams = search ? buildJackettParams(search) : null;
  const textParamsList = queryList.map(q => ({ t: "search", q, limit: 100 }));

  const fastStart = Date.now();
  const fastRaw = await Promise.all(
    indexers.flatMap(ix => {
      const calls = [];
      if (structParams) calls.push(jackettSearchOne(ix, structParams, slow));
      calls.push(...textParamsList.map(p => jackettSearchOne(ix, p, slow)));
      return calls;
    })
  );
  const fastDeduped = deduplicateResults(fastRaw.flat());
  console.log(`  [Jackett] Fast: ${fastDeduped.length} resultados em ${Date.now() - fastStart}ms`);
  if (fastDeduped.length === 0) { await rc.set(cacheKey, JSON.stringify([]), 300); return []; }

  const remaining = Math.max(0, slow - (Date.now() - fastStart));
  if (remaining > 1000) {
    const slowRaw = await Promise.all(
      indexers.flatMap(ix =>
        textParamsList.map(p => jackettSearchOne(ix, p, remaining))
      )
    );
    const slowDeduped = deduplicateResults([...fastRaw.flat(), ...slowRaw.flat()]);
    await rc.set(cacheKey, JSON.stringify(slowDeduped), 1800);
    return slowDeduped;
  }
  await rc.set(cacheKey, JSON.stringify(fastDeduped), 1800);
  return fastDeduped;
}

// ─────────────────────────────────────────────────────────
// RESOLVE INFOHASH / TORRENT
// ─────────────────────────────────────────────────────────
function extractInfoHashFromMagnet(magnet) {
  const m = (magnet || "").match(/xt=urn:btih:([a-f0-9]{40}|[A-Z2-7]{32})/i);
  if (!m) return null;
  let hash = m[1];
  if (hash.length === 32) {
    // Base32 → hex
    try {
      const b32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      let bits = "";
      for (const c of hash.toUpperCase()) {
        const idx = b32.indexOf(c);
        if (idx < 0) return null;
        bits += idx.toString(2).padStart(5, "0");
      }
      hash = "";
      for (let i = 0; i + 4 <= bits.length; i += 4)
        hash += parseInt(bits.slice(i, i + 4), 2).toString(16);
    } catch { return null; }
  }
  return hash.toLowerCase();
}

async function resolveInfoHash(r) {
  if (r.InfoHash) {
    return { infoHash: r.InfoHash.toLowerCase(), files: null };
  }
  if (r.MagnetUri) {
    const h = extractInfoHashFromMagnet(r.MagnetUri);
    if (h) return { infoHash: h, files: null };
  }
  if (r.Link && r.Link.startsWith("magnet:")) {
    const h = extractInfoHashFromMagnet(r.Link);
    if (h) return { infoHash: h, files: null };
  }
  if (r.Link && r.Link.startsWith("http")) {
    try {
      const resp = await axios.get(r.Link, { responseType: "arraybuffer", timeout: 8000 });
      const buf  = Buffer.from(resp.data);
      const hex  = buf.toString("hex");
      // Busca SHA1 hash do info dict no torrent (simplificado: pega do bencode)
      const infoIdx = hex.indexOf("34:696e666f");
      if (infoIdx >= 0) {
        const sha = crypto.createHash("sha1").update(buf).digest("hex");
        return { infoHash: sha, files: null };
      }
    } catch {}
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// META (CINEMETA)
// ─────────────────────────────────────────────────────────
async function fetchMeta(type, id) {
  const cacheKey = `meta:${type}:${id}`;
  const hit = await rc.get(cacheKey);
  if (hit) return JSON.parse(hit);
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const meta = data?.meta || {};
    const result = {
      title:   meta.name || meta.title || id,
      year:    meta.year  ? parseInt(meta.year, 10) : null,
      imdbId:  meta.imdb_id || (id.startsWith("tt") ? id : null),
      aliases: [
        meta.name,
        ...(meta.aliases || []),
        meta.original_title,
      ].filter(Boolean),
    };
    await rc.set(cacheKey, JSON.stringify(result), 86400);
    return result;
  } catch {
    return { title: id, year: null, imdbId: id.startsWith("tt") ? id : null, aliases: [] };
  }
}

// ─────────────────────────────────────────────────────────
// BUILD QUERIES
// ─────────────────────────────────────────────────────────
function parseEpisodeId(id) {
  // kitsu:12345:1 ou tt0123456:1:2
  const kitsuMatch = id.match(/^kitsu:(\d+)(?::(\d+))?$/);
  if (kitsuMatch) return { metaId: `kitsu:${kitsuMatch[1]}`, isAnime: true, season: 1, episode: kitsuMatch[2] ? parseInt(kitsuMatch[2], 10) : null };
  const parts = id.split(":");
  const metaId  = parts[0];
  const season  = parts[1] ? parseInt(parts[1], 10) : null;
  const episode = parts[2] ? parseInt(parts[2], 10) : null;
  return { metaId, isAnime: false, season, episode };
}

async function buildQueries(type, id) {
  const parsed = parseEpisodeId(id);
  const meta   = await fetchMeta(type, parsed.metaId);
  const episode = type === "series" ? (parsed.episode ?? 1) : null;
  const queries = [meta.title, ...meta.aliases].filter(Boolean);
  return {
    parsed,
    displayTitle: meta.title,
    aliases:      meta.aliases,
    queries:      uniq(queries.map(normTitle)),
    episode,
    year:         meta.year,
    search: parsed.isAnime ? null : {
      mode:    type === "movie" ? "movie" : "tvsearch",
      imdbId:  meta.imdbId,
      title:   meta.title,
      year:    meta.year,
      season:  parsed.season,
      episode: parsed.episode,
    },
  };
}

// ─────────────────────────────────────────────────────────
// API E MANIFEST
// ─────────────────────────────────────────────────────────
app.get("/api/debrid/test/:provider", async (req, res) => {
  const { provider } = req.params;
  const key = (req.query.key || "").trim();
  if (!key) return res.json({ ok: false, error: "API Key não informada" });
  try {
    if (provider === "torbox") {
      const r = await axios.get("https://api.torbox.app/v1/api/user/me",
        { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
      const d = r.data?.data || {};
      return res.json({ ok: true, name: d.email || d.customer || "Usuário", plan: d.plan || "" });
    }
    if (provider === "realdebrid") {
      const r = await axios.get("https://api.real-debrid.com/rest/1.0/user",
        { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 });
      return res.json({ ok: true, name: r.data?.username || "Usuário", plan: r.data?.type || "" });
    }
    return res.json({ ok: false, error: "Provider desconhecido" });
  } catch (err) {
    const s = err.response?.status;
    return res.json({ ok: false, error: s === 401 ? "Key inválida (401)" : s === 403 ? "Acesso negado (403)" : err.message });
  }
});

app.get("/api/env",     (_, res) => res.json({ jackettUrl: ENV.jackettUrl, apiKeySet: !!ENV.apiKey, port: ENV.port, redisUrl: ENV.redisUrl }));
app.get("/api/indexers", async (_, res) => {
  try   { const indexers = await jackettFetchIndexers(); res.json({ ok: true, count: indexers.length, indexers }); }
  catch (err) { res.json({ ok: false, error: err.message, indexers: [] }); }
});
app.get("/api/test", async (_, res) => {
  try   { const indexers = await jackettFetchIndexers(); res.json({ ok: true, count: indexers.length, indexers }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});
app.get("/api/metrics", async (_, res) => {
  const keys = await rc.keys("metrics:*");
  const out  = {};
  for (const k of keys) { const raw = await rc.get(k); if (raw) out[k.replace("metrics:", "")] = JSON.parse(raw); }
  res.json(out);
});
app.delete("/api/metrics/:indexer", async (req, res) => {
  await rc.del(`metrics:${req.params.indexer}`); res.json({ ok: true });
});

// FIX: manifest raiz sempre p2p:true (correto — sem config não sabe se debrid)
app.get("/manifest.json", (_, res) => {
  res.json({
    id: "org.prowjack.pro", version: "3.8.0", name: "ProwJack PRO",
    description: "Configure os parametros pela URL.",
    resources: ["stream"], types: ["movie", "series"], idPrefixes: ["tt", "kitsu:"],
    catalogs: [], behaviorHints: { configurable: true, configurationRequired: true, p2p: true },
  });
});

app.get("/configure", (_, res) => {
  const publicPath = path.join(__dirname, "public", "configure.html");
  const rootPath   = path.join(__dirname, "configure.html");
  if (fs.existsSync(publicPath))    res.sendFile(publicPath);
  else if (fs.existsSync(rootPath)) res.sendFile(rootPath);
  else res.status(404).send("Arquivo configure.html nao encontrado.");
});
app.get("/", (_, res) => res.redirect("/configure"));

// FIX: manifest personalizado — p2p:false quando debrid ativo
app.get("/:userConfig/manifest.json", (req, res) => {
  const prefs = resolvePrefs(req.params.userConfig);
  const types = [...new Set((prefs.categories || ["movie","series"]).map(c => c==="movies"?"movie":c==="anime"?"series":c))];
  const name  = prefs.addonName || "ProwJack PRO";
  const isDebrid = !!(prefs.debrid && prefs.debridKey && prefs.debridProvider);
  res.json({
    id: "org.prowjack.pro", version: "3.8.0", name,
    description: isDebrid
      ? `Jackett + ${prefs.debridProvider === "realdebrid" ? "Real-Debrid" : "TorBox"} · Direto`
      : `Jackett Otimizado · Prioridade PT-BR`,
    resources: ["stream"], types, idPrefixes: ["tt", "kitsu:"], catalogs: [],
    // FIX CRÍTICO: p2p:false desativa modo P2P no Stremio quando debrid está configurado
    behaviorHints: { configurable: true, configurationRequired: false, p2p: !isDebrid },
  });
});

// ─────────────────────────────────────────────────────────
// STREAMS
// ─────────────────────────────────────────────────────────
const BAD_RE = /\b(cam|hdcam|camrip|workprint)\b/i;

app.get("/:userConfig/stream/:type/:id.json", async (req, res) => {
  const prefs      = resolvePrefs(req.params.userConfig);
  const { type, id } = req.params;
  console.log(`\n=========================================`);
  console.log(`NOVA BUSCA: [${type}] ${id}`);
  const isDebridMode = !!(prefs.debrid && prefs.debridKey && prefs.debridProvider);
  if (isDebridMode) {
    console.log(`[DEBRID] Modo ativo: ${prefs.debridProvider}`);
  }

  // ── Proxy StremThru ───────────────────────────────────
  if (prefs.stConfig) {
    console.log(`[PROXY] Conversao Debrid Ativa...`);
    const rawPrefs = { ...prefs };
    delete rawPrefs.stConfig;
    rawPrefs.debrid = true;
    const rawB64 = Buffer.from(JSON.stringify(rawPrefs), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const protocol    = req.headers['x-forwarded-proto'] || req.protocol;
    const host        = req.headers['x-forwarded-host']  || req.get('host');
    const upstreamUrl = `${protocol}://${host}/${rawB64}/manifest.json`;
    const wrapper     = { upstreams: [{ u: upstreamUrl }], stores: prefs.stConfig.stores };
    const b64Wrap     = Buffer.from(JSON.stringify(wrapper), 'utf8').toString('base64');
    const stUrl       = `${prefs.stConfig.url}/stremio/wrap/${encodeURIComponent(b64Wrap)}/stream/${type}/${id}.json`;
    try {
      const { data } = await axios.get(stUrl, { timeout: 60000, headers: { "User-Agent": "ProwJack/3.8" } });
      console.log(`[PROXY] Sucesso! ${data?.streams?.length || 0} links.`);
      console.log(`=========================================\n`);
      return res.json({ streams: data.streams || [] });
    } catch (err) {
      console.log(`[PROXY] StremThru falhou: ${err.message}`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
  }

  // ── Busca principal ───────────────────────────────────
  try {
    const { parsed, displayTitle, aliases = [], queries, episode, year, search } = await buildQueries(type, id);
    const requestedImdbId = normalizeImdbId(search?.imdbId || parsed?.metaId);

    // Verificação de categorias habilitadas
    const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length
      ? prefs.categories : ["movie", "series"];
    if (parsed.isAnime && !enabledCats.includes("anime")) {
      console.log(`[Categoria] Anime bloqueado`); console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
    if (!parsed.isAnime && type === "series" && !enabledCats.includes("series")) {
      console.log(`[Categoria] Serie bloqueada`); console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
    if (type === "movie" && !enabledCats.includes("movie")) {
      console.log(`[Categoria] Filme bloqueado`); console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }

    const indexers = await resolveSearchIndexers(prefs, parsed.isAnime);
    const results  = await jackettSearch({ parsed, queries, search }, indexers, prefs);
    const priorityLang = prefs.priorityLang ?? "pt-br";

    let rejectedBySeriesFilter = 0, rejectedByTitleMatch = 0, rejectedByYear = 0, rejectedByMovieShape = 0;

    const candidates = results
      .filter(r => r?.InfoHash || r?.MagnetUri || r?.Link)
      .filter(r => !prefs.skipBadReleases || !BAD_RE.test(r.Title || ""))
      .filter(r => {
        if (type !== "movie") return true;
        const ok = !looksLikeEpisodeRelease(r.Title || "");
        if (!ok) rejectedByMovieShape++;
        return ok;
      })
      .filter(r => {
        if (parsed.isAnime) return animeEpisodeMatches(r.Title || "", episode);
        if (type === "series") {
          const matches = seriesEpisodeMatches(r.Title || "", parsed.season, parsed.episode);
          if (!matches) rejectedBySeriesFilter++;
          return matches;
        }
        return true;
      })
      .filter(r => {
        if (!prefs.onlyDubbed) return true;
        if (!priorityLang)     return true;
        return getLangs(r.Title || "", parsed.isAnime).some(l => l.code === priorityLang);
      })
      .filter(r => {
        const resultImdbId = getResultImdbId(r);
        if (requestedImdbId && resultImdbId && resultImdbId === requestedImdbId) {
          r._titleMatchScore = Math.max(r._titleMatchScore || 0, 1);
          r._metaIdMatch = true;
          return true;
        }
        const sc         = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
        const relaxedSc  = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
        const episodeRank = parsed.isAnime
          ? animeEpisodeMatchRank(r.Title || "", episode)
          : episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
        const minScore   = parsed.isAnime ? 0.34 : (type === "series" && episodeRank >= 2 ? 0.2 : 0.45);
        const finalScore = Math.max(sc, type === "series" ? relaxedSc * 0.8 : 0);
        const ok = finalScore >= minScore;
        if (!ok) rejectedByTitleMatch++;
        r._titleMatchScore = finalScore;
        return ok;
      })
      .filter(r => {
        if (type !== "movie" || !year) return true;
        const releaseYear = extractReleaseYear(r.Title || "");
        if (!releaseYear) return true;
        const ok = releaseYear === year;
        if (!ok) rejectedByYear++;
        return ok;
      })
      .sort((a, b) =>
        (((b._metaIdMatch ? 1 : 0) * 40000) +
          ((b._structuredMatch ? 1 : 0) * 20000) +
          (parsed.isAnime
            ? animeEpisodeMatchRank(b.Title || "", episode)
            : episodeMatchRank(b.Title || "", parsed.season, parsed.episode)) * 10000 +
          (b._titleMatchScore || 0) * 1000 +
          score(b, prefs.weights, parsed.isAnime, priorityLang)) -
        (((a._metaIdMatch ? 1 : 0) * 40000) +
          ((a._structuredMatch ? 1 : 0) * 20000) +
          (parsed.isAnime
            ? animeEpisodeMatchRank(a.Title || "", episode)
            : episodeMatchRank(a.Title || "", parsed.season, parsed.episode)) * 10000 +
          (a._titleMatchScore || 0) * 1000 +
          score(a, prefs.weights, parsed.isAnime, priorityLang))
      );

    if (type === "series" && rejectedBySeriesFilter > 0)
      console.log(`Filtro de Serie: ${rejectedBySeriesFilter} descartados.`);
    if (rejectedByTitleMatch > 0)
      console.log(`Filtro de Titulo: ${rejectedByTitleMatch} descartados.`);
    if (rejectedByYear > 0)
      console.log(`Filtro de Ano: ${rejectedByYear} descartados.`);
    if (rejectedByMovieShape > 0)
      console.log(`Filtro de Filme: ${rejectedByMovieShape} episodicos descartados.`);

    const langLabel = priorityLang ? `Idioma prioritário: ${priorityLang.toUpperCase()}` : `Sem preferência de idioma`;
    console.log(`${langLabel} | onlyDubbed: ${prefs.onlyDubbed}`);
    console.log(`Resolvendo InfoHash de ${candidates.length} candidatos...`);

    const resolvedAll = await Promise.all(
      candidates.map(async r => {
        const resolved = await resolveInfoHash(r);
        if (!resolved?.infoHash) {
          console.log(`  Erro ou torrent vazio em "${(r.Title||"").slice(0,60)}"`);
          return null;
        }
        const matchedFile = (type === "series" || parsed.isAnime)
          ? pickEpisodeFile(resolved.files, parsed.season, parsed.episode ?? episode, parsed.isAnime)
          : null;
        const indexerName           = r.Tracker || r.TrackerId || "Unknown";
        const magnet                = r.MagnetUri || (r.Link?.startsWith("magnet:") ? r.Link : null);

        // ── FIX PRINCIPAL: debrid direto ──────────────────
        if (isDebridMode) {
          const directUrl = await resolveDebridDirect(
            resolved.infoHash,
            magnet || `magnet:?xt=urn:btih:${resolved.infoHash}`,
            matchedFile?.idx,
            prefs
          );
          if (!directUrl) {
            // Não cacheado: foi enviado para download — não retorna como stream
            console.log(`  [Debrid] Não cacheado, enviado p/ download: ${resolved.infoHash.slice(0,12)}...`);
            return null;
          }
          // Cacheado: retorna URL direta HTTP (sem P2P)
          console.log(`  [Debrid] Link direto obtido: ${resolved.infoHash.slice(0,12)}...`);
          const { name, description } = formatStream(
            r, indexerName, parsed.isAnime, prefs,
            prefs.debridProvider === "realdebrid" ? "⚡ Real-Debrid" : "⚡ TorBox"
          );
          return {
            name,
            description: matchedFile?.name
              ? `${description}\n📂 ${matchedFile.name}`
              : description,
            url: directUrl,  // URL direta — não P2P
            behaviorHints: {
              filename: matchedFile?.name,
              videoSize: matchedFile?.size ?? r.Size,
              bingeGroup: parsed.isAnime
                ? `prowjack|anime|${displayTitle}`
                : `prowjack|${resolved.infoHash}`,
              notWebReady: false,
            },
          };
        }

        // ── Modo P2P (sem debrid) ──────────────────────────
        const { name, description } = formatStream(r, indexerName, parsed.isAnime, prefs, "");
        const sources = magnet ? [magnet] : [];
        return {
          name,
          description: matchedFile?.name
            ? `${description}\n📂 ${matchedFile.name}`
            : description,
          infoHash: resolved.infoHash,
          fileIdx: matchedFile?.idx,
          sources,
          behaviorHints: {
            filename: matchedFile?.name,
            videoSize: matchedFile?.size,
            bingeGroup: parsed.isAnime
              ? `prowjack|anime|${displayTitle}`
              : `prowjack|${resolved.infoHash}`,
          },
        };
      })
    );

    const finalStreams = resolvedAll.filter(Boolean).slice(0, prefs.maxResults || 20);
    console.log(`Streams prontos: ${finalStreams.length} resultados enviados!`);
    console.log(`=========================================\n`);
    res.json({ streams: finalStreams });
  } catch (err) {
    console.log(`Erro: ${err.message}`);
    res.json({ streams: [] });
  }
});

app.listen(ENV.port, () => {
  console.log(`ProwJack PRO v3.8.0 -> http://localhost:${ENV.port}/configure`);
  console.log(`   Jackett : ${ENV.jackettUrl}`);
  console.log(`   Redis   : ${ENV.redisUrl}`);
});
