import { Form, Section, ToggleRow } from "@paperback/types";

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
