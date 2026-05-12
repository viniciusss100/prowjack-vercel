"use strict";

const axios = require("axios");

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/original";
const tmdbCache = new Map();

function normalizeImdbId(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  const m = s.match(/tt\d+/i);
  if (m) return m[0].toLowerCase();
  return /^\d+$/.test(s) ? `tt${s}` : s.toLowerCase();
}

function tmdbHeaders() {
  const bearer = (process.env.TMDB_BEARER_TOKEN || "").trim();
  return bearer ? { Authorization: `Bearer ${bearer}` } : {};
}

function tmdbParams(extra = {}) {
  const apiKey = (process.env.TMDB_API_KEY || "").trim();
  return apiKey ? { api_key: apiKey, ...extra } : extra;
}

function hasTmdbAuth() {
  return !!((process.env.TMDB_API_KEY || "").trim() || (process.env.TMDB_BEARER_TOKEN || "").trim());
}

async function tmdbGet(url, params) {
  const res = await axios.get(url, {
    params: tmdbParams(params),
    headers: tmdbHeaders(),
    timeout: 5000,
    validateStatus: s => s < 500,
  });
  if (res.status >= 400) return null;
  return res.data || null;
}

function yearFromDate(value) {
  const m = String(value || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

function mapTmdbMeta(detail, type) {
  if (!detail) return null;
  const title = type === "movie"
    ? (detail.title || detail.original_title)
    : (detail.name || detail.original_name);
  const released = type === "movie" ? detail.release_date : detail.first_air_date;
  return {
    name: title || null,
    poster: detail.poster_path ? `${TMDB_IMAGE_BASE}${detail.poster_path}` : null,
    background: detail.backdrop_path ? `${TMDB_IMAGE_BASE}${detail.backdrop_path}` : null,
    description: detail.overview || null,
    releaseInfo: yearFromDate(released),
    imdbRating: detail.vote_average ? String(Math.round(detail.vote_average * 10) / 10) : null,
    genres: Array.isArray(detail.genres) ? detail.genres.map(g => g.name).filter(Boolean) : null,
  };
}

async function fetchTmdbPtBrByImdb(imdbId, type) {
  if (!hasTmdbAuth()) return null;
  const cleanId = normalizeImdbId(imdbId);
  if (!cleanId || !/^tt\d+$/i.test(cleanId)) return null;
  const stremioType = type === "movie" ? "movie" : "series";
  const cacheKey = `${stremioType}:${cleanId}`;
  if (tmdbCache.has(cacheKey)) return tmdbCache.get(cacheKey);

  try {
    const find = await tmdbGet(`https://api.themoviedb.org/3/find/${cleanId}`, {
      external_source: "imdb_id",
      language: "pt-BR",
    });
    const list = stremioType === "movie" ? find?.movie_results : find?.tv_results;
    const tmdbId = Array.isArray(list) && list[0]?.id ? list[0].id : null;
    if (!tmdbId) {
      tmdbCache.set(cacheKey, null);
      return null;
    }
    const detailType = stremioType === "movie" ? "movie" : "tv";
    const detail = await tmdbGet(`https://api.themoviedb.org/3/${detailType}/${tmdbId}`, {
      language: "pt-BR",
    });
    const meta = mapTmdbMeta(detail, stremioType);
    tmdbCache.set(cacheKey, meta);
    return meta;
  } catch {
    tmdbCache.set(cacheKey, null);
    return null;
  }
}

async function enrichMetaPtBr(meta, imdbId, type) {
  if (!meta) return meta;
  const tmdb = await fetchTmdbPtBrByImdb(imdbId || meta.imdb_id || meta.id, type);
  if (!tmdb) return meta;
  return {
    ...meta,
    name: tmdb.name || meta.name,
    poster: tmdb.poster || meta.poster,
    background: tmdb.background || meta.background,
    description: tmdb.description || meta.description,
    releaseInfo: tmdb.releaseInfo || meta.releaseInfo,
    imdbRating: tmdb.imdbRating || meta.imdbRating,
    genres: tmdb.genres || meta.genres,
  };
}

module.exports = {
  enrichMetaPtBr,
  fetchTmdbPtBrByImdb,
};
