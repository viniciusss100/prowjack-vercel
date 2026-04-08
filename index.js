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
const CACHE_VERSION = "v6-debrid";
// ─────────────────────────────────────────────────────────
// DEBRID PROVIDERS
// ─────────────────────────────────────────────────────────
class TorBoxProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.torbox.app/v1/api";
  }

  async checkCached(hashes) {
    try {
      const hashParam = hashes.join(",");
      const url = `${this.baseUrl}/torrents/checkcached?hash=${hashParam}&format=object&list_files=true`;
      const response = await axios.get(url, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
        timeout: 10000
      });
      return response.data?.data || {};
    } catch (err) {
      console.error(`[TorBox] Erro ao checar cache: ${err.message}`);
      return {};
    }
  }

  async addTorrent(magnet) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/torrents/createtorrent`,
        new URLSearchParams({ magnet, seed: 1 }),
        {
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          timeout: 15000
        }
      );
      return response.data?.data?.torrent_id || null;
    } catch (err) {
      console.error(`[TorBox] Erro ao adicionar torrent: ${err.message}`);
      return null;
    }
  }

  async getTorrentInfo(torrentId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/torrents/mylist?bypass_cache=true&id=${torrentId}`,
        {
          headers: { "Authorization": `Bearer ${this.apiKey}` },
          timeout: 10000
        }
      );
      const data = response.data?.data;
      if (Array.isArray(data) && data.length > 0) return data[0];
      return data || null;
    } catch (err) {
      console.error(`[TorBox] Erro ao obter info: ${err.message}`);
      return null;
    }
  }

  async getDownloadLink(torrentId, fileId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/torrents/requestdl?torrent_id=${torrentId}&file_id=${fileId}&token=${this.apiKey}`,
        { 
          timeout: 10000,
          maxRedirects: 0,
          validateStatus: (status) => status === 200 || status === 302
        }
      );
      return response.data?.data || null;
    } catch (err) {
      console.error(`[TorBox] Erro ao obter link: ${err.message}`);
      return null;
    }
  }
}

class RealDebridProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.real-debrid.com/rest/1.0";
  }

  async checkCached(hashes) {
    try {
      const hashesPath = hashes.map(h => h.toLowerCase()).join("/");
      const url = `${this.baseUrl}/torrents/instantAvailability/${hashesPath}`;
      const response = await axios.get(url, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
        timeout: 10000
      });
      return response.data || {};
    } catch (err) {
      console.error(`[Real-Debrid] Erro ao checar cache: ${err.message}`);
      return {};
    }
  }

  async addTorrent(magnet) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/torrents/addMagnet`,
        `magnet=${encodeURIComponent(magnet)}`,
        {
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          timeout: 15000
        }
      );
      return response.data?.id || null;
    } catch (err) {
      console.error(`[Real-Debrid] Erro ao adicionar torrent: ${err.message}`);
      return null;
    }
  }

  async selectFiles(torrentId, fileIds) {
    try {
      const files = fileIds === "all" ? "all" : fileIds.join(",");
      await axios.post(
        `${this.baseUrl}/torrents/selectFiles/${torrentId}`,
        `files=${files}`,
        {
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          timeout: 10000
        }
      );
      return true;
    } catch (err) {
      console.error(`[Real-Debrid] Erro ao selecionar arquivos: ${err.message}`);
      return false;
    }
  }

  async getTorrentInfo(torrentId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/torrents/info/${torrentId}`,
        {
          headers: { "Authorization": `Bearer ${this.apiKey}` },
          timeout: 10000
        }
      );
      return response.data || null;
    } catch (err) {
      console.error(`[Real-Debrid] Erro ao obter info: ${err.message}`);
      return null;
    }
  }

  async unrestrict(link) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/unrestrict/link`,
        `link=${encodeURIComponent(link)}`,
        {
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          timeout: 10000
        }
      );
      return response.data?.download || null;
    } catch (err) {
      console.error(`[Real-Debrid] Erro ao unrestrict: ${err.message}`);
      return null;
    }
  }
}

function createDebridProvider(type, apiKey) {
  if (!apiKey) return null;
  switch (type) {
    case "torbox": return new TorBoxProvider(apiKey);
    case "realdebrid": return new RealDebridProvider(apiKey);
    default: return null;
  }
}

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
    debrid:          false,
    debridService:   "",      // "torbox" ou "realdebrid"
    debridApiKey:    "",      // API key do serviço debrid
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
];
const LANG_PATTERNS = [
  { re: /\b(pt[-.]?br|dublado|dual[-.]?audio)\b/i, code: "pt-br", label: "PT-BR 🇧🇷" },
  { re: /\b(pt|portuguese)\b/i,                     code: "pt",    label: "PT 🇵🇹"    },
  { re: /\bmulti\b/i,                               code: "multi", label: "Multi 🌍"  },
  { re: /\b(legendado|pt[-.]?subs?)\b/i,            code: "leg",   label: "Leg 📝"    },
  { re: /\beng(lish)?\b/i,                          code: "en",    label: "EN 🇬🇧"    },
  { re: /\b(spa(nish)?|espanol)\b/i,                code: "es",    label: "ES 🇪🇸"    },
  { re: /\b(fr|french|francais)\b/i,                code: "fr",    label: "FR 🇫🇷"    },
  { re: /\b(it|italian|italiano)\b/i,               code: "it",    label: "IT 🇮🇹"    },
  { re: /\b(ja(p(anese)?)?|jpn)\b/i,                code: "ja",    label: "JA 🇯🇵"    },
  { re: /\b(ger(man)?|deu)\b/i,                     code: "de",    label: "DE 🇩🇪"    },
];
function extractFeature(text, dict) {
  for (const item of dict) {
    if (item.re.test(text)) return item;
  }
  return null;
}
function extractAll(text, dict) {
  return dict.filter(i => i.re.test(text));
}
function extractResolution(text) {
  return extractFeature(text, RESOLUTION);
}
function extractQuality(text) {
  return extractFeature(text, QUALITY);
}
function extractCodec(text) {
  return extractFeature(text, CODEC);
}
function extractAudio(text) {
  return extractAll(text, AUDIO);
}
function extractVisual(text) {
  return extractAll(text, VISUAL);
}
function getLangs(text, isAnime) {
  const found = [];
  const norm = text.toLowerCase();
  for (const p of LANG_PATTERNS) {
    if (p.re.test(norm)) found.push(p);
  }
  if (found.length === 0 && !isAnime) {
    found.push({ code: "en", label: "EN 🇬🇧" });
  }
  return found;
}
function extractSeasonEpisode(text) {
  const match = text.match(/\bs(\d{1,2})e(\d{1,3})\b/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
  const packMatch = text.match(/\btemporada\s*(\d{1,2})\b/i);
  if (packMatch) return { season: parseInt(packMatch[1], 10), episode: null };
  return null;
}
function extractReleaseYear(text) {
  const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
  return yearMatch ? parseInt(yearMatch[1], 10) : null;
}
function parseSize(text) {
  const m = text.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const multiplier = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return val * (multiplier[unit] || 1);
}
const BAD_RE = /\b(cam(rip)?|ts|telesync|telecine|hdcam)\b/i;
function looksLikeEpisodeRelease(title) {
  if (!title) return false;
  const norm = title.toLowerCase();
  if (/\bs\d{1,2}e\d{1,3}\b/i.test(norm)) return true;
  if (/\be(p(isode)?)?\.?\s?\d{1,3}\b/i.test(norm)) return true;
  if (/\b\d{1,2}x\d{1,3}\b/i.test(norm)) return true;
  return false;
}
function seriesEpisodeMatches(title, reqSeason, reqEpisode) {
  if (!title) return false;
  const info = extractSeasonEpisode(title);
  if (!info) {
    if (/\btemporada\s*completa\b/i.test(title) || /\bcomplete\s*season\b/i.test(title)) {
      return true;
    }
    return false;
  }
  if (info.season !== reqSeason) return false;
  if (info.episode === null) return true;
  if (info.episode === reqEpisode) return true;
  const packMatch = title.match(/\be(\d{1,3})-?e?(\d{1,3})\b/i);
  if (packMatch) {
    const start = parseInt(packMatch[1], 10);
    const end = parseInt(packMatch[2], 10);
    return reqEpisode >= start && reqEpisode <= end;
  }
  return false;
}
function episodeMatchRank(title, reqSeason, reqEpisode) {
  if (!title) return 0;
  const info = extractSeasonEpisode(title);
  if (!info) return 0;
  if (info.season !== reqSeason) return 0;
  if (info.episode === reqEpisode) return 3;
  if (info.episode === null) return 1;
  const packMatch = title.match(/\be(\d{1,3})-?e?(\d{1,3})\b/i);
  if (packMatch) {
    const start = parseInt(packMatch[1], 10);
    const end = parseInt(packMatch[2], 10);
    if (reqEpisode >= start && reqEpisode <= end) return 2;
  }
  return 0;
}
function animeEpisodeMatches(title, episode) {
  if (!episode) return true;
  const norm = title.toLowerCase();
  const ep = String(episode).padStart(2, '0');
  const regex1 = new RegExp(`\\b${episode}\\b`, 'i');
  if (regex1.test(norm)) return true;
  const regex2 = new RegExp(`\\b${ep}\\b`, 'i');
  if (regex2.test(norm)) return true;
  const batchRe = /\b(\d{1,3})\s*-\s*(\d{1,3})\b/;
  const batchMatch = norm.match(batchRe);
  if (batchMatch) {
    const start = parseInt(batchMatch[1], 10);
    const end = parseInt(batchMatch[2], 10);
    return episode >= start && episode <= end;
  }
  return false;
}
function animeEpisodeMatchRank(title, episode) {
  if (!episode) return 0;
  const norm = title.toLowerCase();
  const ep = String(episode).padStart(2, '0');
  const regex1 = new RegExp(`\\b${episode}\\b`, 'i');
  const regex2 = new RegExp(`\\b${ep}\\b`, 'i');
  if (regex1.test(norm) || regex2.test(norm)) return 3;
  const batchRe = /\b(\d{1,3})\s*-\s*(\d{1,3})\b/;
  const batchMatch = norm.match(batchRe);
  if (batchMatch) {
    const start = parseInt(batchMatch[1], 10);
    const end = parseInt(batchMatch[2], 10);
    if (episode >= start && episode <= end) return 1;
  }
  return 0;
}
function normalizeTitle(str) {
  return str
    .toLowerCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/[àáâãäå]/g, "a")
    .replace(/[èéêë]/g, "e")
    .replace(/[ìíîï]/g, "i")
    .replace(/[òóôõö]/g, "o")
    .replace(/[ùúûü]/g, "u")
    .replace(/ç/g, "c")
    .replace(/ñ/g, "n");
}
function titleMatchScore(title, allowedTitles) {
  const normTitle = normalizeTitle(title);
  for (const allowed of allowedTitles) {
    if (!allowed) continue;
    const normAllowed = normalizeTitle(allowed);
    if (normTitle.includes(normAllowed) || normAllowed.includes(normTitle)) {
      return 1;
    }
  }
  const threshold = 0.4;
  const bestScore = allowedTitles.reduce((best, allowed) => {
    if (!allowed) return best;
    const s = jaroWinkler(normalizeTitle(allowed), normTitle);
    return Math.max(best, s);
  }, 0);
  return bestScore >= threshold ? bestScore : 0;
}
function relaxedTitleMatchScore(title, allowedTitles) {
  const words = title.toLowerCase().split(/\s+/);
  for (const allowed of allowedTitles) {
    if (!allowed) continue;
    const allowedLower = allowed.toLowerCase();
    let hits = 0;
    for (const w of words) {
      if (w.length > 2 && allowedLower.includes(w)) hits++;
    }
    if (hits >= 2) return 0.8;
  }
  return 0;
}
function jaroWinkler(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  if (m === 0 && n === 0) return 1;
  if (m === 0 || n === 0) return 0;
  const matchDist = Math.floor(Math.max(m, n) / 2) - 1;
  const s1Matches = Array(m).fill(false);
  const s2Matches = Array(n).fill(false);
  let matches = 0;
  for (let i = 0; i < m; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, n);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < m; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const jaro = (matches / m + matches / n + (matches - t / 2) / matches) / 3;
  let prefixLen = 0;
  const maxPrefix = Math.min(4, Math.min(m, n));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }
  return jaro + prefixLen * 0.1 * (1 - jaro);
}
function getResultImdbId(result) {
  if (!result) return null;
  if (result.Imdb) return normalizeImdbId(result.Imdb);
  if (result.Description) {
    const m = result.Description.match(/tt\d{7,}/i);
    return m ? normalizeImdbId(m[0]) : null;
  }
  return null;
}
function normalizeImdbId(id) {
  if (!id) return null;
  const cleaned = String(id).trim().replace(/^imdb:?/i, "");
  return /^tt\d{7,}$/.test(cleaned) ? cleaned.toLowerCase() : null;
}
function score(result, weights, isAnime, priorityLang) {
  const title = result.Title || "";
  const res = extractResolution(title);
  const qual = extractQuality(title);
  const codec = extractCodec(title);
  const langs = getLangs(title, isAnime);
  const seeders = result.Seeders || 0;
  const size = parseSize(result.Size || "");
  let total = 0;
  total += (res ? res.score * weights.resolution : 0);
  total += (qual ? qual.score * weights.resolution : 0);
  total += (codec ? codec.score * weights.codec : 0);
  total += Math.min(seeders, 1000) / 1000 * weights.seeders;
  const idealSize = 4e9;
  const sizeScore = size > 0 ? Math.max(0, 1 - Math.abs(size - idealSize) / idealSize) : 0;
  total += sizeScore * weights.size;
  if (priorityLang) {
    const hasPriority = langs.some(l => l.code === priorityLang);
    if (hasPriority) {
      total += 1000 * (weights.language / 10);
    }
  }
  return total;
}
function formatStream(result, indexer, isAnime, prefs) {
  const title = result.Title || "Torrent";
  const res = extractResolution(title);
  const qual = extractQuality(title);
  const codec = extractCodec(title);
  const audio = extractAudio(title);
  const visual = extractVisual(title);
  const langs = getLangs(title, isAnime);
  const seeders = result.Seeders || 0;
  const size = result.Size || "";
  let name = "";
  if (res) name += `${res.emoji} `;
  if (qual) name += `${qual.emoji} `;
  name += langs.map(l => l.label).join(" ");
  const tags = [];
  if (codec) tags.push(codec.label);
  if (audio.length) tags.push(audio.map(a => a.label).join(" "));
  if (visual.length) tags.push(visual.map(v => v.label).join(" "));
  tags.push(`👥 ${seeders}`);
  tags.push(`💾 ${size}`);
  tags.push(`📡 ${indexer}`);
  const description = tags.join(" • ");
  return { name, description };
}
// ─────────────────────────────────────────────────────────
// METADATA (CINEMETA + KITSU)
// ─────────────────────────────────────────────────────────
async function fetchCinemeta(type, id) {
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
    const response = await axios.get(url, { timeout: 10000 });
    return response.data?.meta || null;
  } catch {
    return null;
  }
}
async function fetchKitsu(kitsuId) {
  try {
    const url = `https://anime-kitsu.strem.fun/meta/series/kitsu:${kitsuId}.json`;
    const response = await axios.get(url, { timeout: 10000 });
    return response.data?.meta || null;
  } catch {
    return null;
  }
}
async function buildQueries(type, id) {
  let parsed = { type, metaId: id, isAnime: false, season: null, episode: null };
  let displayTitle = "";
  let aliases = [];
  let queries = [];
  let search = {};
  let episode = null;
  const isKitsu = id.startsWith("kitsu:");
  if (isKitsu) {
    const kitsuId = id.replace(/^kitsu:/, "");
    const meta = await fetchKitsu(kitsuId);
    if (meta) {
      displayTitle = meta.name || "";
      aliases = meta.aliases || [];
      parsed.isAnime = true;
    }
  } else {
    const idMatch = id.match(/^(tt\d+):?(\d+)?:?(\d+)?$/);
    if (idMatch) {
      const [, imdbId, seasonStr, episodeStr] = idMatch;
      const meta = await fetchCinemeta(type, imdbId);
      if (meta) {
        displayTitle = meta.name || "";
        aliases = meta.aliases || [];
        if (type === "series" && seasonStr && episodeStr) {
          parsed.season = parseInt(seasonStr, 10);
          parsed.episode = parseInt(episodeStr, 10);
          if (meta.videos) {
            const vid = meta.videos.find(v =>
              v.season === parsed.season && v.episode === parsed.episode
            );
            if (vid) displayTitle = `${meta.name} ${vid.name || ""}`.trim();
          }
        }
        search = { imdbId, title: meta.name, year: meta.year };
      }
    } else {
      const parts = id.split(":");
      if (parts.length >= 2) {
        displayTitle = decodeURIComponent(parts[0]);
        if (type === "series" && parts.length >= 3) {
          parsed.season = parseInt(parts[1], 10);
          parsed.episode = parseInt(parts[2], 10);
          episode = parsed.episode;
        } else if (type === "series") {
          episode = parseInt(parts[1], 10);
        }
        search = { title: displayTitle };
      }
    }
  }
  if (isKitsu && type === "series") {
    const parts = id.split(":");
    if (parts.length >= 3) {
      episode = parseInt(parts[2], 10);
    }
  }
  const baseTitles = [displayTitle, ...aliases].filter(Boolean);
  queries = baseTitles.map(t => ({ q: t }));
  return { parsed, displayTitle, aliases, queries, episode, search };
}
// ─────────────────────────────────────────────────────────
// JACKETT
// ─────────────────────────────────────────────────────────
async function jackettFetchIndexers() {
  try {
    const url = `${ENV.jackettUrl}/api/v2.0/indexers?configured=true`;
    const response = await axios.get(url, { timeout: 10000 });
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error(`Erro ao buscar indexers do Jackett: ${err.message}`);
    return [];
  }
}
async function jackettSearch(opts, indexers, prefs) {
  const { parsed, queries, search } = opts;
  const allResults = [];
  const fastIndexers = [];
  const slowIndexers = [];
  for (const indexerId of indexers) {
    const limited = await isRateLimited(indexerId);
    if (limited) continue;
    const indexer = (await getCachedIndexers()).find(ix => ix.id === indexerId);
    if (!indexer) continue;
    const avgTime = indexer.avgResponseTime || 0;
    if (avgTime > prefs.slowThreshold) {
      slowIndexers.push(indexerId);
    } else {
      fastIndexers.push(indexerId);
    }
  }
  async function searchIndexer(indexerId) {
    for (const q of queries) {
      const cacheKey = `${CACHE_VERSION}:${indexerId}:${normalizeTitle(q.q)}`;
      const cached = await rc.get(cacheKey);
      if (cached) {
        try {
          const data = JSON.parse(cached);
          if (Array.isArray(data)) {
            allResults.push(...data);
            continue;
          }
        } catch {}
      }
      try {
        const params = {
          apikey: ENV.apiKey,
          t: "search",
          q: q.q,
          cat: parsed.isAnime ? "5070" : (parsed.type === "movie" ? "2000" : "5000"),
        };
        if (search?.imdbId) params.imdbid = search.imdbId;
        const url = `${ENV.jackettUrl}/api/v2.0/indexers/${indexerId}/results/torznab`;
        const response = await axios.get(url, { params, timeout: 15000 });
        const xml = response.data;
        const itemRe = /<item>([\s\S]*?)<\/item>/g;
        const items = [...xml.matchAll(itemRe)];
        const results = items.map(m => {
          const item = m[1];
          const getTag = (tag) => {
            const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);
            const match = item.match(re);
            return match ? match[1] : "";
          };
          const getAttr = (tag, attr) => {
            const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/?>`);
            const match = item.match(re);
            return match ? match[1] : "";
          };
          return {
            Title: getTag("title"),
            Link: getTag("link") || getTag("guid"),
            Size: getAttr("torznab:attr", "value"),
            Seeders: parseInt(getAttr("torznab:attr", "value") || "0", 10),
            Tracker: indexerId,
            InfoHash: null,
            MagnetUri: null,
          };
        }).filter(r => r.Title);
        if (results.length > 0) {
          await rc.set(cacheKey, JSON.stringify(results), 3600);
        }
        allResults.push(...results);
      } catch (err) {
        if (err.response?.status === 429) {
          await setRateLimit(indexerId, err.response.headers["retry-after"]);
        }
      }
    }
  }
  await Promise.all(fastIndexers.map(searchIndexer));
  if (slowIndexers.length > 0) {
    await Promise.all(slowIndexers.map(searchIndexer));
  }
  return allResults;
}
// ─────────────────────────────────────────────────────────
// INFOHASH & FILES
// ─────────────────────────────────────────────────────────
async function resolveInfoHash(result) {
  if (result.InfoHash) {
    return { infoHash: result.InfoHash.toUpperCase(), files: [] };
  }
  if (result.MagnetUri) {
    const m = result.MagnetUri.match(/xturn:btih:([a-f0-9]{40})/i);
    if (m) {
      return { infoHash: m[1].toUpperCase(), files: [] };
    }
  }
  if (result.Link) {
    try {
      const response = await axios.get(result.Link, {
        responseType: "arraybuffer",
        timeout: 10000,
        maxRedirects: 5,
      });
      const buffer = Buffer.from(response.data);
      if (buffer[0] === 0x64) {
        const hash = crypto.createHash("sha1")
          .update(buffer.slice(buffer.indexOf(Buffer.from("6:pieces")) + 8))
          .digest("hex");
        return { infoHash: hash.toUpperCase(), files: [] };
      }
      const magMatch = buffer.toString("utf8").match(/magnet:\?xt=urn:btih:([a-f0-9]{40})/i);
      if (magMatch) {
        return { infoHash: magMatch[1].toUpperCase(), files: [] };
      }
    } catch {}
  }
  return null;
}
function pickEpisodeFile(files, season, episode, isAnime) {
  if (!files || files.length === 0) return null;
  const videoFiles = files.filter(f =>
    /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i.test(f.name || "")
  );
  if (videoFiles.length === 0) return files[0];
  if (isAnime && episode) {
    const ep = String(episode).padStart(2, '0');
    const match = videoFiles.find(f => {
      const name = (f.name || "").toLowerCase();
      return new RegExp(`\\b${episode}\\b`).test(name) || new RegExp(`\\b${ep}\\b`).test(name);
    });
    if (match) return match;
  }
  if (season && episode) {
    const match = videoFiles.find(f => {
      const info = extractSeasonEpisode(f.name || "");
      return info && info.season === season && info.episode === episode;
    });
    if (match) return match;
  }
  videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
  return videoFiles[0];
}
// ─────────────────────────────────────────────────────────
// MANIFEST
// ─────────────────────────────────────────────────────────
app.get("/manifest.json", (_, res) => {
  res.json({
    id: "prowjack.pro.debrid",
    version: "3.8.0",
    name: "ProwJack PRO (Debrid)",
    description: "Jackett/Prowlarr + TorBox/Real-Debrid integration",
    catalogs: [],
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt", "kitsu"],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  });
});
app.get("/:userCfg?/configure", (req, res) => {
  const filePath = path.join(__dirname, "configure.html");
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Configure page not found");
  }
});
// ─────────────────────────────────────────────────────────
// STREAM
// ─────────────────────────────────────────────────────────
app.get("/:userCfg?/stream/:type/:id.json", async (req, res) => {
  const { userCfg, type, id } = req.params;
  const prefs = resolvePrefs(userCfg);
  console.log(`\n=========================================`);
  console.log(`ProwJack PRO v3.8.0 - DEBRID MODE`);
  console.log(`Request: ${type} | ${id}`);
  console.log(`Debrid: ${prefs.debrid ? 'ON' : 'OFF'} | Service: ${prefs.debridService || 'none'}`);
  console.log(`=========================================`);
  // Validação de configuração debrid
  if (prefs.debrid && (!prefs.debridService || !prefs.debridApiKey)) {
    console.log(`[ERRO] Modo debrid ativado mas sem API key configurada`);
    console.log(`=========================================\n`);
    return res.json({ streams: [] });
  }
  // Criar provider debrid se configurado
  let debridProvider = null;
  if (prefs.debrid && prefs.debridService && prefs.debridApiKey) {
    debridProvider = createDebridProvider(prefs.debridService, prefs.debridApiKey);
    if (!debridProvider) {
      console.log(`[ERRO] Serviço debrid inválido: ${prefs.debridService}`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
  }
  // Verificação de categorias
  const enabledCats = Array.isArray(prefs.categories) && prefs.categories.length
    ? prefs.categories
    : ["movie", "series", "anime"];
  try {
    const { parsed, displayTitle, aliases = [], queries, episode, search } = await buildQueries(type, id);
    const requestedImdbId = normalizeImdbId(search?.imdbId || parsed?.metaId);
    if (parsed.isAnime && !enabledCats.includes("anime")) {
      console.log(`[Categoria] Anime bloqueado pelas preferencias do usuario`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
    if (!parsed.isAnime && type === "series" && !enabledCats.includes("series")) {
      console.log(`[Categoria] Serie bloqueada pelas preferencias do usuario`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
    if (type === "movie" && !enabledCats.includes("movie")) {
      console.log(`[Categoria] Filme bloqueado pelas preferencias do usuario`);
      console.log(`=========================================\n`);
      return res.json({ streams: [] });
    }
    const indexers = await resolveSearchIndexers(prefs, parsed.isAnime);
    const results  = await jackettSearch({ parsed, queries, search }, indexers, prefs);
    console.log(`Encontrados ${results.length} resultados de indexers`);
    const priorityLang = prefs.priorityLang ?? "pt-br";
    let rejectedBySeriesFilter = 0;
    let rejectedByTitleMatch   = 0;
    let rejectedByYear         = 0;
    let rejectedByMovieShape   = 0;
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
        const score = titleMatchScore(r.Title || "", [displayTitle, ...aliases]);
        const relaxedScore = relaxedTitleMatchScore(r.Title || "", [displayTitle, ...aliases]);
        const episodeRank = parsed.isAnime
          ? animeEpisodeMatchRank(r.Title || "", episode)
          : episodeMatchRank(r.Title || "", parsed.season, parsed.episode);
        const minScore = parsed.isAnime ? 0.34 : (type === "series" && episodeRank >= 2 ? 0.2 : 0.45);
        const finalScore = Math.max(score, type === "series" ? relaxedScore * 0.8 : 0);
        const ok = finalScore >= minScore;
        if (!ok) rejectedByTitleMatch++;
        r._titleMatchScore = finalScore;
        return ok;
      })
      .filter(r => {
        if (type !== "movie" || !search?.year) return true;
        const releaseYear = extractReleaseYear(r.Title || "");
        if (!releaseYear) return true;
        const ok = releaseYear === search.year;
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
      console.log(`Filtro de Serie: ${rejectedBySeriesFilter} resultados descartados.`);
    if (rejectedByTitleMatch > 0)
      console.log(`Filtro de Titulo: ${rejectedByTitleMatch} resultados descartados.`);
    if (rejectedByYear > 0)
      console.log(`Filtro de Ano: ${rejectedByYear} resultados descartados.`);
    if (rejectedByMovieShape > 0)
      console.log(`Filtro de Filme: ${rejectedByMovieShape} resultados episodicos descartados.`);
    const langLabel = priorityLang
      ? `Idioma prioritário: ${priorityLang.toUpperCase()}`
      : `Sem preferência de idioma`;
    console.log(`${langLabel} | onlyDubbed: ${prefs.onlyDubbed}`);
    // ═══════════════════════════════════════════════════════
    // MODO DEBRID - PROCESSAMENTO
    // ═══════════════════════════════════════════════════════
    if (debridProvider) {
      console.log(`\n[DEBRID] Processando com ${prefs.debridService.toUpperCase()}`);
      const resolvedAll = await Promise.all(
        candidates.map(async r => {
          const resolved = await resolveInfoHash(r);
          if (!resolved?.infoHash) return null;
          return { ...r, _infoHash: resolved.infoHash };
        })
      );
      const validCandidates = resolvedAll.filter(Boolean).slice(0, prefs.maxResults * 2);
      console.log(`[DEBRID] Verificando cache de ${validCandidates.length} torrents`);
      // Verificar cache em lotes
      const batchSize = 100;
      const cachedMap = {};
      for (let i = 0; i < validCandidates.length; i += batchSize) {
        const batch = validCandidates.slice(i, i + batchSize);
        const hashes = batch.map(c => c._infoHash);
        const cacheResult = await debridProvider.checkCached(hashes);
        Object.assign(cachedMap, cacheResult);
      }
      const finalStreams = [];
      for (const candidate of validCandidates) {
        if (finalStreams.length >= prefs.maxResults) break;
        const hash = candidate._infoHash;
        const cached = cachedMap[hash.toLowerCase()] || cachedMap[hash.toUpperCase()];
        const indexerName = candidate.Tracker || candidate.TrackerId || "Unknown";
        const { name, description } = formatStream(candidate, indexerName, parsed.isAnime, prefs);
        // Se está em cache - retornar link direto
        if (cached && Object.keys(cached).length > 0) {
          console.log(`[DEBRID] ✓ Cache HIT: ${candidate.Title.substring(0, 60)}`);
          
          // Para TorBox
          if (prefs.debridService === "torbox" && cached.files) {
            const matchedFile = (type === "series" || parsed.isAnime)
              ? pickEpisodeFile(
                  cached.files.map((f, idx) => ({ idx, name: f.name, size: f.size })),
                  parsed.season,
                  parsed.episode ?? episode,
                  parsed.isAnime
                )
              : null;
            
            finalStreams.push({
              name: `⚡ ${name}`,
              description: `${description}\n💾 Cached - Instantâneo`,
              url: matchedFile 
                ? `${prefs.debridService}://cached/${hash}/${matchedFile.idx}`
                : `${prefs.debridService}://cached/${hash}`,
              behaviorHints: {
                bingeGroup: parsed.isAnime
                  ? `prowjack-debrid|anime|${displayTitle}`
                  : `prowjack-debrid|${hash}`,
              },
            });
            continue;
          }
          
          // Para Real-Debrid
          if (prefs.debridService === "realdebrid") {
            const rdVariants = Object.values(cached);
            if (rdVariants.length > 0 && Array.isArray(rdVariants[0])) {
              const firstVariant = rdVariants[0][0];
              if (firstVariant) {
                const fileIds = Object.keys(firstVariant).map(k => parseInt(k, 10));
                finalStreams.push({
                  name: `⚡ ${name}`,
                  description: `${description}\n💾 Cached - Instantâneo`,
                  url: `${prefs.debridService}://cached/${hash}/${fileIds.join(",")}`,
                  behaviorHints: {
                    bingeGroup: parsed.isAnime
                      ? `prowjack-debrid|anime|${displayTitle}`
                      : `prowjack-debrid|${hash}`,
                  },
                });
                continue;
              }
            }
          }
        }
        // Se NÃO está em cache - adicionar ao debrid
        console.log(`[DEBRID] ✗ Cache MISS: ${candidate.Title.substring(0, 60)}`);
        const magnet = candidate.MagnetUri || `magnet:?xt=urn:btih:${hash}`;
        const torrentId = await debridProvider.addTorrent(magnet);
        
        if (torrentId) {
          console.log(`[DEBRID] ✓ Adicionado ao debrid: ID ${torrentId}`);
          
          finalStreams.push({
            name: `⏳ ${name}`,
            description: `${description}\n⏬ Adicionado ao debrid - aguarde download`,
            url: `${prefs.debridService}://download/${torrentId}/${hash}`,
            behaviorHints: {
              bingeGroup: parsed.isAnime
                ? `prowjack-debrid|anime|${displayTitle}`
                : `prowjack-debrid|${hash}`,
            },
          });
        } else {
          console.log(`[DEBRID] ✗ Falha ao adicionar: ${candidate.Title.substring(0, 60)}`);
        }
      }
      console.log(`[DEBRID] Retornando ${finalStreams.length} streams debrid`);
      console.log(`=========================================\n`);
      return res.json({ streams: finalStreams });
    }
    // ═══════════════════════════════════════════════════════
    // MODO P2P - PROCESSAMENTO PADRÃO
    // ═══════════════════════════════════════════════════════
    console.log(`\n[P2P] Extraindo InfoHash de ${candidates.length} links promissores...`);
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
        const indexerName            = r.Tracker || r.TrackerId || "Unknown";
        const { name, description }  = formatStream(r, indexerName, parsed.isAnime, prefs);
        const sources                = r.MagnetUri ? [r.MagnetUri] : [];
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
    console.log(`[P2P] Magnets prontos: Enviando ${finalStreams.length} torrents!`);
    console.log(`=========================================\n`);
    res.json({ streams: finalStreams });
  } catch (err) {
    console.log(`Erro no processamento: ${err.message}`);
    res.json({ streams: [] });
  }
});
app.listen(ENV.port, () => {
  console.log(`ProwJack PRO v3.8.0 (Debrid) -> http://localhost:${ENV.port}/configure`);
  console.log(`   Jackett : ${ENV.jackettUrl}`);
  console.log(`   Redis   : ${ENV.redisUrl}`);
});
