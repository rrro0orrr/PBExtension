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
  Tag,
  TagSection,
} from "@paperback/types";
import * as cheerio from "cheerio";
import { Hentai2readSearchForm, type Hentai2readSearchMetadata } from "./forms/SearchForm";
import { Hentai2readInterceptor } from "./interceptors";
import type {
  H2RBookCard,
  H2RBookPageProps,
  H2RHomeProps,
  H2RPage,
  H2RPaginated,
  H2RReaderProps,
  H2RSearchTag,
} from "./model";

const baseUrl = "https://hentai2read.com";

// The site is an Inertia.js app: every page embeds its full data as JSON in
// <script data-page="app">, which is far more stable than the Tailwind markup.

const SORT_OPTIONS: SortingOption[] = [
  { id: "", label: "Best match" },
  { id: "latest", label: "Recently updated" },
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "most-viewed", label: "Most read" },
  { id: "top-rated", label: "Highest rated" },
  { id: "alphabetical", label: "A to Z" },
  { id: "most-chapters", label: "Most chapters" },
  { id: "most-pages", label: "Most pages" },
  { id: "fewest-pages", label: "Fewest pages" },
];

// Discover sections backed by paginated /browse listings
const BROWSE_SECTIONS: Record<string, { title: string; path: string }> = {
  recently_updated: { title: "Recently Updated", path: "/browse" },
  newest: { title: "Just Added", path: "/browse/newest" },
  trending: { title: "Trending", path: "/browse/trending" },
  staff_picks: { title: "Staff Picks", path: "/browse/staff-picks" },
  top_rated: { title: "Highest Rated", path: "/browse/top-rated" },
};

const TAG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HOME_CACHE_TTL_MS = 5 * 60 * 1000;

type PageMetadata = { page?: number };

type Hentai2readImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class Hentai2readExtension implements Hentai2readImplementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });
  requestManager = new Hentai2readInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 10,
    bufferInterval: 1,
    ignoreImages: true,
  });

  private tagCache: { tags: H2RSearchTag[]; fetchedAt: number } | undefined;
  private homeCache: { props: H2RHomeProps; fetchedAt: number } | undefined;

  async initialise(): Promise<void> {
    // No network calls here: a Cloudflare challenge or outage at startup
    // must not stop the extension from loading.
    this.cookieStorageInterceptor.registerInterceptor();
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
  }

  // ----- Discover -----

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: "top_yesterday",
        title: "Top Yesterday",
        type: DiscoverSectionType.featured,
      },
      ...Object.entries(BROWSE_SECTIONS).map(([id, s]) => ({
        id,
        title: s.title,
        type: DiscoverSectionType.simpleCarousel,
      })),
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === "top_yesterday") {
      const home = await this.getHomeProps();
      return {
        items: (home.top ?? []).map((book) => ({
          type: "featuredCarouselItem",
          mangaId: mangaIdFromUrl(book.url),
          imageUrl: book.cover,
          title: book.title,
          supertitle: book.typeLabel,
          contentRating: ContentRating.ADULT,
        })),
      };
    }

    const def = BROWSE_SECTIONS[section.id];
    if (!def) return { items: [] };

    const page = metadata?.page ?? 1;
    const props = await this.fetchPageProps<{ books: H2RPaginated }>(
      `${baseUrl}${def.path}${page > 1 ? `?page=${page}` : ""}`,
    );
    const books = props.books;

    return {
      items: (books?.data ?? []).map((book) => ({
        type: "simpleCarouselItem",
        mangaId: mangaIdFromUrl(book.url),
        imageUrl: book.cover,
        title: book.title,
        subtitle: cardSubtitle(book),
        contentRating: ContentRating.ADULT,
      })),
      metadata: hasMore(books, page) ? { page: page + 1 } : undefined,
    };
  }

  // ----- Search -----

  async getAdvancedSearchForm(query: SearchQuery<Metadata>): Promise<AdvancedSearchForm> {
    const meta = (query.metadata as { searchMeta?: Hentai2readSearchMetadata } | undefined)
      ?.searchMeta;
    const tags = (await this.getSearchTags().catch(() => [])).map((t) => ({
      id: String(t.id),
      name: t.name,
    }));
    return new Hentai2readSearchForm(tags, meta);
  }

  async getSortingOptions(_query: SearchQuery<Metadata>): Promise<SortingOption[]> {
    return SORT_OPTIONS;
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: PageMetadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const searchMeta = (query.metadata as { searchMeta?: Hentai2readSearchMetadata } | undefined)
      ?.searchMeta;
    const included = searchMeta?.tagIncluded ?? [];
    const excluded = searchMeta?.tagExcluded ?? [];
    const title = (query.title ?? "").trim();
    const sort = sortingOption?.id ?? "";

    let url: string;
    if (!title && !included.length && !excluded.length) {
      // Nothing to search for: show the full catalogue in the chosen order
      const browseSort = sort && sort !== "latest" ? `/${sort}` : "";
      url = `${baseUrl}/browse${browseSort}${page > 1 ? `?page=${page}` : ""}`;
    } else {
      const params: string[] = [];
      if (title) params.push(`q=${encodeURIComponent(title)}`);
      if (included.length) params.push(`with=${included.join(",")}`);
      if (excluded.length) params.push(`without=${excluded.join(",")}`);
      if (sort) params.push(`sort=${encodeURIComponent(sort)}`);
      if (page > 1) params.push(`page=${page}`);
      url = `${baseUrl}/search?${params.join("&")}`;
    }

    const props = await this.fetchPageProps<{ books: H2RPaginated }>(url);
    const books = props.books;

    return {
      items: (books?.data ?? []).map((book) => ({
        mangaId: mangaIdFromUrl(book.url),
        imageUrl: book.cover,
        title: book.title,
        subtitle: cardSubtitle(book),
        contentRating: ContentRating.ADULT,
      })),
      metadata: hasMore(books, page) ? { page: page + 1 } : undefined,
    };
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const props = await this.fetchPageProps<H2RBookPageProps>(`${baseUrl}/${mangaId}`);
    const book = props.book;
    if (!book) throw new Error(`Gallery not found: ${mangaId}`);

    const tagGroups: TagSection[] = [];
    const byType = new Map<string, Tag[]>();
    for (const tag of book.tags ?? []) {
      const list = byType.get(tag.type) ?? [];
      list.push({ id: String(tag.id), title: tag.name });
      byType.set(tag.type, list);
    }
    for (const [type, tags] of byType) {
      tagGroups.push({ id: type, title: capitalize(type), tags });
    }

    const creators: string[] = [];
    for (const group of book.groups ?? []) {
      if (group.type === "language") continue;
      const tags = group.tags.map((t) => ({ id: String(t.id), title: t.name }));
      if (!tags.length) continue;
      if (group.type === "artist" || group.type === "author") {
        creators.push(...group.tags.map((t) => t.name));
      }
      tagGroups.push({ id: group.type, title: group.label, tags });
    }

    const statusLabel = book.status?.label?.toLowerCase() ?? "";
    const status = statusLabel.includes("complete")
      ? "COMPLETED"
      : statusLabel.includes("ongoing")
        ? "ONGOING"
        : "UNKNOWN";

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: book.title,
        secondaryTitles: splitAltTitles(book.alt),
        thumbnailUrl: book.cover,
        synopsis: descriptionText(book.description),
        author: creators.join(", ") || undefined,
        artist: creators.join(", ") || undefined,
        rating: props.stats?.rating,
        contentRating: ContentRating.ADULT,
        status,
        tagGroups,
        shareUrl: `${baseUrl}${book.url}`,
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const props = await this.fetchPageProps<H2RBookPageProps>(`${baseUrl}/${sourceManga.mangaId}`);
    const language = props.book?.groups
      ?.find((g) => g.type === "language")
      ?.tags[0]?.name.toLowerCase();
    const langCode = language ? (LANG_CODES[language] ?? "unk") : "en";

    return (props.chapters ?? []).map((chapter, index, all) => {
      const chapNum = parseFloat(chapter.number);
      return {
        chapterId: chapterIdFromUrl(chapter.url),
        sourceManga,
        title: chapter.title || `Chapter ${chapter.number}`,
        // Fall back to list position (newest first) if the number is missing
        chapNum: Number.isFinite(chapNum) ? chapNum : all.length - index,
        publishDate: parseDate(chapter.date),
        langCode,
      };
    });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const props = await this.fetchPageProps<H2RReaderProps>(
      `${baseUrl}/${chapter.chapterId}/page-1`,
    );

    const pages = (props.images ?? [])
      .map((image) => absoluteUrl(image))
      .filter((image) => image.length > 0);

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
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

  private async getHomeProps(): Promise<H2RHomeProps> {
    if (this.homeCache && Date.now() - this.homeCache.fetchedAt < HOME_CACHE_TTL_MS) {
      return this.homeCache.props;
    }
    const props = await this.fetchPageProps<H2RHomeProps>(`${baseUrl}/`);
    this.homeCache = { props, fetchedAt: Date.now() };
    return props;
  }

  private async getSearchTags(): Promise<H2RSearchTag[]> {
    if (this.tagCache && Date.now() - this.tagCache.fetchedAt < TAG_CACHE_TTL_MS) {
      return this.tagCache.tags;
    }
    const [response, data] = await Application.scheduleRequest({
      url: `${baseUrl}/search/tags`,
      method: "GET",
      headers: { Accept: "application/json" },
    });
    this.checkResponseStatus(response.status, `${baseUrl}/search/tags`);
    const tags = JSON.parse(Application.arrayBufferToUTF8String(data)) as H2RSearchTag[];
    tags.sort((a, b) => a.name.localeCompare(b.name));
    this.tagCache = { tags, fetchedAt: Date.now() };
    return tags;
  }

  private async fetchPageProps<T>(url: string): Promise<T> {
    const request: Request = { url, method: "GET" };
    const [response, data] = await Application.scheduleRequest(request);
    this.checkResponseStatus(response.status, url);

    const $ = cheerio.load(Application.arrayBufferToUTF8String(data));
    const json = $('script[data-page="app"]').first().text();
    if (!json) {
      throw new Error(`Unexpected page layout at ${url}`);
    }
    const page = JSON.parse(json) as H2RPage<T>;
    return page.props;
  }

  private checkResponseStatus(status: number, url: string): void {
    switch (status) {
      case 403:
      case 503:
        throw new CloudflareError({ url: baseUrl, method: "GET" });
      case 404:
        throw new Error(`Page not found: ${url}`);
      case 429:
        throw new Error("Too many requests, please try again later");
    }
  }
}

// ----- Utils -----

const LANG_CODES: Record<string, string> = {
  english: "en",
  japanese: "jp",
  chinese: "cn",
  korean: "kr",
  spanish: "es",
};

// "/original/33728-some-title" -> "original/33728-some-title"
function mangaIdFromUrl(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/+|\/+$/g, "")
    .split(/[?#]/)[0];
}

// "/reader/33728-some-title/55650/page-1" -> "reader/33728-some-title/55650"
function chapterIdFromUrl(url: string): string {
  return mangaIdFromUrl(url).replace(/\/page-\d+$/, "");
}

function absoluteUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${baseUrl}${url}`;
  return url;
}

function hasMore(books: H2RPaginated | undefined, page: number): boolean {
  if (!books?.data?.length) return false;
  if (typeof books.lastPage === "number") return page < books.lastPage;
  return Boolean(books.links?.next);
}

function cardSubtitle(book: H2RBookCard): string | undefined {
  const parts = [
    book.artist?.name,
    book.chapters > 1 ? `${book.chapters} chapters` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : book.typeLabel;
}

function splitAltTitles(alt: string | string[] | null | undefined): string[] {
  if (!alt) return [];
  const list = Array.isArray(alt) ? alt : alt.split(/\s*[;|]\s*/);
  return list.map((t) => t.trim()).filter(Boolean);
}

function descriptionText(description: unknown): string {
  if (!description) return "";
  if (typeof description === "string") return stripHtml(description);
  if (typeof description === "object") {
    const d = description as Record<string, unknown>;
    for (const key of ["text", "plain", "html", "body", "content"]) {
      if (typeof d[key] === "string") return stripHtml(d[key] as string);
    }
  }
  return "";
}

function stripHtml(html: string): string {
  return Application.decodeHTMLEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseDate(text: string | undefined): Date | undefined {
  if (!text) return undefined;
  const relative = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (relative) {
    const value = parseInt(relative[1], 10);
    const unitMs: Record<string, number> = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_592_000_000,
      year: 31_536_000_000,
    };
    return new Date(Date.now() - value * unitMs[relative[2].toLowerCase()]);
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export const Hentai2read = new Hentai2readExtension();
