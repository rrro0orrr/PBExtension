import {
  Chapter,
  ContentRating,
  DiscoverSection,
  DiscoverSectionItem,
  Form,
  Metadata,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  SourceManga,
  type Tag,
} from "@paperback/types";
import { Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";

import { MadaraExtension } from "../utils/madara/template";
import {
  chapterVersionPreference,
  cleanTitles,
  MangaDistrictSettingsForm,
  type ChapterVersionPreference,
} from "./settings";

// Bracketed version tags at the start or end of a title, e.g.
// "[MANGA DISTRICT EDITION] Man of Vengeance (UNCENSORED)" or
// "Moby Dick (Official)". Mirrors keiyoushi's MangaDistrict title cleaner.
const TAG = String.raw`(?:\([^()]*\)|\[[^\]]*\]|\{[^{}]*\}|«[^»]*»|「[^」]*」|『[^』]*』|《[^》]*》|〘[^〙]*〙|〖[^〗]*〗|⟨[^⟩]*⟩)`;
const LEADING_TAGS = new RegExp(String.raw`^(?:\s*${TAG}\s*)+`);
const TRAILING_TAGS = new RegExp(String.raw`(?:\s*(?:${TAG}|/\s*Official)\s*)+$`, "i");

/** Strip version tags from a title; keeps the original if nothing would remain. */
export function cleanTitle(title: string): string {
  const cleaned = title.replace(LEADING_TAGS, "").replace(TRAILING_TAGS, "").trim();
  return cleaned || title.trim();
}

/**
 * Quality variant a chapter belongs to, read from its id. Variant copies live
 * under an extra path segment, e.g. `v2-full-quality/chapter-6_1` or
 * `v1-high-quality-optimized-for-moderate-data-usage/chapter-3`; the default
 * copy is just `chapter-6`.
 */
export function chapterVariant(chapterId: string): string | undefined {
  const id = decodeURIComponentSafe(chapterId);
  if (id.startsWith("/")) return undefined;
  const slash = id.lastIndexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

function variantLabel(variant: string): string {
  if (/^v2[-_]/i.test(variant)) return "V2 Full Quality";
  if (/^v1[-_]/i.test(variant)) return "V1 High Quality";
  return variant
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Lower is preferred. The default (no-variant) copy sits between V1 and V2. */
function variantRank(variant: string | undefined, preference: ChapterVersionPreference): number {
  const kind = !variant
    ? "plain"
    : /^v2[-_]/i.test(variant)
      ? "full"
      : /^v1[-_]/i.test(variant)
        ? "high"
        : "plain";
  const order = preference === "full" ? ["full", "plain", "high"] : ["high", "plain", "full"];
  return order.indexOf(kind);
}

/**
 * Label variant copies in their titles and, unless the user wants every
 * version, keep only the preferred copy of chapters listed more than once.
 */
export function applyChapterVersions(
  chapters: Chapter[],
  preference: ChapterVersionPreference,
): Chapter[] {
  const labelled = chapters.map((chapter) => {
    const variant = chapterVariant(chapter.chapterId);
    if (!variant) return chapter;
    const label = variantLabel(variant);
    const title = chapter.title ? `${chapter.title} · ${label}` : label;
    return { ...chapter, title };
  });
  if (preference === "all") return labelled;

  // Best rank among the copies of each chapter number.
  const best = new Map<number, number>();
  for (const chapter of labelled) {
    if (!(chapter.chapNum > 0)) continue;
    const rank = variantRank(chapterVariant(chapter.chapterId), preference);
    best.set(chapter.chapNum, Math.min(rank, best.get(chapter.chapNum) ?? Infinity));
  }
  return labelled.filter((chapter) => {
    if (!(chapter.chapNum > 0)) return true;
    return variantRank(chapterVariant(chapter.chapterId), preference) === best.get(chapter.chapNum);
  });
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Manga District (mangadistrict.com) runs a stock Madara theme with chapters
 * rendered inline on the series page. Overrides mirror keiyoushi's
 * MangaDistrict source: series live under `/series/`, pagination is
 * WP-PageNavi, chapter readers carry a decoy `#image-99999` banner plus
 * `<noscript>` copies of lazy images, and some covers use WP Fastest Cache's
 * `data-wpfc-original-src`.
 */
// Advanced-search `genre[]` options, copied from mangadistrict.com's search form.
const GENRES: Tag[] = [
  { id: "3d", title: "3D" },
  { id: "3d-anime", title: "3D Anime" },
  { id: "action", title: "Action" },
  { id: "adapted-to-anime", title: "Adapted to Anime" },
  { id: "adventure", title: "Adventure" },
  { id: "ai-art", title: "AI Art" },
  { id: "aliens", title: "Aliens" },
  { id: "animal-characteristics", title: "Animal Characteristics" },
  { id: "animation", title: "Animation" },
  { id: "based-on-another-work", title: "Based on Another Work" },
  { id: "bl", title: "BL" },
  { id: "bl-uncensored", title: "BL Uncensored" },
  { id: "borderline-h", title: "Borderline H" },
  { id: "cohabitation", title: "Cohabitation" },
  { id: "collection-of-stories", title: "Collection of Stories" },
  { id: "comedy", title: "Comedy" },
  { id: "comics", title: "Comics" },
  { id: "cooking", title: "Cooking" },
  { id: "coworkers", title: "Coworkers" },
  { id: "crime", title: "Crime" },
  { id: "crossdressing", title: "Crossdressing" },
  { id: "delinquents", title: "Delinquents" },
  { id: "demons", title: "Demons" },
  { id: "detectives", title: "Detectives" },
  { id: "doujinshi", title: "Doujinshi" },
  { id: "drama", title: "Drama" },
  { id: "ecchi", title: "Ecchi" },
  { id: "explicit-sex", title: "Explicit Sex" },
  { id: "fantasy", title: "Fantasy" },
  { id: "fetish", title: "Fetish" },
  { id: "full-color", title: "Full Color" },
  { id: "gender-bender", title: "Gender Bender" },
  { id: "ghosts", title: "Ghosts" },
  { id: "gl", title: "GL" },
  { id: "gyaru", title: "Gyaru" },
  { id: "harem", title: "Harem" },
  { id: "hentai-anime", title: "Hentai Anime" },
  { id: "historical", title: "Historical" },
  { id: "horror", title: "Horror" },
  { id: "incest", title: "Incest" },
  { id: "isekai", title: "Isekai" },
  { id: "japanese-webtoons", title: "Japanese Webtoons" },
  { id: "josei", title: "Josei" },
  { id: "light-novels", title: "Light Novels" },
  { id: "mafia", title: "Mafia" },
  { id: "magic", title: "Magic" },
  { id: "magical-girl", title: "Magical Girl" },
  { id: "manhua", title: "Manhua" },
  { id: "manhwa", title: "Manhwa" },
  { id: "martial-arts", title: "Martial Arts" },
  { id: "mature-romance", title: "Mature Romance" },
  { id: "mecha", title: "Mecha" },
  { id: "medical", title: "Medical" },
  { id: "military", title: "Military" },
  { id: "monster-girls", title: "Monster Girls" },
  { id: "monsters", title: "Monsters" },
  { id: "motion", title: "Motion" },
  { id: "music", title: "Music" },
  { id: "mystery", title: "Mystery" },
  { id: "ninja", title: "Ninja" },
  { id: "nudity", title: "Nudity" },
  { id: "oel", title: "OEL" },
  { id: "one-shot", title: "One Shot" },
  { id: "parody-anime", title: "Parody Anime" },
  { id: "person-in-a-strange-world", title: "Person in a Strange World" },
  { id: "police", title: "Police" },
  { id: "psychological", title: "Psychological" },
  { id: "reincarnation", title: "Reincarnation" },
  { id: "reverse-harem", title: "Reverse Harem" },
  { id: "romance", title: "Romance" },
  { id: "salaryman", title: "Salaryman" },
  { id: "samurai", title: "Samurai" },
  { id: "school-life", title: "School Life" },
  { id: "sci-fi", title: "Sci Fi" },
  { id: "seinen", title: "Seinen" },
  { id: "sexual-abuse", title: "Sexual Abuse" },
  { id: "sexual-content", title: "Sexual Content" },
  { id: "shoujo", title: "Shoujo" },
  { id: "shoujo-ai", title: "Shoujo-ai" },
  { id: "shounen", title: "Shounen" },
  { id: "shounen-ai", title: "Shounen-ai" },
  { id: "siblings", title: "Siblings" },
  { id: "slice-of-life", title: "Slice of Life" },
  { id: "smut", title: "Smut" },
  { id: "sports", title: "Sports" },
  { id: "summoned-into-another-world", title: "Summoned Into Another World" },
  { id: "superheroes", title: "Superheroes" },
  { id: "supernatural", title: "Supernatural" },
  { id: "survival", title: "Survival" },
  { id: "thriller", title: "Thriller" },
  { id: "time-travel", title: "Time Travel" },
  { id: "transfer-students", title: "Transfer Students" },
  { id: "uncensored", title: "Uncensored" },
  { id: "uncensored-anime", title: "Uncensored Anime" },
  { id: "vampires", title: "Vampires" },
  { id: "violence", title: "Violence" },
  { id: "virtual-reality", title: "Virtual Reality" },
  { id: "web-novels", title: "Web Novels" },
  { id: "webtoons", title: "Webtoons" },
  { id: "western", title: "Western" },
  { id: "work-life", title: "Work Life" },
  { id: "yaoi", title: "Yaoi" },
  { id: "yuri", title: "Yuri" },
  { id: "zombies", title: "Zombies" },
];

export class MangaDistrictExtension extends MadaraExtension {
  constructor() {
    super({
      name: "MangaDistrict",
      baseUrl: "https://mangadistrict.com",
      mangaSubString: "series",
      useNewChapterEndpoint: false,
      contentRating: ContentRating.MATURE,
      langCode: "🇬🇧",
      // `a.last` alone misses short result sets (search with two pages has no
      // "last" link), so also accept the link right after the current page.
      nextPageSelector: ".wp-pagenavi span.current + a, .wp-pagenavi a.last",
      pageListSelector: "div.page-break img:not(noscript img):not(#image-99999)",
      searchGenres: GENRES,
    });
  }

  override async getSettingsForm(): Promise<Form> {
    return new MangaDistrictSettingsForm(this.sourceName, this.defaultBaseUrl);
  }

  override async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const result = await super.getDiscoverSectionItems(section, metadata);
    if (!cleanTitles()) return result;
    return {
      ...result,
      items: result.items.map((item) =>
        "title" in item && typeof item.title === "string"
          ? { ...item, title: cleanTitle(item.title) }
          : item,
      ),
    };
  }

  override async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const result = await super.getSearchResults(query, metadata, sortingOption);
    if (!cleanTitles()) return result;
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, title: cleanTitle(item.title) })),
    };
  }

  override async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const manga = await super.getMangaDetails(mangaId);
    if (!cleanTitles()) return manga;
    const original = manga.mangaInfo.primaryTitle;
    const cleaned = cleanTitle(original);
    if (cleaned === original) return manga;
    return {
      ...manga,
      mangaInfo: {
        ...manga.mangaInfo,
        primaryTitle: cleaned,
        // Keep the full title searchable as an alternative name.
        secondaryTitles: [original, ...manga.mangaInfo.secondaryTitles],
      },
    };
  }

  override async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    return applyChapterVersions(await super.getChapters(sourceManga), chapterVersionPreference());
  }

  protected override imageFromElement(img: Cheerio<AnyNode>): string {
    const cached = img?.attr("data-wpfc-original-src")?.trim();
    if (cached) return this.absoluteUrl(cached);
    return super.imageFromElement(img);
  }
}

export const MangaDistrict = new MangaDistrictExtension();
