import { AdvancedSearchForm, InputRow, Section, SelectRow } from "@paperback/types";

import {
  type NovelFireSearchMeta,
  CHAPTER_COUNTS,
  GENRE_MATCHES,
  GENRES,
  LANGUAGES,
  RATING_MATCHES,
  RATINGS,
  STATUSES,
  TAG_MATCHES,
} from "../model";

export const DEFAULT_SEARCH_META: NovelFireSearchMeta = {
  languages: [],
  genres: [],
  genreMatch: "and",
  chapters: "0",
  ratingMatch: "min",
  rating: "0",
  status: "-1",
  tags: "",
  tagMatch: "and",
  excludedTags: "",
};

type ListKey = "languages" | "genres";
type SingleKey = "genreMatch" | "chapters" | "ratingMatch" | "rating" | "status" | "tagMatch";
type TextKey = "tags" | "excludedTags";

export class NovelFireSearchForm extends AdvancedSearchForm {
  private meta: NovelFireSearchMeta;

  constructor(initialMeta?: Partial<NovelFireSearchMeta>) {
    super();
    this.meta = { ...DEFAULT_SEARCH_META, ...initialMeta };
  }

  async updateLanguages(value: string[]): Promise<void> {
    this.setList("languages", value);
  }

  async updateGenres(value: string[]): Promise<void> {
    this.setList("genres", value);
  }

  async updateGenreMatch(value: string[]): Promise<void> {
    this.setSingle("genreMatch", value);
  }

  async updateChapters(value: string[]): Promise<void> {
    this.setSingle("chapters", value);
  }

  async updateRatingMatch(value: string[]): Promise<void> {
    this.setSingle("ratingMatch", value);
  }

  async updateRating(value: string[]): Promise<void> {
    this.setSingle("rating", value);
  }

  async updateStatus(value: string[]): Promise<void> {
    this.setSingle("status", value);
  }

  async updateTagMatch(value: string[]): Promise<void> {
    this.setSingle("tagMatch", value);
  }

  async updateTags(value: string): Promise<void> {
    this.setText("tags", value);
  }

  async updateExcludedTags(value: string): Promise<void> {
    this.setText("excludedTags", value);
  }

  getSearchQueryMetadata() {
    return { searchMeta: { ...this.meta } satisfies NovelFireSearchMeta };
  }

  override getSections() {
    return [
      Section("filters", [
        SelectRow("languages", {
          title: "Origin / Raw Language",
          value: this.meta.languages,
          options: LANGUAGES.map((l) => ({ id: l.id, title: l.label })),
          minItemCount: 0,
          maxItemCount: LANGUAGES.length,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateLanguages"),
        }),
        SelectRow("genres", {
          title: "Genres",
          value: this.meta.genres,
          options: GENRES.map((g) => ({ id: g.id, title: g.label })),
          minItemCount: 0,
          maxItemCount: GENRES.length,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateGenres"),
        }),
        SelectRow("genreMatch", {
          title: "Genre Match",
          value: [this.meta.genreMatch],
          options: GENRE_MATCHES.map((m) => ({ id: m.id, title: m.label })),
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateGenreMatch"),
        }),
        SelectRow("chapters", {
          title: "Chapters",
          value: [this.meta.chapters],
          options: CHAPTER_COUNTS.map((c) => ({ id: c.id, title: c.label })),
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateChapters"),
        }),
        SelectRow("ratingMatch", {
          title: "Rating Condition",
          value: [this.meta.ratingMatch],
          options: RATING_MATCHES.map((r) => ({ id: r.id, title: r.label })),
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateRatingMatch"),
        }),
        SelectRow("rating", {
          title: "Rating",
          value: [this.meta.rating],
          options: RATINGS.map((r) => ({ id: r.id, title: r.label })),
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateRating"),
        }),
        SelectRow("status", {
          title: "Status",
          value: [this.meta.status],
          options: STATUSES.map((s) => ({ id: s.id, title: s.label })),
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateStatus"),
        }),
      ]),
      Section("tags", [
        InputRow("tags", {
          title: "Tags (comma separated)",
          value: this.meta.tags,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateTags"),
        }),
        SelectRow("tagMatch", {
          title: "Tag Match",
          value: [this.meta.tagMatch],
          options: TAG_MATCHES.map((t) => ({ id: t.id, title: t.label })),
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateTagMatch"),
        }),
        InputRow("excludedTags", {
          title: "Excluded Tags (comma separated)",
          value: this.meta.excludedTags,
          onValueChange: Application.Selector(this as NovelFireSearchForm, "updateExcludedTags"),
        }),
      ]),
    ];
  }

  private setList(key: ListKey, value: string[]): void {
    this.meta = { ...this.meta, [key]: value };
    this.reloadForm();
  }

  private setSingle(key: SingleKey, value: string[]): void {
    this.meta = { ...this.meta, [key]: value[0] ?? DEFAULT_SEARCH_META[key] };
    this.reloadForm();
  }

  private setText(key: TextKey, value: string): void {
    // No reload here so the keyboard stays open while typing
    this.meta = { ...this.meta, [key]: value };
  }
}
