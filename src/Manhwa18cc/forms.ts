import {
  AdvancedSearchForm,
  Form,
  Section,
  SelectRow,
  ToggleRow,
  type JSONObject,
  type Tag,
} from "@paperback/types";

const HIDE_RAW_KEY = "manhwa18cc.settings.hideRaw";

/**
 * On by default: the site mixes untranslated Korean "Raw" copies in with the
 * English titles (often the same series twice), so they are hidden from
 * Discover and search until turned off.
 */
export function hideRaw(): boolean {
  const value = Application.getState(HIDE_RAW_KEY);
  return typeof value === "boolean" ? value : true;
}

export class Manhwa18SettingsForm extends Form {
  private hide = hideRaw();

  override getSections() {
    return [
      Section(
        {
          id: "content",
          footer:
            "Hides untranslated Korean copies (titles ending in “Raw”) from " +
            "Discover and search. Raw titles already in your library still work.",
        },
        [
          ToggleRow("hide_raw", {
            title: "Hide raw (Korean) titles",
            value: this.hide,
            onValueChange: Application.Selector(this as Manhwa18SettingsForm, "onHideRawChange"),
          }),
        ],
      ),
    ];
  }

  async onHideRawChange(value: boolean): Promise<void> {
    this.hide = value;
    Application.setState(value, HIDE_RAW_KEY);
    this.reloadForm();
  }
}

// Genre slugs from the site's /webtoon-genre/<slug> menu.
export const GENRES: Tag[] = [
  ["action", "Action"],
  ["adult", "Adult"],
  ["adventure", "Adventure"],
  ["bl", "BL"],
  ["comedy", "Comedy"],
  ["comics", "Comics"],
  ["doujinshi", "Doujinshi"],
  ["drama", "Drama"],
  ["ecchi", "Ecchi"],
  ["family", "Family"],
  ["fantasy", "Fantasy"],
  ["gender-bender", "Gender Bender"],
  ["gl", "GL"],
  ["harem", "Harem"],
  ["hentai", "Hentai"],
  ["historical", "Historical"],
  ["horror", "Horror"],
  ["isekai", "Isekai"],
  ["josei", "Josei"],
  ["magic", "Magic"],
  ["martial-arts", "Martial Arts"],
  ["mature", "Mature"],
  ["mecha", "Mecha"],
  ["mystery", "Mystery"],
  ["ntr", "NTR"],
  ["psychological", "Psychological"],
  ["romance", "Romance"],
  ["school-life", "School Life"],
  ["sci-fi", "Sci-fi"],
  ["seinen", "Seinen"],
  ["shoujo", "Shoujo"],
  ["shounen", "Shounen"],
  ["slice-of-life", "Slice of Life"],
  ["smut", "Smut"],
  ["sports", "Sports"],
  ["supernatural", "Supernatural"],
  ["thriller", "Thriller"],
  ["tragedy", "Tragedy"],
  ["yaoi", "Yaoi"],
  ["yuri", "Yuri"],
].map(([id, title]) => ({ id: id!, title: title! }));

export interface Manhwa18SearchMetadata extends JSONObject {
  genre?: string;
}

/**
 * The site lists one genre at a time (/webtoon-genre/<slug>) and its text
 * search takes no filters, so this is a single-genre picker that applies when
 * the search bar is empty. The sort picker still applies on top of it.
 */
export class Manhwa18SearchForm extends AdvancedSearchForm {
  private genre: string[];

  constructor(initial?: Manhwa18SearchMetadata) {
    super();
    this.genre = initial?.genre ? [initial.genre] : [];
  }

  override getSections() {
    return [
      Section(
        {
          id: "filters",
          footer:
            "The site browses one genre at a time. Genre is ignored when you " +
            "also type a title, because the site's text search has no filters.",
        },
        [
          SelectRow("genre", {
            title: "Genre",
            subtitle: this.genre.length ? undefined : "Any",
            layout: "flow",
            value: this.genre,
            items: GENRES,
            minItemCount: 0,
            maxItemCount: 1,
            onValueChange: Application.Selector(this as Manhwa18SearchForm, "onGenreChange"),
          }),
        ],
      ),
    ];
  }

  async onGenreChange(value: string[]): Promise<void> {
    this.genre = value;
    this.reloadForm();
  }

  override getSearchQueryMetadata(): { searchMeta: Manhwa18SearchMetadata } {
    return { searchMeta: this.genre[0] ? { genre: this.genre[0] } : {} };
  }
}
