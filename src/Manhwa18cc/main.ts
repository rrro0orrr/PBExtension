import {
  AdvancedSearchForm,
  BasicRateLimiter,
  Chapter,
  ChapterDetails,
  ChapterProviding,
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
  TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import * as htmlparser2 from "htmlparser2";

import {
  GENRES,
  hideRaw,
  Manhwa18SearchForm,
  Manhwa18SettingsForm,
  type Manhwa18SearchMetadata,
} from "./forms";
import { DOMAIN, isManhwa18Url, Manhwa18Interceptor } from "./interceptors";

// Manhwa18.cc runs a custom "YiiMadara" theme (keiyoushi/extensions-source,
// src/all/manhwa18cc). Manga ids are the slug under /webtoon/ (e.g.
// "wireless-onahole"); chapter ids are the chapter segment ("chapter-129").

const SORT_OPTIONS: SortingOption[] = [
  { id: "", label: "Latest Updates" },
  { id: "trending", label: "Trending" },
  { id: "rating", label: "Rating" },
  { id: "latest", label: "Newest" },
  { id: "alphabet", label: "A-Z" },
];

const SECTIONS: Record<string, { title: string; path: string; type: DiscoverSectionType }> = {
  trending: {
    title: "Trending",
    path: "/webtoons?orderby=trending",
    type: DiscoverSectionType.prominentCarousel,
  },
  latest: { title: "Latest Updates", path: "/webtoons", type: DiscoverSectionType.simpleCarousel },
  rating: {
    title: "Top Rated",
    path: "/webtoons?orderby=rating",
    type: DiscoverSectionType.simpleCarousel,
  },
  completed: { title: "Completed", path: "/completed", type: DiscoverSectionType.simpleCarousel },
};

/** Paging state: the next listing URL, read from the page's own "next" link. */
type ListingMetadata = { next?: string };

// Listing pages to read ahead when hiding raw titles empties a page.
const MAX_EMPTY_PAGE_SKIPS = 3;

export interface Card {
  mangaId: string;
  title: string;
  cover: string;
}

type Manhwa18Implementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding &
  SettingsFormProviding;

export class Manhwa18ccExtension implements Manhwa18Implementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({ storage: "stateManager" });
  requestManager = new Manhwa18Interceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });

  async initialise(): Promise<void> {
    this.cookieStorageInterceptor.registerInterceptor();
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
  }

  async getSettingsForm(): Promise<Form> {
    return new Manhwa18SettingsForm();
  }

  // ----- Discover -----

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return Object.entries(SECTIONS).map(([id, s]) => ({ id, title: s.title, type: s.type }));
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: ListingMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const def = SECTIONS[section.id];
    if (!def) return { items: [] };
    const { cards, next } = await this.fetchListing(metadata?.next ?? `${DOMAIN}${def.path}`);
    const type =
      def.type === DiscoverSectionType.prominentCarousel
        ? "prominentCarouselItem"
        : "simpleCarouselItem";
    return {
      items: cards.map((card) => ({
        type,
        mangaId: card.mangaId,
        title: card.title,
        imageUrl: card.cover,
        contentRating: ContentRating.ADULT,
      })),
      metadata: next ? { next } : undefined,
    };
  }

  // ----- Search -----

  async getSortingOptions(_query: SearchQuery<Metadata>): Promise<SortingOption[]> {
    return SORT_OPTIONS;
  }

  async getAdvancedSearchForm(query: SearchQuery<Metadata>): Promise<AdvancedSearchForm> {
    return new Manhwa18SearchForm(searchMetaOf(query));
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: ListingMetadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const title = (query.title ?? "").trim();

    // A pasted manhwa18.cc link opens that title directly.
    const pasted = mangaIdFromUrl(title);
    if (pasted && !metadata?.next) {
      const manga = await this.getMangaDetails(pasted);
      return {
        items: [
          {
            mangaId: pasted,
            title: manga.mangaInfo.primaryTitle,
            imageUrl: manga.mangaInfo.thumbnailUrl,
          },
        ],
      };
    }

    let first: string;
    if (title) {
      first = `${DOMAIN}/search?q=${encodeURIComponent(title)}`;
    } else {
      const sort = sortingOption?.id ?? "";
      const genre = searchMetaOf(query).genre;
      const base = genre
        ? `${DOMAIN}/webtoon-genre/${encodeURIComponent(genre)}`
        : `${DOMAIN}/webtoons`;
      first = sort ? `${base}?orderby=${encodeURIComponent(sort)}` : base;
    }
    const { cards, next } = await this.fetchListing(metadata?.next ?? first);
    return {
      items: cards.map((card) => ({
        mangaId: card.mangaId,
        title: card.title,
        imageUrl: card.cover,
        contentRating: ContentRating.ADULT,
      })),
      metadata: next ? { next } : undefined,
    };
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const url = mangaUrl(mangaId);
    const $ = await this.fetchCheerio(url);
    return { mangaId, mangaInfo: parseDetails($, url) };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const $ = await this.fetchCheerio(mangaUrl(sourceManga.mangaId));
    return parseChapters($, sourceManga);
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const url = `${mangaUrl(chapter.sourceManga.mangaId)}/${chapter.chapterId}`;
    const pages = parsePages(await this.fetchCheerio(url));
    if (!pages.length) throw new Error(`Manhwa18.cc: no pages found for ${url}`);
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }

  getMangaShareUrl(mangaId: string): string {
    return mangaUrl(mangaId);
  }

  // ----- Cloudflare -----

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
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
   * Reads one listing page, dropping raw titles when that setting is on. If
   * that empties the page, reads ahead (a few pages at most) so the results
   * don't look like they ended.
   */
  private async fetchListing(url: string): Promise<{ cards: Card[]; next?: string }> {
    const hide = hideRaw();
    let current = url;
    for (let skips = 0; ; skips++) {
      const $ = await this.fetchCheerio(current);
      const cards = parseCards($).filter((card) => !(hide && isRawTitle(card)));
      const next = nextPageUrl($, current);
      if (cards.length || !next || skips >= MAX_EMPTY_PAGE_SKIPS) return { cards, next };
      current = next;
    }
  }

  private async fetchCheerio(url: string): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
    if (response.status === 404) throw new Error(`Manhwa18.cc: not found (${url})`);
    if (response.status >= 400) {
      throw new Error(`Manhwa18.cc: request failed (HTTP ${response.status}): ${url}`);
    }
    return cheerio.load(htmlparser2.parseDocument(Application.arrayBufferToUTF8String(data)));
  }
}

// ----- Parsing -----

function mangaUrl(mangaId: string): string {
  return `${DOMAIN}/webtoon/${mangaId}`;
}

/** Slug of a manhwa18.cc title link (`/webtoon/<slug>[/chapter-N]`), if it is one. */
export function mangaIdFromUrl(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url) || !isManhwa18Url(url)) return undefined;
  return url.match(/\/webtoon\/([^/?#]+)/)?.[1];
}

function absolute(src: string | undefined): string {
  const s = (src ?? "").trim();
  if (!s || s.startsWith("data:")) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  return `${DOMAIN}${s.startsWith("/") ? "" : "/"}${s}`;
}

function imageSrc(img: ReturnType<CheerioAPI>): string {
  return absolute(img.attr("data-src")) || absolute(img.attr("src"));
}

/** Untranslated Korean copies: "<Title> Raw", slug "<slug>-raw" or "<slug>-raw-01". */
export function isRawTitle(card: Pick<Card, "mangaId" | "title">): boolean {
  return /\braw$/i.test(card.title.trim()) || /-raw(?:-\d+)?$/i.test(card.mangaId);
}

export function parseCards($: CheerioAPI): Card[] {
  const seen = new Set<string>();
  const cards: Card[] = [];
  $("div.manga-item").each((_, element) => {
    const item = $(element);
    const link = item.find("h3 a").first();
    const href = link.attr("href") || item.find(".thumb a").first().attr("href") || "";
    const mangaId = mangaIdFromUrl(absolute(href));
    const title = link.text().trim() || link.attr("title")?.trim() || "";
    if (!mangaId || !title || seen.has(mangaId)) return;
    seen.add(mangaId);
    cards.push({ mangaId, title, cover: imageSrc(item.find(".thumb img, img").first()) });
  });
  return cards;
}

/** The page's own "next" link, so listing and search paging follow the site. */
export function nextPageUrl($: CheerioAPI, current: string): string | undefined {
  const href = $("ul.pagination li.next:not(.disabled) a").first().attr("href");
  const next = absolute(href);
  return next && next !== current ? next : undefined;
}

function row($: CheerioAPI, heading: RegExp) {
  return $("div.post-content_item")
    .filter((_, el) => heading.test($(el).find(".summary-heading").text()))
    .first()
    .find(".summary-content");
}

export function parseDetails($: CheerioAPI, url: string): SourceManga["mangaInfo"] {
  // The heading holds an "18+" badge span next to the title text.
  const heading = $("div.post-title h1").first();
  const title = heading.clone().children().remove().end().text().trim() || heading.text().trim();

  const altTitles = row($, /Alternative/i)
    .text()
    .split(/[,;/]/)
    .map((t) => t.trim())
    .filter((t) => t && t !== title);

  const names = (heading: RegExp) =>
    row($, heading)
      .find("a")
      .map((_, a) => $(a).text().trim())
      .get()
      .filter(Boolean)
      .join(", ") || undefined;

  const genres = $("div.genres-content a")
    .map((_, a) => $(a).text().trim())
    .get()
    .filter(Boolean);
  const tagGroups: TagSection[] = genres.length
    ? [
        {
          id: "genres",
          title: "Genres",
          tags: genres.map((g) => ({ id: g.toLowerCase().replace(/\s+/g, "-"), title: g })),
        },
      ]
    : [];

  const rating = parseFloat($("#averagerate").first().text().trim());
  const cover =
    imageSrc($("div.summary_image img").first()) ||
    absolute($('meta[property="og:image"]').attr("content"));

  return {
    primaryTitle: title,
    secondaryTitles: altTitles,
    thumbnailUrl: cover || `${DOMAIN}/images/manhwa18-bn.jpg`,
    author: names(/Author/i),
    artist: names(/Artist/i),
    synopsis: $("div.panel-story-description .dsct").first().text().trim(),
    rating: isNaN(rating) ? 0 : rating / 5,
    contentRating: ContentRating.ADULT,
    status: parseStatus(row($, /Status/i).text()),
    tagGroups,
    shareUrl: url,
  };
}

function parseStatus(text: string): string {
  const s = text.toLowerCase();
  if (s.includes("complet")) return "Completed";
  if (s.includes("ongoing") || s.includes("on going")) return "Ongoing";
  if (s.includes("hiatus") || s.includes("hold")) return "Hiatus";
  if (s.includes("cancel") || s.includes("drop")) return "Cancelled";
  return "Unknown";
}

export function parseChapters($: CheerioAPI, sourceManga: SourceManga): Chapter[] {
  const chapters: Chapter[] = [];
  const seen = new Set<string>();
  $("li.a-h").each((_, element) => {
    const el = $(element);
    const link = el.find("a.chapter-name, a").first();
    const href = link.attr("href") || "";
    const chapterId = href
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .split("/")
      .pop();
    if (!chapterId || !/\/webtoon\//.test(href) || seen.has(chapterId)) return;
    seen.add(chapterId);

    const title = link.text().trim();
    const fromTitle = title.match(/chapter[\s.-]*(\d+(?:\.\d+)?)/i)?.[1];
    const fromSlug = chapterId.match(/chapter-(\d+(?:-\d+)?)/i)?.[1]?.replace("-", ".");
    const chapNum = parseFloat(fromTitle ?? fromSlug ?? "0") || 0;

    chapters.push({
      chapterId,
      sourceManga,
      title,
      chapNum,
      volume: 0,
      publishDate: parseDate(el.find(".chapter-time").first().text()),
      langCode: "🇬🇧",
    });
  });
  return chapters;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "25 Nov 2026", or relative ("3 hours ago") for very recent chapters. */
export function parseDate(text: string): Date | undefined {
  const s = text.trim().toLowerCase();
  if (!s) return undefined;
  const absoluteDate = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/);
  if (absoluteDate) {
    const month = MONTHS.indexOf(absoluteDate[2]);
    if (month >= 0) {
      return new Date(Date.UTC(Number(absoluteDate[3]), month, Number(absoluteDate[1])));
    }
  }
  const relative = s.match(/(\d+|an?)\s+(second|minute|min|hour|day|week|month|year)s?\s+ago/);
  if (relative) {
    const amount = /^\d+$/.test(relative[1]) ? Number(relative[1]) : 1;
    const unit: Record<string, number> = {
      second: 1e3,
      minute: 6e4,
      min: 6e4,
      hour: 36e5,
      day: 864e5,
      week: 6048e5,
      month: 2592e6,
      year: 31536e6,
    };
    return new Date(Date.now() - amount * unit[relative[2]]);
  }
  return undefined;
}

export function parsePages($: CheerioAPI): string[] {
  const pages = $("div.read-content img")
    .map((_, img) => imageSrc($(img)))
    .get()
    .filter(Boolean);
  return [...new Set(pages)];
}

export const Manhwa18cc = new Manhwa18ccExtension();

function searchMetaOf(query: SearchQuery<Metadata>): Manhwa18SearchMetadata {
  const meta = (query.metadata as { searchMeta?: Manhwa18SearchMetadata } | undefined)?.searchMeta;
  // Only accept genres we know, so stale or tampered metadata can't build odd URLs.
  return meta?.genre && GENRES.some((g) => g.id === meta.genre) ? { genre: meta.genre } : {};
}
