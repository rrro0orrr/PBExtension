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
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SortingOption,
  SourceManga,
  Tag,
} from "@paperback/types";
import * as cheerio from "cheerio";
import {
  NovelArchiveSearchForm,
  type GenreState,
  type NovelArchiveSearchMetadata,
} from "./forms/SearchForm";
import { NovelArchiveInterceptor } from "./interceptors";

const baseUrl = "https://novelarchive.cc";
const apiUrl = `${baseUrl}/api`;

const PAGE_SIZE = 24;
const GENRE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// /sources is optional and can hang for ~30s before a 504
const SOURCES_TIMEOUT_SECONDS = 8;
const NATIVE_VERSION = "Novel Archive";

// Values accepted by /api/novels?sort=
const SORT_OPTIONS: SortingOption[] = [
  { id: "recent", label: "Recently Updated" },
  { id: "popular", label: "Popular" },
  { id: "rating", label: "Top Rated" },
  { id: "chapters", label: "Most Chapters" },
];

const ADULT_GENRES = [
  "adult",
  "smut",
  "erotica",
  "explicit sex",
  "nsfw",
  "r-18",
  "r18",
  "hentai",
  "pornographic",
  "lewd",
];
const MATURE_GENRES = ["mature", "ecchi", "r-15", "gore", "steamy"];

// Navigation labels the site's genre list includes but that aren't genres
const NON_GENRES = new Set([
  "browse",
  "see all",
  "sign in",
  "latest",
  "new",
  "popular",
  "recent posts",
  "completed novel",
  "completed novels",
  "latest novel",
  "latest novels",
  "latest releases",
  "new novels",
  "popular novels",
  "uncategorized",
]);

const VOID_ELEMENTS = "area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr";
const VOID_ELEMENT_REGEX = new RegExp(`<(${VOID_ELEMENTS})((?:\\s+[^>]*?)?)\\s*/?>`, "gi");
const KEPT_ATTRIBUTES = new Set(["src", "alt", "colspan", "rowspan"]);

// Paperback rejects ids with characters outside this set (spaces, ×, etc.)
const UNSAFE_ID_CHARS = /[^a-zA-Z0-9._\-@()[\]%?#+=/&:]/g;

interface ApiNovel {
  id: string;
  title: string;
  author?: string;
  genres?: string;
  description?: string;
  cover_url?: string;
  novel_image?: string;
  associated_names?: string[];
  chapter_names?: string[];
  total_chapters?: string | number;
  rating?: number;
  rating_count?: number;
  release_status?: string;
  updated_at?: string;
}

interface ApiNovelList {
  novels?: ApiNovel[];
  pagination?: { page: number; total_pages: number; has_next: boolean };
}

interface ApiChapter {
  chapter?: { number: number; name?: string; content?: string };
}

interface ApiSource {
  id: string;
  label?: string;
}

interface ApiSourceChapter {
  number: number | string;
  title?: string;
}

interface ApiSourceChapterDetail {
  content_html?: string;
  content?: string;
  chapter?: { content_html?: string; content?: string };
}

type PageMetadata = { page?: number };

type NovelArchiveImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class NovelArchiveExtension implements NovelArchiveImplementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });
  requestManager = new NovelArchiveInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 1,
    ignoreImages: true,
  });

  private genreCache: { genres: Tag[]; fetchedAt: number } | undefined;

  async initialise(): Promise<void> {
    this.cookieStorageInterceptor.registerInterceptor();
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
  }

  // ----- Discover -----

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: "trending", title: "Trending", type: DiscoverSectionType.featured },
      { id: "updated", title: "Latest Updates", type: DiscoverSectionType.chapterUpdates },
      { id: "editors", title: "Editor's Choice", type: DiscoverSectionType.prominentCarousel },
      { id: "popular", title: "Popular", type: DiscoverSectionType.simpleCarousel },
      { id: "rating", title: "Top Rated", type: DiscoverSectionType.simpleCarousel },
      { id: "new", title: "New Novels", type: DiscoverSectionType.simpleCarousel },
      { id: "genres", title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    switch (section.id) {
      case "trending": {
        const list = await this.fetchJson<ApiNovelList>(`${apiUrl}/novels/trending?limit=20`);
        return {
          items: (list.novels ?? []).map((novel) => ({
            type: "featuredCarouselItem",
            mangaId: novel.id,
            imageUrl: coverUrl(novel),
            title: novel.title,
            supertitle: novel.author || undefined,
            contentRating: contentRatingFor(novel.genres),
          })),
        };
      }
      case "updated": {
        const list = await this.fetchJson<ApiNovelList>(
          `${apiUrl}/novels/recently-updated?limit=${PAGE_SIZE}`,
        );
        const items: DiscoverSectionItem[] = [];
        for (const novel of list.novels ?? []) {
          const total = Number(novel.total_chapters) || 0;
          if (!total) continue;
          const updatedAt = novel.updated_at ? new Date(novel.updated_at) : undefined;
          items.push({
            type: "chapterUpdatesCarouselItem",
            mangaId: novel.id,
            // Native chapter ids are 1-based positions, so the newest is the total
            chapterId: String(total),
            imageUrl: coverUrl(novel),
            title: novel.title,
            subtitle: `Ch. ${total}`,
            ...(updatedAt && !Number.isNaN(updatedAt.getTime()) ? { publishDate: updatedAt } : {}),
            contentRating: contentRatingFor(novel.genres),
          });
        }
        return { items };
      }
      case "editors": {
        const list = await this.fetchJson<ApiNovelList>(`${apiUrl}/novels/editors-choice?limit=20`);
        return {
          items: (list.novels ?? []).map((novel) => ({
            type: "prominentCarouselItem",
            mangaId: novel.id,
            imageUrl: coverUrl(novel),
            title: novel.title,
            subtitle: novel.author || undefined,
            contentRating: contentRatingFor(novel.genres),
          })),
        };
      }
      case "popular":
      case "rating":
      case "new": {
        const page = metadata?.page ?? 1;
        // "New Novels" uses the creation-ordered feed, the rest the browse sort
        const url =
          section.id === "new"
            ? `${apiUrl}/novels/recent?limit=${PAGE_SIZE * page}`
            : `${apiUrl}/novels?sort=${section.id}&page=${page}&per_page=${PAGE_SIZE}`;
        const list = await this.fetchJson<ApiNovelList>(url);
        let novels = list.novels ?? [];
        if (section.id === "new") novels = novels.slice((page - 1) * PAGE_SIZE);

        return {
          items: novels.map((novel) => ({
            type: "simpleCarouselItem",
            mangaId: novel.id,
            imageUrl: coverUrl(novel),
            title: novel.title,
            subtitle: chapterCountLabel(novel),
            contentRating: contentRatingFor(novel.genres),
          })),
          metadata:
            section.id === "new"
              ? novels.length >= PAGE_SIZE && page < 5
                ? { page: page + 1 }
                : undefined
              : list.pagination?.has_next
                ? { page: page + 1 }
                : undefined,
        };
      }
      case "genres": {
        const genres = await this.getGenres().catch(() => [] as Tag[]);
        return {
          items: genres.map((genre) => ({
            type: "genresCarouselItem",
            name: genre.title,
            searchQuery: {
              title: "",
              metadata: {
                searchMeta: { genres: { [genre.id]: "included" } },
              },
            },
            contentRating: contentRatingFor(decodeId(genre.id)),
          })),
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
    const genres = await this.getGenres().catch(() => [] as Tag[]);
    return new NovelArchiveSearchForm(genres, searchMetaOf(query));
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: PageMetadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const title = (query.title ?? "").trim();

    // A pasted novelarchive.cc link opens that novel directly
    const pasted = await this.resolvePastedUrl(title);
    if (pasted) return { items: [pasted] };

    const page = metadata?.page ?? 1;
    const meta = searchMetaOf(query);
    const included = genresIn(meta.genres, "included");
    const excluded = genresIn(meta.genres, "excluded");

    const params: string[] = [];
    if (title) params.push(`search=${encodeURIComponent(title)}`, "fuzzy=1");
    if (included.length) params.push(`genres_include=${encodeURIComponent(included.join(","))}`);
    if (excluded.length) params.push(`genres_exclude=${encodeURIComponent(excluded.join(","))}`);
    if (meta.genreMatch === "any" && included.length > 1) params.push("genre_match=any");
    if (meta.status) params.push(`status=${encodeURIComponent(meta.status)}`);
    // With a title, leave the order to the site's relevance ranking unless asked
    const sort = sortingOption?.id ?? (title ? "" : "popular");
    if (sort && sort !== "recent") params.push(`sort=${sort}`);
    params.push(`page=${page}`, `per_page=${PAGE_SIZE}`);

    const list = await this.fetchJson<ApiNovelList>(`${apiUrl}/novels?${params.join("&")}`);

    return {
      items: (list.novels ?? []).map((novel) => ({
        mangaId: novel.id,
        imageUrl: coverUrl(novel),
        title: novel.title,
        subtitle: [novel.author, chapterCountLabel(novel)].filter(Boolean).join(" · "),
        contentRating: contentRatingFor(novel.genres),
      })),
      metadata: list.pagination?.has_next ? { page: page + 1 } : undefined,
    };
  }

  private async resolvePastedUrl(text: string): Promise<SearchResultItem | undefined> {
    if (!/^https?:\/\/(?:www\.)?novelarchive\.cc\//i.test(text)) return undefined;
    const id =
      text.match(/[?&](?:id|novel)=([^&#]+)/i)?.[1] ?? text.match(/\/novels?\/([^/?#]+)/i)?.[1];
    if (!id) return undefined;
    try {
      const novel = await this.getNovel(decodeId(id));
      return {
        mangaId: novel.id,
        imageUrl: coverUrl(novel),
        title: novel.title,
        subtitle: novel.author || undefined,
        contentRating: contentRatingFor(novel.genres),
      };
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      return undefined;
    }
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const novel = await this.getNovel(mangaId);
    const genres = splitGenres(novel.genres);
    const rating = Number(novel.rating);

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: novel.title,
        secondaryTitles: (novel.associated_names ?? []).filter(Boolean),
        thumbnailUrl: coverUrl(novel),
        synopsis: cleanDescription(novel.description),
        ...(novel.author ? { author: novel.author } : {}),
        // The site rates out of 5; Paperback expects 0-1
        ...(rating > 0 ? { rating: Math.min(1, rating / 5) } : {}),
        status: mapStatus(novel.release_status),
        contentRating: contentRatingFor(novel.genres),
        contentType: "novel",
        tagGroups: genres.length
          ? [
              {
                id: "genres",
                title: "Genres",
                tags: genres.map((g) => ({ id: encodeId(g.toLowerCase()), title: g })),
              },
            ]
          : [],
        shareUrl: `${baseUrl}/novel?id=${encodeURIComponent(mangaId)}`,
      },
    };
  }

  // Native chapters, plus every mirror source the site offers as an
  // alternative version of each chapter.
  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const novelId = sourceManga.mangaId;
    const [novel, sources] = await Promise.all([this.getNovel(novelId), this.getSources(novelId)]);

    const chapters = this.nativeChapters(novel, sourceManga);
    const mirrorLists = await Promise.all(
      sources.map((source) => this.mirrorChapters(novelId, source, sourceManga)),
    );
    for (const list of mirrorLists) chapters.push(...list);
    return chapters;
  }

  private nativeChapters(novel: ApiNovel, sourceManga: SourceManga): Chapter[] {
    const names = novel.chapter_names ?? [];
    const total = Math.max(Number(novel.total_chapters) || 0, names.length);
    const updatedAt = novel.updated_at ? new Date(novel.updated_at) : undefined;

    const chapters: Chapter[] = [];
    for (let position = 1; position <= total; position++) {
      const { number, title } = parseChapterName(names[position - 1]);
      // Ids stay 1-based positions: that is what the chapter endpoint expects,
      // even when the printed chapter number differs
      const chapNum = number ?? position;
      chapters.push({
        chapterId: String(position),
        sourceManga,
        title: title || `Chapter ${chapNum}`,
        chapNum,
        langCode: "en",
        version: NATIVE_VERSION,
        sortingIndex: position - 1,
        // The API has no per-chapter dates; mark the newest with the update time
        ...(position === total && updatedAt && !Number.isNaN(updatedAt.getTime())
          ? { publishDate: updatedAt }
          : {}),
      });
    }
    return chapters;
  }

  private async mirrorChapters(
    novelId: string,
    source: ApiSource,
    sourceManga: SourceManga,
  ): Promise<Chapter[]> {
    let list: ApiSourceChapter[];
    try {
      const data = await this.fetchJson<{ chapters?: ApiSourceChapter[] }>(
        `${apiUrl}/novels/${encodeURIComponent(novelId)}/sources/${encodeURIComponent(source.id)}/chapters`,
      );
      list = data.chapters ?? [];
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      return [];
    }

    const version = source.label?.trim() || titleCase(source.id.replace(/[-_]+/g, " "));
    return list.map((entry, index) => {
      const parsed = typeof entry.number === "number" ? entry.number : parseFloat(entry.number);
      const chapNum = Number.isFinite(parsed) ? parsed : index + 1;
      const { title } = parseChapterName(entry.title);
      return {
        // "mirror:{source}:{number}" - getChapterDetails routes on the prefix
        chapterId: `mirror:${encodeId(source.id)}:${encodeId(String(entry.number))}`,
        sourceManga,
        title: title || `Chapter ${chapNum}`,
        chapNum,
        langCode: "en",
        version,
        sortingIndex: index,
      };
    });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const novelId = encodeURIComponent(chapter.sourceManga.mangaId);
    const mirror = chapter.chapterId.match(/^mirror:([^:]+):(.+)$/);

    let content: string;
    let isHtml: boolean;
    if (mirror) {
      const sourceId = encodeURIComponent(decodeId(mirror[1]));
      const number = encodeURIComponent(decodeId(mirror[2]));
      const data = await this.fetchJson<ApiSourceChapterDetail>(
        `${apiUrl}/novels/${novelId}/sources/${sourceId}/chapters/${number}`,
      );
      content = repairMojibake(
        data.content_html ??
          data.chapter?.content_html ??
          data.content ??
          data.chapter?.content ??
          "",
      );
      isHtml = true;
    } else {
      const data = await this.fetchJson<ApiChapter>(
        `${apiUrl}/novels/${novelId}/chapters/${encodeURIComponent(chapter.chapterId)}`,
      );
      content = data.chapter?.content ?? "";
      isHtml = looksLikeHtml(content);
    }

    if (!content.trim()) {
      throw new Error(`Novel Archive: chapter ${chapter.chapterId} has no text`);
    }

    const heading = chapter.title || `Chapter ${chapter.chapNum}`;
    const body = fixVoidElements(
      `<h2>${escapeHtml(heading)}</h2>\n${isHtml && looksLikeHtml(content) ? cleanHtml(content) : textToHtml(content)}`,
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
    this.genreCache = undefined;
  }

  // ----- Helpers -----

  private async getNovel(id: string): Promise<ApiNovel> {
    const data = await this.fetchJson<{ novel?: ApiNovel }>(
      `${apiUrl}/novels/${encodeURIComponent(id)}`,
    );
    if (!data.novel) throw new Error(`Novel Archive: novel ${id} not found`);
    return data.novel;
  }

  private async getSources(novelId: string): Promise<ApiSource[]> {
    const request = this.fetchJson<{ sources?: ApiSource[] }>(
      `${apiUrl}/novels/${encodeURIComponent(novelId)}/sources`,
    );
    try {
      const data = await Promise.race([
        request,
        Application.sleep(SOURCES_TIMEOUT_SECONDS).then(() => undefined),
      ]);
      return (data?.sources ?? []).filter((s) => s?.id);
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      return [];
    } finally {
      // Don't leave a late rejection unhandled after the race moved on
      request.catch(() => undefined);
    }
  }

  private async getGenres(): Promise<Tag[]> {
    if (this.genreCache && Date.now() - this.genreCache.fetchedAt < GENRE_CACHE_TTL_MS) {
      return this.genreCache.genres;
    }
    const data = await this.fetchJson<{ genres?: { value: string; label: string }[] }>(
      `${apiUrl}/novels/genres`,
    );
    const seen = new Set<string>();
    const genres: Tag[] = [];
    for (const genre of data.genres ?? []) {
      const value = genre.value?.trim() ?? "";
      const key = value.toLowerCase();
      if (!value || !/^[a-z0-9]/i.test(value) || NON_GENRES.has(key) || seen.has(key)) continue;
      seen.add(key);
      genres.push({ id: encodeId(value), title: genre.label?.trim() || value });
    }
    this.genreCache = { genres, fetchedAt: Date.now() };
    return genres;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const [response, data] = await Application.scheduleRequest({ url, method: "GET" });

    switch (response.status) {
      case 403:
      case 503:
        throw new CloudflareError({ url: `${baseUrl}/`, method: "GET" });
      case 404:
        throw new Error("Novel Archive: not found");
      case 429:
        throw new Error("Novel Archive: too many requests, please try again later");
    }

    const text = Application.arrayBufferToUTF8String(data);
    try {
      return JSON.parse(text) as T;
    } catch {
      // An HTML page instead of JSON means a bot check or an error page
      throw new CloudflareError({ url: `${baseUrl}/`, method: "GET" });
    }
  }
}

// ----- Utils -----

function searchMetaOf(query: SearchQuery<Metadata>): NovelArchiveSearchMetadata {
  return (
    (query.metadata as { searchMeta?: NovelArchiveSearchMetadata } | undefined)?.searchMeta ?? {}
  );
}

function genresIn(genres: GenreState | undefined, state: "included" | "excluded"): string[] {
  return Object.entries(genres ?? {})
    .filter(([, value]) => value === state)
    .map(([id]) => decodeId(id));
}

function encodeId(value: string): string {
  return value.replace(UNSAFE_ID_CHARS, (char) => {
    const encoded = encodeURIComponent(char);
    return encoded !== char ? encoded : "-";
  });
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function coverUrl(novel: ApiNovel): string {
  const path = novel.cover_url || novel.novel_image || "";
  if (!path) return "";
  return path.startsWith("http") ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

function splitGenres(genres: string | undefined): string[] {
  const seen = new Set<string>();
  return (genres ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter((g) => {
      const key = g.toLowerCase();
      if (!g || NON_GENRES.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function contentRatingFor(genres: string | undefined): ContentRating {
  const list = splitGenres(genres).map((g) => g.toLowerCase());
  if (list.some((g) => ADULT_GENRES.includes(g))) return ContentRating.ADULT;
  if (list.some((g) => MATURE_GENRES.includes(g))) return ContentRating.MATURE;
  return ContentRating.EVERYONE;
}

function mapStatus(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
      return "COMPLETED";
    case "ongoing":
      return "ONGOING";
    case "hiatus":
      return "HIATUS";
    default:
      return "UNKNOWN";
  }
}

function chapterCountLabel(novel: ApiNovel): string | undefined {
  const total = Number(novel.total_chapters) || 0;
  if (!total) return undefined;
  return total === 1 ? "1 chapter" : `${total} chapters`;
}

// "Chapter 12: The Gate" -> { 12, "The Gate" }; "Bait" -> { undefined, "Bait" };
// "Chapter 7" -> { 7, "" }
function parseChapterName(raw: string | undefined): { number?: number; title: string } {
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  const match = name.match(
    /^(?:chapter|ch\.?|episode|ep\.?)\s*(\d+(?:\.\d+)?)\s*[:.\-–—]?\s*(.*)$/i,
  );
  if (!match) return { title: name };
  const number = parseFloat(match[1]);
  const rest = match[2].trim();
  return {
    number: Number.isFinite(number) ? number : undefined,
    title: rest ? `Chapter ${match[1]}: ${rest}` : "",
  };
}

function cleanDescription(text: string | undefined): string {
  return (text ?? "")
    .replace(/\s*show more\s*$/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function looksLikeHtml(content: string): boolean {
  return /<\/?(p|br|div|span|img|em|strong|i|b|h[1-6])\b[^>]*>/i.test(content);
}

// Plain text: blank lines separate paragraphs, single newlines are line breaks
function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      p === "***" || p === "* * *" ? "<hr />" : `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`,
    )
    .join("\n");
}

function cleanHtml(html: string): string {
  const $ = cheerio.load(`<div id="na-root">${html}</div>`);
  const root = $("#na-root");
  root.find("script, style, iframe, noscript, ins, button, svg, head, title").remove();
  root.find("*").each((_, el) => {
    const node = $(el);
    for (const name of Object.keys(el.attribs ?? {})) {
      if (!KEPT_ATTRIBUTES.has(name)) node.removeAttr(name);
    }
  });
  return (root.html() ?? "").replace(/&nbsp;/g, "&#160;");
}

// Some mirror EPUB text is UTF-8 that was decoded once as Latin-1 ("â€™" for "'").
// Re-decode runs of 0x80-0xFF characters when they form valid UTF-8.
function repairMojibake(value: string): string {
  if (!/[\u0080-ÿ]/.test(value)) return value;
  let output = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f || code > 0xff) {
      output += value[index++];
      continue;
    }
    let end = index;
    while (end < value.length) {
      const byte = value.charCodeAt(end);
      if (byte <= 0x7f || byte > 0xff) break;
      end++;
    }
    const bytes = new Uint8Array(end - index);
    for (let i = 0; i < bytes.length; i++) bytes[i] = value.charCodeAt(index + i);
    const decoded: string | undefined = Application.arrayBufferToUTF8String(bytes.buffer);
    output += decoded && !decoded.includes("�") ? decoded : value.slice(index, end);
    index = end;
  }
  return output;
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

export const NovelArchive = new NovelArchiveExtension();
