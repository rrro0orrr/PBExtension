import {
  AdvancedSearchForm,
  InputRow,
  Section,
  SelectRow,
  TriStateSelectRow,
  type JSONObject,
  type Tag,
} from "@paperback/types";

export type GenreState = Record<string, "included" | "excluded">;

export interface MgekoSearchMetadata extends JSONObject {
  status?: string;
  type?: string;
  genres?: GenreState;
  minChapters?: string;
}

const STATUS_OPTIONS: Tag[] = [
  { id: "ongoing", title: "Ongoing" },
  { id: "completed", title: "Completed" },
  { id: "hiatus", title: "Hiatus" },
];

const TYPE_OPTIONS: Tag[] = [
  { id: "manga", title: "Manga" },
  { id: "manhwa", title: "Manhwa" },
  { id: "manhua", title: "Manhua" },
  { id: "webtoon", title: "Webtoon" },
];

export class MgekoSearchForm extends AdvancedSearchForm {
  private status: string[];
  private type: string[];
  private genres: GenreState;
  private minChapters: string;

  constructor(
    private readonly genreOptions: Tag[],
    initial?: MgekoSearchMetadata,
  ) {
    super();
    this.status = initial?.status ? [initial.status] : [];
    this.type = initial?.type ? [initial.type] : [];
    this.genres = { ...initial?.genres };
    this.minChapters = initial?.minChapters ?? "";
  }

  override getSections() {
    return [
      Section("filters", [
        SelectRow("status", {
          title: "Status",
          subtitle: this.status.length ? undefined : "Any",
          layout: "list",
          value: this.status,
          items: STATUS_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as MgekoSearchForm, "onStatusChange"),
        }),
        SelectRow("type", {
          title: "Type",
          subtitle: this.type.length ? undefined : "Any",
          layout: "list",
          value: this.type,
          items: TYPE_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as MgekoSearchForm, "onTypeChange"),
        }),
        InputRow("min_chapters", {
          title: "Minimum chapters",
          value: this.minChapters,
          onValueChange: Application.Selector(this as MgekoSearchForm, "onMinChaptersChange"),
        }),
      ]),
      Section({ id: "genres", footer: "Tap once to include a genre, twice to exclude it." }, [
        TriStateSelectRow("genres", {
          title: "Genres",
          layout: "flow",
          value: this.genres,
          items: this.genreOptions,
          allowExclusion: true,
          allowEmptySelection: true,
          onValueChange: Application.Selector(this as MgekoSearchForm, "onGenresChange"),
        }),
      ]),
    ];
  }

  async onStatusChange(value: string[]): Promise<void> {
    this.status = value;
    this.reloadForm();
  }

  async onTypeChange(value: string[]): Promise<void> {
    this.type = value;
    this.reloadForm();
  }

  async onMinChaptersChange(value: string): Promise<void> {
    this.minChapters = value.replace(/\D/g, "");
  }

  async onGenresChange(value: GenreState): Promise<void> {
    this.genres = value;
    this.reloadForm();
  }

  override getSearchQueryMetadata(): { searchMeta: MgekoSearchMetadata } {
    const meta: MgekoSearchMetadata = {};
    if (this.status[0]) meta.status = this.status[0];
    if (this.type[0]) meta.type = this.type[0];
    if (Object.keys(this.genres).length) meta.genres = this.genres;
    if (this.minChapters) meta.minChapters = this.minChapters;
    return { searchMeta: meta };
  }
}
