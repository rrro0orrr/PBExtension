import {
  AdvancedSearchForm,
  Form,
  Section,
  SelectRow,
  ToggleRow,
  type JSONObject,
  type Tag,
} from "@paperback/types";

const HIDE_YAOI_KEY = "toonz.settings.hideYaoi";

/** Genres the "Hide Yaoi / BL" setting also removes from the genre lists. */
export const YAOI_GENRES = ["yaoi", "shounen-ai", "boys-love", "bl"];

/** On by default: titles the site flags as yaoi/BL are hidden until turned off. */
export function hideYaoi(): boolean {
  const value = Application.getState(HIDE_YAOI_KEY);
  return typeof value === "boolean" ? value : true;
}

export interface ToonzSearchMetadata extends JSONObject {
  genre?: string;
}

export class ToonzSettingsForm extends Form {
  private hide = hideYaoi();

  override getSections() {
    return [
      Section(
        {
          id: "content",
          footer:
            "Hides titles toonz.to marks as yaoi / boys' love from Discover, search and genre browsing, and hides the Yaoi and Shounen Ai genres.",
        },
        [
          ToggleRow("hide_yaoi", {
            title: "Hide Yaoi / BL",
            value: this.hide,
            onValueChange: Application.Selector(this as ToonzSettingsForm, "onHideYaoiChange"),
          }),
        ],
      ),
    ];
  }

  async onHideYaoiChange(value: boolean): Promise<void> {
    this.hide = value;
    Application.setState(value, HIDE_YAOI_KEY);
    this.reloadForm();
  }
}

export class ToonzSearchForm extends AdvancedSearchForm {
  private genre: string[];

  constructor(
    private readonly genreOptions: Tag[],
    initial?: ToonzSearchMetadata,
  ) {
    super();
    this.genre = initial?.genre ? [initial.genre] : [];
  }

  override getSections() {
    return [
      Section(
        {
          id: "filters",
          footer: "The site browses one genre at a time. Genre is ignored when searching by title.",
        },
        [
          SelectRow("genre", {
            title: "Genre",
            subtitle: this.genre.length ? undefined : "Any",
            layout: "list",
            value: this.genre,
            items: this.genreOptions,
            minItemCount: 0,
            maxItemCount: 1,
            onValueChange: Application.Selector(this as ToonzSearchForm, "onGenreChange"),
          }),
        ],
      ),
    ];
  }

  async onGenreChange(value: string[]): Promise<void> {
    this.genre = value;
    this.reloadForm();
  }

  override getSearchQueryMetadata(): { searchMeta: ToonzSearchMetadata } {
    return { searchMeta: this.genre[0] ? { genre: this.genre[0] } : {} };
  }
}
