import {
  AdvancedSearchForm,
  BasicRateLimiter,
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  CloudflareError,
  ContentRating,
  Cookie,
  CookieStorageInterceptor,
  DiscoverSection,
  DiscoverSectionItem,
  DiscoverSectionProviding,
  DiscoverSectionType,
  Extension,
  MangaProviding,
  Metadata,
  PagedResults,
  Request,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SortingOption,
  SourceManga,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { LnoriSearchForm, type LnoriSearchMetadata } from "./forms/SearchForm";
import { LnoriInterceptor } from "./interceptors";

const baseUrl = "https://lnori.com";

const PAGE_SIZE = 30;
const LIBRARY_CACHE_TTL_MS = 30 * 60 * 1000;
const HOME_CACHE_TTL_MS = 10 * 60 * 1000;

const SORT_OPTIONS: SortingOption[] = [
  { id: "popular", label: "Popular" },
  { id: "title", label: "Title (A-Z)" },
  { id: "newest", label: "Newest Release Year" },
  { id: "oldest", label: "Oldest Release Year" },
  { id: "volumes", label: "Most Volumes" },
  { id: "added", label: "Recently Added" },
];

const ADULT_TAGS = ["adult", "smut", "ecchi", "hentai", "mature", "explicit"];

// Attributes kept when cleaning volume HTML; everything else (classes, inline
// styles with base64 placeholders, epub:type, data-*) is dropped so the
// reader gets small, valid XHTML.
const KEPT_ATTRIBUTES = new Set(["src", "alt", "id", "colspan", "rowspan"]);
const VOID_ELEMENTS = "area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr";
const VOID_ELEMENT_REGEX = new RegExp(`<(${VOID_ELEMENTS})((?:\\s+[^>]*?)?)\\s*/?>`, "gi");

interface LibraryEntry {
  id: string; // "{seriesId}/{slug}"
  numericId: number;
  title: string;
  author: string;
  year: number;
  volumes: number;
  tags: string[];
  popularity: number;
  cover: string;
}

interface SeriesJsonLd {
  name?: string;
  author?: { name?: string } | { name?: string }[];
  description?: string;
  genre?: string;
  image?: string;
  url?: string;
  hasPart?: { name?: string; position?: string | number; url?: string }[];
}

type PageMetadata = { offset?: number };

type LnoriImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class LnoriExtension implements LnoriImplementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });
  requestManager = new LnoriInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 1,
    ignoreImages: true,
  });

  private libraryCache: { entries: LibraryEntry[]; fetchedAt: number } | undefined;
  private homeCache: { $: CheerioAPI; fetchedAt: number } | undefined;

  async initialise(): Promise<void> {
    this.cookieStorageInterceptor.registerInterceptor();
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
  }

  // ----- Discover -----

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: "seasonal",
        title: "This Season's Anime",
        type: DiscoverSectionType.featured,
      },
      {
        id: "popular",
        title: "Popular Novels",
        type: DiscoverSectionType.prominentCarousel,
      },
      {
        id: "added",
        title: "Recently Added",
        type: DiscoverSectionType.simpleCarousel,
      },
      {
        id: "most_volumes",
        title: "Longest Series",
        type: DiscoverSectionType.simpleCarousel,
      },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    switch (section.id) {
      case "seasonal":
      case "popular": {
        const cards = await this.getHomeSection(section.id === "seasonal" ? /anime/i : /popular/i);
        return {
          items: cards.map((card) =>
            section.id === "seasonal"
              ? {
                  type: "featuredCarouselItem",
                  mangaId: card.id,
                  imageUrl: card.cover,
                  title: card.title,
                  contentRating: ContentRating.EVERYONE,
                }
              : {
                  type: "prominentCarouselItem",
                  mangaId: card.id,
                  imageUrl: card.cover,
                  title: card.title,
                  contentRating: ContentRating.EVERYONE,
                },
          ),
        };
      }
      case "added":
      case "most_volumes": {
        const entries = sortEntries(
          await this.getLibrary(),
          section.id === "added" ? "added" : "volumes",
        );
        const offset = metadata?.offset ?? 0;
        const page = entries.slice(offset, offset + PAGE_SIZE);
        return {
          items: page.map((entry) => ({
            type: "simpleCarouselItem",
            mangaId: entry.id,
            imageUrl: entry.cover,
            title: entry.title,
            subtitle: volumeLabel(entry.volumes),
            contentRating: contentRatingFor(entry.tags),
          })),
          metadata:
            offset + PAGE_SIZE < entries.length ? { offset: offset + PAGE_SIZE } : undefined,
        };
      }
      default:
        return { items: [] };
    }
  }

  // ----- Search -----

  async getSortingOptions(_query: SearchQuery<Metadata>): Promise<SortingOption[]> {
    return SORT_OPTIONS;
  }

  async getAdvancedSearchForm(query: SearchQuery<Metadata>): Promise<AdvancedSearchForm> {
    const meta = (query.metadata as { searchMeta?: LnoriSearchMetadata } | undefined)?.searchMeta;
    const library = await this.getLibrary().catch(() => [] as LibraryEntry[]);
    const tagNames = [...new Set(library.flatMap((e) => e.tags))].sort((a, b) =>
      a.localeCompare(b),
    );
    return new LnoriSearchForm(
      tagNames.map((name) => ({ id: name, name: titleCase(name) })),
      meta,
    );
  }

  // The site has no server-side search: /library lists every series with its
  // title, author, tags and stats, and the site filters it in the browser.
  // We do the same on a cached copy.
  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: PageMetadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const searchMeta = (query.metadata as { searchMeta?: LnoriSearchMetadata } | undefined)
      ?.searchMeta;
    const included = searchMeta?.tagIncluded ?? [];
    const excluded = searchMeta?.tagExcluded ?? [];
    const terms = normalize(query.title ?? "")
      .split(" ")
      .filter(Boolean);

    const matches = (await this.getLibrary()).filter((entry) => {
      if (included.some((tag) => !entry.tags.includes(tag))) return false;
      if (excluded.some((tag) => entry.tags.includes(tag))) return false;
      if (!terms.length) return true;
      const haystack = normalize(`${entry.title} ${entry.author}`);
      return terms.every((term) => haystack.includes(term));
    });

    const sorted = sortEntries(matches, sortingOption?.id ?? "popular");
    const offset = metadata?.offset ?? 0;
    const page = sorted.slice(offset, offset + PAGE_SIZE);

    return {
      items: page.map((entry) => ({
        mangaId: entry.id,
        imageUrl: entry.cover,
        title: entry.title,
        subtitle: [entry.author, volumeLabel(entry.volumes)].filter(Boolean).join(" · "),
        contentRating: contentRatingFor(entry.tags),
      })),
      metadata: offset + PAGE_SIZE < sorted.length ? { offset: offset + PAGE_SIZE } : undefined,
    };
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = await this.fetchCheerio({
      url: `${baseUrl}/series/${mangaId}`,
      method: "GET",
    });
    const ld = this.readSeriesJsonLd($);

    const title = ld.name ?? $("h1").first().text().trim();
    const authors = (Array.isArray(ld.author) ? ld.author : ld.author ? [ld.author] : [])
      .map((a) => a.name?.trim())
      .filter((name): name is string => !!name);
    const genres = (ld.genre ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    const cover =
      $(`img[src*="/cover/"]`).first().attr("src") ??
      $('meta[property="og:image"]').attr("content") ??
      ld.image ??
      "";

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: decode(title),
        secondaryTitles: [],
        thumbnailUrl: cover,
        synopsis: decode(ld.description ?? ""),
        ...(authors.length ? { author: authors.join(", ") } : {}),
        contentRating: contentRatingFor(genres.map((g) => g.toLowerCase())),
        contentType: "novel",
        tagGroups: genres.length
          ? [
              {
                id: "genres",
                title: "Genres",
                tags: genres.map((g) => ({ id: g.toLowerCase(), title: titleCase(g) })),
              },
            ]
          : [],
        shareUrl: `${baseUrl}/series/${mangaId}`,
      },
    };
  }

  // Each volume is one chapter: the site serves a whole volume as one page.
  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const $ = await this.fetchCheerio({
      url: `${baseUrl}/series/${sourceManga.mangaId}`,
      method: "GET",
    });
    const parts = this.readSeriesJsonLd($).hasPart ?? [];

    let volumes = parts
      .map((part, index) => ({
        url: part.url ?? "",
        name: part.name ?? `Volume ${index + 1}`,
        position: Number(part.position) || index + 1,
      }))
      .filter((part) => part.url.includes("/book/"));

    // Fallback if the structured data is ever missing
    if (!volumes.length) {
      const seen = new Set<string>();
      volumes = $('a[href*="/book/"]')
        .toArray()
        .map((el) => $(el).attr("href") ?? "")
        .filter((href) => href && !seen.has(href) && seen.add(href))
        .map((url, index) => ({ url, name: `Volume ${index + 1}`, position: index + 1 }));
    }

    return volumes.map((volume) => {
      const number = parseVolumeNumber(volume.name) ?? volume.position;
      return {
        chapterId: bookIdFromUrl(volume.url),
        sourceManga,
        title: `Volume ${formatNumber(number)}`,
        chapNum: number,
        volume: number,
        langCode: "en",
      };
    });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const $ = await this.fetchCheerio({
      url: `${baseUrl}/book/${chapter.chapterId}`,
      method: "GET",
    });

    const article = $("article.content-body").first();
    if (!article.length || !article.text().trim()) {
      throw new Error(`LNORI: no text found for ${chapter.chapterId}`);
    }

    article.find("script, style, noscript, iframe, button, svg, ins").remove();
    // Keep only the plain JPEG fallback of each <picture>
    article.find("picture source").remove();
    article.find("picture").each((_, el) => {
      $(el).replaceWith($(el).html() ?? "");
    });
    // Links point at the website; keep their text only
    article.find("a").each((_, el) => {
      $(el).replaceWith($(el).html() ?? "");
    });
    article.find("*").each((_, el) => {
      const node = $(el);
      for (const name of Object.keys(el.attribs ?? {})) {
        if (!KEPT_ATTRIBUTES.has(name)) node.removeAttr(name);
      }
    });

    const heading = $("h1#book-title").first().text().trim() || chapter.title || "";
    const body = fixVoidElements(
      (heading ? `<h1>${escapeHtml(heading)}</h1>\n` : "") +
        (article.html() ?? "").replace(/&nbsp;/g, "&#160;"),
    );

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      type: "html",
      html: `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${body}</body></html>`,
    };
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

  private async getLibrary(): Promise<LibraryEntry[]> {
    if (this.libraryCache && Date.now() - this.libraryCache.fetchedAt < LIBRARY_CACHE_TTL_MS) {
      return this.libraryCache.entries;
    }

    const $ = await this.fetchCheerio({ url: `${baseUrl}/library`, method: "GET" });
    const entries: LibraryEntry[] = [];
    const seen = new Set<string>();

    $("article.card[data-id]").each((_, el) => {
      const card = $(el);
      const href = card.find('a[href*="/series/"]').first().attr("href") ?? "";
      const id = seriesIdFromUrl(href);
      if (!id || seen.has(id)) return;
      seen.add(id);

      entries.push({
        id,
        numericId: Number(card.attr("data-id")) || 0,
        title: decode(card.attr("data-t") ?? card.find("img").attr("alt") ?? ""),
        author: decode(card.attr("data-a") ?? ""),
        year: Number(card.attr("data-d")) || 0,
        volumes: Number(card.attr("data-v")) || 0,
        tags: (card.attr("data-tags") ?? "")
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        popularity: Number(card.attr("data-rel")) || 0,
        cover: card.find("img").first().attr("src") ?? "",
      });
    });

    if (!entries.length) {
      throw new Error("LNORI: could not read the library page");
    }

    this.libraryCache = { entries, fetchedAt: Date.now() };
    return entries;
  }

  private async getHomeSection(
    heading: RegExp,
  ): Promise<{ id: string; title: string; cover: string }[]> {
    if (!this.homeCache || Date.now() - this.homeCache.fetchedAt >= HOME_CACHE_TTL_MS) {
      const $ = await this.fetchCheerio({ url: `${baseUrl}/`, method: "GET" });
      this.homeCache = { $, fetchedAt: Date.now() };
    }
    const $ = this.homeCache.$;

    const h2 = $("h2")
      .filter((_, el) => heading.test($(el).text()))
      .first();
    const section = h2.closest("section").length ? h2.closest("section") : h2.parent();

    const cards: { id: string; title: string; cover: string }[] = [];
    const seen = new Set<string>();
    section.find('a[href*="/series/"]').each((_, el) => {
      const a = $(el);
      const id = seriesIdFromUrl(a.attr("href") ?? "");
      const img = a.find("img").first();
      const title = (img.attr("alt") ?? a.text()).trim();
      if (!id || !title || seen.has(id)) return;
      seen.add(id);
      cards.push({ id, title: decode(title), cover: img.attr("src") ?? "" });
    });
    return cards;
  }

  private readSeriesJsonLd($: CheerioAPI): SeriesJsonLd {
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      try {
        const data = JSON.parse($(el).text()) as SeriesJsonLd & { "@type"?: string };
        if (data["@type"] === "Book" && data.hasPart) return data;
      } catch {
        // ignore malformed blocks
      }
    }
    return {};
  }

  private async fetchCheerio(request: Request): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest(request);
    switch (response.status) {
      case 403:
      case 503:
        throw new CloudflareError({ url: baseUrl, method: "GET" });
      case 404:
        throw new Error(`LNORI: page not found (${request.url})`);
      case 429:
        throw new Error("LNORI: too many requests, please try again later");
    }
    return cheerio.load(Application.arrayBufferToUTF8String(data));
  }
}

// ----- Utils -----

// ".../series/9601/the-angel-next-door" -> "9601/the-angel-next-door"
function seriesIdFromUrl(url: string): string {
  return url.match(/\/series\/(\d+\/[^/?#]+)/)?.[1] ?? url.match(/\/series\/(\d+)/)?.[1] ?? "";
}

// ".../book/26422/the-angel-vol-1" -> "26422/the-angel-vol-1"
function bookIdFromUrl(url: string): string {
  return url.match(/\/book\/(\d+\/[^/?#]+)/)?.[1] ?? url.match(/\/book\/(\d+)/)?.[1] ?? "";
}

// "Volume 5" -> 5, "Volume 5: .5" -> 5.5, "Volume 2.5" -> 2.5
function parseVolumeNumber(name: string): number | undefined {
  const match = name.match(/(\d+(?:\.\d+)?)(?:\s*:\s*\.(\d+))?/);
  if (!match) return undefined;
  const value = parseFloat(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function sortEntries(entries: LibraryEntry[], sort: string): LibraryEntry[] {
  const list = [...entries];
  switch (sort) {
    case "title":
      return list.sort((a, b) => a.title.localeCompare(b.title));
    case "newest":
      return list.sort((a, b) => b.year - a.year || b.popularity - a.popularity);
    case "oldest":
      return list.sort((a, b) => (a.year || 9999) - (b.year || 9999));
    case "volumes":
      return list.sort((a, b) => b.volumes - a.volumes || b.popularity - a.popularity);
    case "added":
      return list.sort((a, b) => b.numericId - a.numericId);
    default:
      return list.sort((a, b) => b.popularity - a.popularity);
  }
}

function contentRatingFor(tags: string[]): ContentRating {
  return tags.some((t) => ADULT_TAGS.includes(t)) ? ContentRating.MATURE : ContentRating.EVERYONE;
}

function volumeLabel(count: number): string | undefined {
  if (!count) return undefined;
  return count === 1 ? "1 volume" : `${count} volumes`;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function decode(text: string): string {
  return Application.decodeHTMLEntities(text);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Readium parses chapters as XHTML, so void tags like <br> must be self-closed
function fixVoidElements(html: string): string {
  return html.replace(VOID_ELEMENT_REGEX, (_match, tag: string, attributes: string) => {
    const attrs = attributes.trim();
    return attrs ? `<${tag.toLowerCase()} ${attrs} />` : `<${tag.toLowerCase()} />`;
  });
}

export const Lnori = new LnoriExtension();
