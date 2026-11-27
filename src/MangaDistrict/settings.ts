import { Section, SelectRow, ToggleRow, type Tag } from "@paperback/types";

import { MadaraSettingsForm } from "../utils/madara/settings";

const CLEAN_TITLES_KEY = "mangadistrict.settings.cleanTitles";
const CHAPTER_VERSIONS_KEY = "mangadistrict.settings.chapterVersions";

/**
 * Which copy to keep when Manga District lists a chapter more than once
 * (e.g. a plain copy plus "[V2] FULL QUALITY" and "V1 - High Quality" copies).
 */
export type ChapterVersionPreference = "all" | "high" | "full";

const CHAPTER_VERSION_OPTIONS: Tag[] = [
  { id: "all", title: "Show all versions" },
  { id: "high", title: "Prefer high quality (less data)" },
  { id: "full", title: "Prefer full quality (V2)" },
];

/** Off by default, so titles match the site (and MadaraDex) exactly. */
export function cleanTitles(): boolean {
  return Application.getState(CLEAN_TITLES_KEY) === true;
}

export function chapterVersionPreference(): ChapterVersionPreference {
  const value = Application.getState(CHAPTER_VERSIONS_KEY);
  return value === "high" || value === "full" ? value : "all";
}

/** The shared Madara base-URL setting plus Manga District's own options. */
export class MangaDistrictSettingsForm extends MadaraSettingsForm {
  private clean = cleanTitles();
  private versions: ChapterVersionPreference = chapterVersionPreference();

  override getSections() {
    return [
      ...super.getSections(),
      Section(
        {
          id: "titles",
          footer:
            "Removes version tags such as “(Official)”, “(Uncensored)” or " +
            "“[MANGA DISTRICT EDITION]” from titles, which helps match entries " +
            "when migrating. Library entries keep their old title until refreshed.",
        },
        [
          ToggleRow("clean_titles", {
            title: "Remove version tags from titles",
            value: this.clean,
            onValueChange: Application.Selector(
              this as MangaDistrictSettingsForm,
              "onCleanTitlesChange",
            ),
          }),
        ],
      ),
      Section(
        {
          id: "chapter_versions",
          footer:
            "Some series list each chapter more than once in different image " +
            "qualities. Pick one to hide the other copies; chapters that only " +
            "exist in one version are always shown. Refresh a title to apply.",
        },
        [
          SelectRow("chapter_versions", {
            title: "Chapter versions",
            layout: "list",
            value: [this.versions],
            items: CHAPTER_VERSION_OPTIONS,
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as MangaDistrictSettingsForm,
              "onChapterVersionsChange",
            ),
          }),
        ],
      ),
    ];
  }

  async onCleanTitlesChange(value: boolean): Promise<void> {
    this.clean = value;
    Application.setState(value, CLEAN_TITLES_KEY);
    this.reloadForm();
  }

  async onChapterVersionsChange(value: string[]): Promise<void> {
    const choice = value[0];
    this.versions = choice === "high" || choice === "full" ? choice : "all";
    Application.setState(this.versions, CHAPTER_VERSIONS_KEY);
    this.reloadForm();
  }
}
