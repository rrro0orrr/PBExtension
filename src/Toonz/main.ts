import {
  AdvancedSearchForm,
  BasicRateLimiter,
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareError,
  CloudflareBypassRequestProviding,
  ContentRating,
  Cookie,
  CookieStorageInterceptor,
  DiscoverSection,
  DiscoverSectionItem,
  DiscoverSectionProviding,
  DiscoverSectionType,
  Extension,
  Form,
  MangaProviding,
  Metadata,
  PagedResults,
  Request,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SettingsFormProviding,
  SortingOption,
  SourceManga,
  Tag,
  URL,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";

import {
  hideYaoi,
  ToonzSearchForm,
  ToonzSettingsForm,
  YAOI_GENRES,
  type ToonzSearchMetadata,
} from "./forms";
import { DOMAIN, isToonzUrl, ToonzInterceptor } from "./interceptors";

// Built with Keiyoushi's Toonz extension (keiyoushi/extensions-source,
// src/en/toonz) as the reference for the site's endpoints and markup.
//
// Manga ids are "<type>/<slug>" (e.g. "manga/welcome-to-another-world-now-then-please-die"),
// matching the site's own paths. Chapter ids are the chapter path segment ("1", "10-5").

const GENRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MANGA_TYPES = ["manhwa", "manhua", "manga", "western"];

const SORT_OPTIONS: SortingOption[] = [
  { id: "popular", label: "Popular" },
  { id: "latest", label: "Latest Updates" },
];

const SECTIONS: Record<string, { title: string; sort: string; type: DiscoverSectionType }> = {
  popular: { title: "Popular", sort: "popular", type: DiscoverSectionType.prominentCarousel },
  latest: { title: "Latest Updates", sort: "latest", type: DiscoverSectionType.simpleCarousel },
};

const ADULT_GENRES = ["adult", "smut", "hentai", "erotica", "pornographic", "18+"];
const MATURE_GENRES = ["mature", "ecchi"];

interface ComicCard {
  id: string;
  title: string;
  cover: string;
  nsfw: boolean;
  yaoi: boolean;
}

interface ApiChapter {
  id?: number;
  chapterNumber: string;
  title?: string | null;
  slug: string;
  date?: string | null;
}

interface ApiGenre {
  name: string;
  slug: string;
}

type PageMetadata = { page?: number };
// Pages to read ahead when hiding yaoi leaves a listing page empty
const MAX_EMPTY_PAGE_SKIPS = 3;

type ToonzImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding &
  SettingsFormProviding;

export class ToonzExtension implements ToonzImplementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({ storage: "stateManager" });
  requestManager = new ToonzInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 2,
    bufferInterval: 1,
    ignoreImages: true,
  });

  private genreCache: { genres: Tag[]; fetchedAt: number } | undefined;
  // comicId (needed for the chapter API) by manga id, filled from the details page
  private comicIds = new Map<string, string>();

  async initialise(): Promise<void> {
    this.cookieStorageInterceptor.registerInterceptor();
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
  }

  // ----- Settings -----

  async getSettingsForm(): Promise<Form> {
    return new ToonzSettingsForm();
  }

  // ----- Discover -----

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      ...Object.entries(SECTIONS).map(([id, s]) => ({ id, title: s.title, type: s.type })),
      { id: "genres", title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === "genres") {
      const genres = await this.getVisibleGenres().catch(() => [] as Tag[]);
      return {
        items: genres.map((genre) => ({
          type: "genresCarouselItem",
          name: genre.title,
          searchQuery: { title: "", metadata: { searchMeta: { genre: genre.id } } },
          contentRating: contentRatingFor([genre.title]),
        })),
      };
    }

    const def = SECTIONS[section.id];
    if (!def) return { items: [] };

    const page = metadata?.page ?? 1;
    const { cards, nextPage } = await this.fetchListing(
      (p) => listingUrl("comics", def.sort, p),
      page,
    );

    return {
      items: cards.map((card): DiscoverSectionItem =>
        def.type === DiscoverSectionType.prominentCarousel
          ? {
              type: "prominentCarouselItem",
              mangaId: card.id,
              imageUrl: card.cover,
              title: card.title,
              contentRating: card.nsfw ? ContentRating.ADULT : undefined,
            }
          : {
              type: "simpleCarouselItem",
              mangaId: card.id,
              imageUrl: card.cover,
              title: card.title,
              contentRating: card.nsfw ? ContentRating.ADULT : undefined,
            },
      ),
      metadata: nextPage ? { page: nextPage } : undefined,
    };
  }

  // ----- Search -----

  async getSortingOptions(_query: SearchQuery<Metadata>): Promise<SortingOption[]> {
    return SORT_OPTIONS;
  }

  async getAdvancedSearchForm(query: SearchQuery<Metadata>): Promise<AdvancedSearchForm> {
    const genres = await this.getVisibleGenres().catch(() => [] as Tag[]);
    return new ToonzSearchForm(genres, searchMetaOf(query));
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: PageMetadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const title = (query.title ?? "").trim();

    // A pasted toonz.to link opens that title directly
    const pastedId = mangaIdFromUrl(title);
    if (pastedId) {
      const manga = await this.getMangaDetails(pastedId);
      return {
        items: [
          {
            mangaId: pastedId,
            title: manga.mangaInfo.primaryTitle,
            imageUrl: manga.mangaInfo.thumbnailUrl,
            contentRating: manga.mangaInfo.contentRating,
          },
        ],
      };
    }

    let url: (page: number) => string;
    if (title) {
      url = (p) =>
        new URL(DOMAIN)
          .addPathComponent("search")
          .setQueryItem("q", title)
          .setQueryItem("page", String(p))
          .toString();
    } else {
      const sort = sortingOption?.id ?? "popular";
      const genre = searchMetaOf(query).genre;
      // Every title in these genres would be hidden anyway
      if (genre && hideYaoi() && YAOI_GENRES.includes(genre)) return { items: [] };
      url = (p) => (genre ? listingUrl(`genre/${genre}`, sort, p) : listingUrl("comics", sort, p));
    }

    const { cards, nextPage } = await this.fetchListing(url, page);
    return {
      items: cards.map((card) => ({
        mangaId: card.id,
        imageUrl: card.cover,
        title: card.title,
        contentRating: card.nsfw ? ContentRating.ADULT : undefined,
      })),
      metadata: nextPage ? { page: nextPage } : undefined,
    };
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const id = normaliseMangaId(mangaId);
    const html = await this.fetchText(`${DOMAIN}/${id}`);
    const $ = loadStreamed(html);

    const title = clean($("h1").first().text()) || id.split("/")[1];

    const comicId = findComicId(html, title);
    if (comicId) this.comicIds.set(id, comicId);
    else this.comicIds.delete(id);
    const cover = absoluteUrl(
      $("img[data-cover]").first().attr("src") ||
        $("div.group img[src]").first().attr("src") ||
        $('meta[property="og:image"]').attr("content") ||
        "",
    );
    const synopsis =
      clean($("div.prose").first().text()) || clean($('meta[name="description"]').attr("content"));
    const authors = uniq(
      $('a[href^="/author/"]')
        .toArray()
        .map((el) => clean($(el).text())),
    );
    const author = authors.join(", ");

    const genres: Tag[] = [];
    const seen = new Set<string>();
    $('a[href^="/genre/"]').each((_, el) => {
      const slug = ($(el).attr("href") ?? "").replace(/^\/genre\//, "").replace(/[?#].*$/, "");
      const name = clean($(el).text());
      if (!slug || !name || seen.has(slug)) return;
      seen.add(slug);
      genres.push({ id: slug, title: name });
    });

    const statusText =
      clean(
        $("dt")
          .filter((_, el) => /status/i.test($(el).text()))
          .first()
          .next("dd")
          .text(),
      ) || clean($("span[data-slot=badge]").has("svg.lucide-clock").first().text());

    const nsfw = $("img[data-cover][data-nsfw]").length > 0;
    let contentRating = contentRatingFor(genres.map((g) => g.title));
    if (nsfw) contentRating = ContentRating.ADULT;

    return {
      mangaId: id,
      mangaInfo: {
        primaryTitle: title,
        secondaryTitles: [],
        thumbnailUrl: cover,
        synopsis,
        ...(author ? { author, artist: author } : {}),
        status: mapStatus(statusText),
        contentRating,
        tagGroups: genres.length ? [{ id: "genres", title: "Genres", tags: genres }] : [],
        shareUrl: `${DOMAIN}/${id}`,
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const id = normaliseMangaId(sourceManga.mangaId);
    let comicId = this.comicIds.get(id);
    if (!comicId) {
      await this.getMangaDetails(id);
      comicId = this.comicIds.get(id);
    }
    if (!comicId) throw new Error(`Toonz: could not find the comic id for ${id}`);

    const data = await this.fetchJson<{ chapters?: ApiChapter[] }>(
      `${DOMAIN}/api/comics/${comicId}/chapters`,
    );
    const list = data.chapters ?? [];
    const chapters: Chapter[] = [];
    const seenIds = new Set<string>();
    list.forEach((ch, index) => {
      const chapterId = ch.slug.replace(/^chapter-/, "");
      if (!chapterId || seenIds.has(chapterId)) return;
      seenIds.add(chapterId);

      const number = parseFloat(ch.chapterNumber);
      const cleanTitle = (ch.title ?? "").trim();
      const date = ch.date ? new Date(ch.date) : undefined;
      chapters.push({
        chapterId,
        sourceManga,
        chapNum: Number.isFinite(number) ? number : list.length - index,
        ...(cleanTitle && !/^(chapter|ch\.)\s*[\d.]+$/i.test(cleanTitle)
          ? { title: cleanTitle }
          : {}),
        volume: 0,
        // The API lists newest first
        sortingIndex: list.length - index,
        langCode: "🇬🇧",
        ...(date && !Number.isNaN(date.getTime()) ? { publishDate: date } : {}),
      });
    });

    if (!chapters.length) throw new Error(`Toonz: no chapters found for ${id}`);
    return chapters;
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const id = normaliseMangaId(chapter.sourceManga.mangaId);
    const url = `${DOMAIN}/${id}/chapter/${chapter.chapterId}`;

    // The React Server Components payload carries the chapter's image list as JSON
    const streamed = await this.fetchText(url, { rsc: "1" }).catch((error: unknown) => {
      if (error instanceof CloudflareError) throw error;
      return "";
    });
    let pages = parseImages(streamed);
    if (!pages.length) pages = parseImages(await this.fetchText(url));
    if (!pages.length) throw new Error(`Toonz: no pages found for ${url}`);

    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }

  // ----- Cloudflare -----

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    for (const cookie of this.cookieStorageInterceptor.cookies) {
      this.cookieStorageInterceptor.deleteCookie(cookie);
    }
    for (const cookie of cookies) {
      if (cookie.expires && cookie.expires.getTime() <= Date.now()) continue;
      this.cookieStorageInterceptor.setCookie(cookie);
    }
  }

  // ----- Helpers -----

  /**
   * Reads one listing page, dropping yaoi-flagged cards when that setting is
   * on. If that empties the page, reads ahead (a few pages at most) so the
   * results don't look like they ended. `nextPage` is the page to load next.
   */
  private async fetchListing(
    url: (page: number) => string,
    page: number,
  ): Promise<{ cards: ComicCard[]; nextPage?: number }> {
    const hide = hideYaoi();
    let current = page;
    for (let skips = 0; ; skips++) {
      const listing = url(current);
      const $ = loadStreamed(await this.fetchText(listing));
      const cards = parseCards($).filter((card) => !(hide && card.yaoi));
      const hasNext = hasListingPage($, listing, current + 1);
      if (cards.length || !hasNext || skips >= MAX_EMPTY_PAGE_SKIPS) {
        return { cards, nextPage: hasNext ? current + 1 : undefined };
      }
      current++;
    }
  }

  private async getVisibleGenres(): Promise<Tag[]> {
    const genres = await this.getGenres();
    return hideYaoi() ? genres.filter((g) => !YAOI_GENRES.includes(g.id)) : genres;
  }

  private async getGenres(): Promise<Tag[]> {
    if (this.genreCache && Date.now() - this.genreCache.fetchedAt < GENRE_CACHE_TTL_MS) {
      return this.genreCache.genres;
    }
    const data = await this.fetchJson<ApiGenre[]>(`${DOMAIN}/api/genres`);
    const genres = (Array.isArray(data) ? data : [])
      .filter((g) => g?.slug && g?.name)
      .map((g) => ({ id: g.slug, title: g.name }));
    if (genres.length) this.genreCache = { genres, fetchedAt: Date.now() };
    return genres;
  }

  private async fetchText(url: string, headers?: Record<string, string>): Promise<string> {
    const [response, data] = await Application.scheduleRequest({
      url,
      method: "GET",
      ...(headers ? { headers } : {}),
    } as Request);
    checkStatus(response.status, url);
    return Application.arrayBufferToUTF8String(data);
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const text = await this.fetchText(url, { accept: "application/json" });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Toonz: unexpected response from ${url}`);
    }
  }
}

// ----- Parsing -----

/**
 * Next.js streams late parts of a page as hidden `div[id^=S:]` chunks that
 * client JS moves into `<template id="P:...">` placeholders. Cheerio sees both,
 * so the cards are reachable either way; just load the document.
 */
function loadStreamed(html: string): CheerioAPI {
  return cheerio.load(html);
}

function hasListingPage($: CheerioAPI, listing: string, page: number): boolean {
  const current = new URL(listing);
  return $('a[href*="?"]')
    .toArray()
    .some((link) => {
      try {
        const target = new URL(listing).update($(link).attr("href") ?? "");
        return (
          isToonzUrl(target.toString()) &&
          target.path.replace(/\/$/, "") === current.path.replace(/\/$/, "") &&
          target.queryItems?.page === String(page) &&
          ["q", "sort"].every(
            (key) =>
              target.queryItems?.[key] === undefined ||
              target.queryItems[key] === current.queryItems?.[key],
          )
        );
      } catch {
        return false;
      }
    });
}

function parseCards($: CheerioAPI): ComicCard[] {
  const cards: ComicCard[] = [];
  const seen = new Set<string>();
  $("img[data-cover]").each((_, el) => {
    const img = $(el);
    let link = img.closest("a[href]");
    if (!link.length) {
      link = img
        .parents()
        .filter((_, p) => $(p).children("a[href]").length > 0)
        .first()
        .children("a[href]")
        .first();
    }
    const id = mangaIdFromPath(link.attr("href") ?? "");
    const title = clean(img.attr("alt"));
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    cards.push({
      id,
      title,
      cover: absoluteUrl(img.attr("src") ?? ""),
      nsfw: img.attr("data-nsfw") !== undefined,
      // The site flags yaoi / BL cards on the card wrapper
      yaoi: img.closest("[data-yaoi]").length > 0,
    });
  });
  return cards;
}

/**
 * The details page embeds `comicId` in its RSC data, but cards for related
 * titles on the same page carry their own `comicId`/`comicTitle` pairs.
 * Use an ID only when its title matches the details page.
 */
function findComicId(html: string, title: string): string | undefined {
  const body = html.replace(/\\"/g, '"');
  const wanted = title.toLowerCase();
  for (const m of body.matchAll(
    /"comicId"\s*:\s*(\d+)\s*,\s*"comicTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  )) {
    if (clean(m[2]).toLowerCase() === wanted) return m[1];
  }
  return undefined;
}

/** Finds `"images":[{"filename":...}]` in an RSC payload or (escaped) in page HTML. */
function parseImages(text: string): string[] {
  const candidates = [text];
  if (text.includes('\\"images\\"'))
    candidates.push(text.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));

  for (const body of candidates) {
    const start = body.search(/"images"\s*:\s*\[/);
    if (start < 0) continue;
    const open = body.indexOf("[", start);
    const close = matchingBracket(body, open);
    if (close < 0) continue;
    try {
      const images = JSON.parse(body.slice(open, close + 1)) as { filename?: string }[];
      const pages = images
        .map((img) => (img?.filename ?? "").replace(/^\/+/, ""))
        .filter(Boolean)
        .map((file) => (/^https?:\/\//i.test(file) ? file : `${DOMAIN}/uploads/${file}`));
      if (pages.length) return pages;
    } catch {
      // try the next candidate
    }
  }
  return [];
}

function matchingBracket(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ----- Utils -----

function listingUrl(path: string, sort: string, page: number): string {
  let url = new URL(DOMAIN);
  for (const part of path.split("/")) url = url.addPathComponent(part);
  return url.setQueryItem("sort", sort).setQueryItem("page", String(page)).toString();
}

/** "/manhua/slug" -> "manhwa/slug" (the site links manhua under manhwa paths). */
function mangaIdFromPath(path: string): string | undefined {
  const m = path.match(/^(?:https?:\/\/(?:www\.)?toonz\.to)?\/([a-z]+)\/([^/?#]+)\/?(?:[?#].*)?$/i);
  if (!m) return undefined;
  const type = m[1].toLowerCase();
  if (!MANGA_TYPES.includes(type) || m[2] === "browse") return undefined;
  return normaliseMangaId(`${type}/${m[2]}`);
}

function mangaIdFromUrl(text: string): string | undefined {
  const m = text.match(/^https?:\/\/(?:www\.)?toonz\.to(\/[a-z]+\/[^/?#]+)/i);
  return m ? mangaIdFromPath(m[1]) : undefined;
}

function normaliseMangaId(id: string): string {
  return id.replace(/^\/+/, "").replace(/^manhua\//, "manhwa/");
}

/** Genre from the search form / genre tiles (`searchMeta`), or the 1.0.0 `{ genre }` shape. */
function searchMetaOf(query: SearchQuery<Metadata>): ToonzSearchMetadata {
  const meta = query.metadata as { searchMeta?: ToonzSearchMetadata; genre?: string } | undefined;
  return meta?.searchMeta ?? (meta?.genre ? { genre: meta.genre } : {});
}

function checkStatus(status: number, url: string): void {
  if (status === 404) throw new Error(`Toonz: not found (${url})`);
  if (status === 429) throw new Error("Toonz: too many requests, please try again later");
  if (status < 200 || status >= 300) throw new Error(`Toonz: HTTP ${status} for ${url}`);
}

function contentRatingFor(genres: string[]): ContentRating {
  const lower = genres.map((g) => g.toLowerCase());
  if (lower.some((g) => ADULT_GENRES.includes(g))) return ContentRating.ADULT;
  if (lower.some((g) => MATURE_GENRES.includes(g))) return ContentRating.MATURE;
  return ContentRating.EVERYONE;
}

function mapStatus(status: string): string {
  const value = status.toLowerCase();
  if (value.includes("complet")) return "Completed";
  if (value.includes("ongoing")) return "Ongoing";
  if (value.includes("hiatus")) return "Hiatus";
  return "Unknown";
}

function absoluteUrl(url: string): string {
  const value = url.trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${DOMAIN}${value}`;
  return value;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clean(text: string | undefined | null): string {
  return Application.decodeHTMLEntities(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export const Toonz = new ToonzExtension();
