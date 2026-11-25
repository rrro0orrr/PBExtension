import { Form, LabelRow, Section, SelectRow } from "@paperback/types";
import { LANGUAGE_OPTIONS, getLanguageSetting, setLanguageSetting } from "../settings";
export class MangaballSettingsForm extends Form {
    languageSetting = getLanguageSetting();
    async updateLanguage(value) {
        if (!value || value.length === 0) {
            this.languageSetting = ["all"];
        }
        else if (value.includes("all") && !this.languageSetting.includes("all")) {
            // "all" just picked → clear the specific languages
            this.languageSetting = ["all"];
        }
        else if (value.length > 1 && value.includes("all")) {
            // a specific language picked while "all" was active → drop "all"
            this.languageSetting = value.filter((v) => v !== "all");
        }
        else {
            this.languageSetting = value;
        }
        setLanguageSetting(this.languageSetting);
        this.reloadForm();
    }
    getSections() {
        const multiple = this.languageSetting.includes("all") || this.languageSetting.length !== 1;
        return [
            Section("mangaballLanguage", [
                LabelRow("languageLabel", {
                    title: "Chapter Language",
                    subtitle: "Only show chapters in the selected language(s).",
                }),
                SelectRow("languageFilter", {
                    title: multiple ? "Languages" : "Language",
                    layout: "list",
                    value: this.languageSetting,
                    items: LANGUAGE_OPTIONS.map((option) => ({
                        id: option.id,
                        title: option.label,
                    })),
                    onValueChange: Application.Selector(this, "updateLanguage"),
                    minItemCount: 1,
                    maxItemCount: LANGUAGE_OPTIONS.length,
                }),
            ]),
        ];
    }
}
