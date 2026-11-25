import { FlowSection, Form, InputRow, LabelRow, Section } from "@paperback/types";
const STATE_PREFIX = {
    none: "",
    included: "✓ ",
    excluded: "X ",
};
export class TagFilterForm extends Form {
    tagStateMap;
    searchQuery;
    tags;
    sectionId;
    constructor(tags, sectionId, initialState = { included: [], excluded: [] }) {
        super();
        this.tags = tags;
        this.sectionId = sectionId;
        this.searchQuery = "";
        this.tagStateMap = new Map();
        for (const tag of tags) {
            if (initialState.included.includes(tag.id)) {
                this.tagStateMap.set(tag.id, "included");
            }
            else if (initialState.excluded.includes(tag.id)) {
                this.tagStateMap.set(tag.id, "excluded");
            }
            else {
                this.tagStateMap.set(tag.id, "none");
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this["onSearchChange"] = async (value) => {
            this.searchQuery = value;
            this.reloadForm();
        };
        for (const tag of tags) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this[`toggle_${tag.id}`] = async () => {
                const current = this.tagStateMap.get(tag.id) ?? "none";
                const next = current === "none" ? "included" : current === "included" ? "excluded" : "none";
                this.tagStateMap.set(tag.id, next);
                this.reloadForm();
            };
        }
    }
    getState() {
        const included = [];
        const excluded = [];
        for (const [id, state] of this.tagStateMap) {
            if (state === "included")
                included.push(id);
            else if (state === "excluded")
                excluded.push(id);
        }
        return { included, excluded };
    }
    getSections() {
        const query = this.searchQuery.toLowerCase().trim();
        return [
            Section("search", [
                InputRow("search_input", {
                    title: "Search",
                    value: this.searchQuery,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onValueChange: Application.Selector(this, "onSearchChange"),
                }),
            ]),
            FlowSection({
                id: this.sectionId,
                footer: "Tap once to include · Tap again to exclude · Tap once more to reset",
            }, this.tags.map((tag) => {
                const state = this.tagStateMap.get(tag.id) ?? "none";
                const hidden = query.length > 0 && !tag.name.toLowerCase().includes(query);
                return LabelRow(`tag_${tag.id}`, {
                    title: `${STATE_PREFIX[state]}${tag.name}`,
                    isHidden: hidden,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onSelect: Application.Selector(this, `toggle_${tag.id}`),
                });
            })),
        ];
    }
}
