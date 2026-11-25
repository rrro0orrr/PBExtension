import { AdvancedSearchForm, NavigationRow, Section } from "@paperback/types";
import { TagFilterForm } from "./TagFilterForm";
export class Hentai2readSearchForm extends AdvancedSearchForm {
    tagForm;
    constructor(tags, initialMeta) {
        super();
        this.tagForm = new TagFilterForm(tags, {
            included: initialMeta?.tagIncluded ?? [],
            excluded: initialMeta?.tagExcluded ?? [],
        });
    }
    getSearchQueryMetadata() {
        const tags = this.tagForm.getState();
        return {
            searchMeta: {
                tagIncluded: tags.included,
                tagExcluded: tags.excluded,
            },
        };
    }
    getTagSubtitle() {
        const state = this.tagForm.getState();
        const total = state.included.length + state.excluded.length;
        return total > 0 ? `${total} selected` : "";
    }
    getSections() {
        return [
            Section("tags_section", [
                NavigationRow("tags_nav", {
                    title: "Tags",
                    subtitle: this.getTagSubtitle(),
                    form: this.tagForm,
                }),
            ]),
        ];
    }
}
